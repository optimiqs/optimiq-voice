package dialog

import (
	"errors"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
)

func confirmed(t *testing.T) *Dialog {
	t.Helper()
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\nm=audio 40000 RTP/AVP 0\r\n")})
	apply(t, d, Input{Trigger: TriggerRemoteAck})
	return d
}

// The three RFC-mandated refusals, each meaning something different to the phone that sent the
// offer.
func TestApplyMidDialogRefusals(t *testing.T) {
	t.Run("a re-INVITE before the initial INVITE is answered is 500 with a Retry-After", func(t *testing.T) {
		d := newTestDialog(t, RoleUAS)
		apply(t, d, Input{Trigger: TriggerLocalRing})

		outcome, err := d.ApplyMidDialog(MidDialogInput{Kind: KindReInvite})
		if !errors.Is(err, ErrInvalidState) {
			t.Fatalf("err = %v, want ErrInvalidState", err)
		}
		if outcome.Status != 500 || outcome.RetryAfter <= 0 {
			t.Errorf("outcome = %d after %s, want 500 with a Retry-After", outcome.Status, outcome.RetryAfter)
		}
	})

	t.Run("an UPDATE on an early dialog is accepted: RFC 3311 exists for exactly this", func(t *testing.T) {
		d := newTestDialog(t, RoleUAS)
		apply(t, d, Input{Trigger: TriggerLocalRing})

		outcome, err := d.ApplyMidDialog(MidDialogInput{
			Kind: KindUpdate,
			Body: []byte("v=0\r\nm=audio 40000 RTP/AVP 0\r\na=sendonly\r\n"),
		})
		if err != nil || !outcome.Accepted {
			t.Fatalf("outcome = %+v / %v, want accepted", outcome, err)
		}
		if !outcome.HoldChanged || !outcome.Held {
			t.Error("hold while ringing must be reported")
		}
	})

	t.Run("an offer colliding with one of ours is 491 Request Pending", func(t *testing.T) {
		d := confirmed(t)
		if err := d.BeginReOffer(); err != nil {
			t.Fatalf("BeginReOffer: %v", err)
		}
		outcome, err := d.ApplyMidDialog(MidDialogInput{Kind: KindReInvite})
		if err != nil {
			t.Fatalf("err = %v, want a plain 491", err)
		}
		if outcome.Accepted || outcome.Status != 491 {
			t.Errorf("outcome = %+v, want a 491 refusal", outcome)
		}
	})

	t.Run("a mid-dialog offer on a dialog that has ended is 481", func(t *testing.T) {
		d := confirmed(t)
		apply(t, d, Input{Trigger: TriggerRemoteBye})

		outcome, err := d.ApplyMidDialog(MidDialogInput{Kind: KindReInvite})
		if !errors.Is(err, ErrDialogGone) || outcome.Status != 481 {
			t.Errorf("outcome = %+v / %v, want 481 and ErrDialogGone", outcome, err)
		}
	})
}

// Only a CHANGE across the hold boundary is worth an event. Publishing `held` for a codec change or
// a NAT re-latch would start music-on-hold over a live conversation.
func TestHoldAndResumePublishOnlyOnChange(t *testing.T) {
	d := confirmed(t)

	held, err := d.ApplyMidDialog(MidDialogInput{
		Kind: KindReInvite,
		Body: []byte("v=0\r\nm=audio 40000 RTP/AVP 0\r\na=sendonly\r\n"),
	})
	if err != nil {
		t.Fatalf("ApplyMidDialog: %v", err)
	}
	if !held.HoldChanged || !held.Held || held.Effects[0].Event != EventHeld {
		t.Fatalf("outcome = %+v, want a held event", held)
	}
	if !d.Held() {
		t.Error("the dialog must report itself held")
	}

	// sendonly to inactive is still hold, and is not a change.
	again, _ := d.ApplyMidDialog(MidDialogInput{
		Kind: KindReInvite,
		Body: []byte("v=0\r\nm=audio 40000 RTP/AVP 0\r\na=inactive\r\n"),
	})
	if again.HoldChanged {
		t.Error("staying held must not publish a second event")
	}
	for _, effect := range again.Effects {
		if effect.Kind == EffectPublish {
			t.Errorf("unexpected publish %q while staying held", effect.Event)
		}
	}

	resumed, _ := d.ApplyMidDialog(MidDialogInput{
		Kind: KindReInvite,
		Body: []byte("v=0\r\nm=audio 40000 RTP/AVP 0\r\na=sendrecv\r\n"),
	})
	if !resumed.HoldChanged || resumed.Held || resumed.Effects[0].Event != EventResumed {
		t.Fatalf("outcome = %+v, want a resumed event", resumed)
	}
	if d.Held() {
		t.Error("the dialog must no longer report itself held")
	}
}

// RFC 3261 §12.2.1.1: a mid-dialog request with a Contact refreshes the remote target, and the
// observed source refreshes with it. A dialog that did not refresh sends its BYE to where the far
// end used to be.
func TestMidDialogRefreshesTheTarget(t *testing.T) {
	d := confirmed(t)
	moved := sip.Uri{Scheme: "sip", User: "1001", Host: "198.51.100.9", Port: 5062}

	if _, err := d.ApplyMidDialog(MidDialogInput{
		Kind:     KindReInvite,
		Contact:  &moved,
		Observed: "198.51.100.9:41234",
	}); err != nil {
		t.Fatalf("ApplyMidDialog: %v", err)
	}
	if d.Target.Contact.Host != "198.51.100.9" || d.Target.Contact.Port != 5062 {
		t.Errorf("contact = %+v, want the refreshed target", d.Target.Contact)
	}
	if d.Target.Observed != "198.51.100.9:41234" {
		t.Errorf("observed = %q, want the new source", d.Target.Observed)
	}
}

// A refresh re-arms the session timer even when nothing else changed — that is what a refresh IS.
func TestMidDialogRefreshReArmsTheSessionTimer(t *testing.T) {
	d := confirmed(t)
	d.SetTimer(SessionTimer{Interval: 600 * time.Second, Refresher: RefresherLocal})

	outcome, err := d.ApplyMidDialog(MidDialogInput{Kind: KindReInvite})
	if err != nil {
		t.Fatalf("ApplyMidDialog: %v", err)
	}
	armed := false
	for _, effect := range outcome.Effects {
		if effect.Kind == EffectStartSessionTimer {
			armed = true
		}
	}
	if !armed {
		t.Error("a refresh must re-arm the session timer")
	}
	if changed := d.RefreshTimer(SessionTimer{Interval: 900 * time.Second, Refresher: RefresherLocal}); !changed {
		t.Error("a changed interval must be reported as a change")
	}
	if changed := d.RefreshTimer(SessionTimer{Interval: 900 * time.Second, Refresher: RefresherLocal}); changed {
		t.Error("an unchanged interval must not be reported as a change")
	}
}

// Two of our own offers in flight is not glare; it is this process having lost track, and it is
// refused so an answer nobody can match to an offer never happens.
func TestBeginReOfferRefusesASecondOutstandingOffer(t *testing.T) {
	d := confirmed(t)
	if err := d.BeginReOffer(); err != nil {
		t.Fatalf("BeginReOffer: %v", err)
	}
	if err := d.BeginReOffer(); !errors.Is(err, ErrInvalidState) {
		t.Errorf("a second BeginReOffer = %v, want ErrInvalidState", err)
	}
	if !d.ReOfferOutstanding() {
		t.Error("the offer must still be outstanding")
	}

	d.CompleteReOffer([]byte("v=0\r\n"))
	if d.ReOfferOutstanding() {
		t.Error("a completed offer is no longer outstanding")
	}

	// And a failed offer clears the flag too: without it, one failed re-INVITE would make every
	// subsequent offer from the far end look like glare for the life of the call.
	if err := d.BeginReOffer(); err != nil {
		t.Fatalf("BeginReOffer after completion: %v", err)
	}
	d.AbandonReOffer()
	if d.ReOfferOutstanding() {
		t.Error("an abandoned offer is no longer outstanding")
	}
}

func TestBeginReOfferRefusesAnUnansweredDialog(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalRing})
	if err := d.BeginReOffer(); !errors.Is(err, ErrInvalidState) {
		t.Errorf("err = %v, want ErrInvalidState: there is nothing to re-offer yet", err)
	}
}

// The glare retry range is chosen by comparing Call-IDs, which is the only tie-break both ends can
// compute identically without another round trip.
func TestGlareRetryAfterUsesTheCallIDComparison(t *testing.T) {
	d := confirmed(t) // its Call-ID is "a84b4c76e66710@pc33"

	lower := d.GlareRetryAfter("zzzzzz", 0.5)
	higher := d.GlareRetryAfter("000000", 0.5)
	if lower >= 2100*time.Millisecond {
		t.Errorf("against a higher remote Call-ID we take the short range, got %s", lower)
	}
	if higher < 2100*time.Millisecond {
		t.Errorf("against a lower remote Call-ID we take the long range, got %s", higher)
	}
}

// The answer to a mid-dialog offer is committed before it goes out, so anything that must repeat it
// repeats it byte for byte.
func TestAnswerMidDialogCommitsAndResponds(t *testing.T) {
	d := confirmed(t)
	body := []byte("v=0\r\nm=audio 40002 RTP/AVP 0\r\n")

	effects := d.AnswerMidDialog(body)
	if len(effects) != 1 || effects[0].Kind != EffectRespondToRequest || effects[0].Status != 200 {
		t.Fatalf("effects = %+v, want a single 200", effects)
	}
	if string(effects[0].Body) != string(body) {
		t.Error("the answer must go out verbatim")
	}
}

func TestLocalDirectionIsRemembered(t *testing.T) {
	d := confirmed(t)
	if d.LocalDirection() != DirectionSendRecv {
		t.Errorf("a fresh dialog's local direction = %q, want sendrecv", d.LocalDirection())
	}
	d.NoteLocalDirection(DirectionSendOnly)
	if d.LocalDirection() != DirectionSendOnly {
		t.Errorf("local direction = %q, want sendonly", d.LocalDirection())
	}
}

func TestMidDialogKindRenders(t *testing.T) {
	if KindReInvite.String() != "re-INVITE" || KindUpdate.String() != "UPDATE" {
		t.Error("both mid-dialog kinds must render as the method they are")
	}
}
