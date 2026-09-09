package dialog

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

var testClock = time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC)

func newTestDialog(t *testing.T, role Role) *Dialog {
	t.Helper()
	created, err := New(Options{
		LegID: "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50",
		OrgID: "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
		Role:  role,
		Identity: Identity{
			SIPCallID: "a84b4c76e66710@pc33",
			LocalTag:  "local-tag",
			RemoteTag: "remote-tag",
		},
		Now: func() time.Time { return testClock },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return created
}

func apply(t *testing.T, d *Dialog, in Input) Outcome {
	t.Helper()
	outcome, err := d.Apply(in)
	if err != nil {
		t.Fatalf("Apply(%s): %v", in.Trigger, err)
	}
	return outcome
}

func kindsOf(outcome Outcome) []EffectKind {
	kinds := make([]EffectKind, 0, len(outcome.Effects))
	for _, effect := range outcome.Effects {
		kinds = append(kinds, effect.Kind)
	}
	return kinds
}

func assertKinds(t *testing.T, outcome Outcome, want ...EffectKind) {
	t.Helper()
	got := kindsOf(outcome)
	if len(got) != len(want) {
		t.Fatalf("effects = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("effects = %v, want %v", got, want)
		}
	}
}

// `answered` is published on the ACK for a UAS leg, not on the 200; `billsec` counts from it.
func TestUASAnswerPublishesOnTheAckAndNotTheTwoHundred(t *testing.T) {
	d := newTestDialog(t, RoleUAS)

	apply(t, d, Input{Trigger: TriggerLocalTrying})
	apply(t, d, Input{Trigger: TriggerLocalRing})

	answer := apply(t, d, Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})
	assertKinds(t, answer, EffectRespond)
	if !d.AnsweredAt().IsZero() {
		t.Error("the answer instant must not be set before the ACK")
	}

	ack := apply(t, d, Input{Trigger: TriggerRemoteAck, At: testClock.Add(time.Second)})
	assertKinds(t, ack, EffectPublish)
	if ack.Effects[0].Event != EventAnswered {
		t.Errorf("published %q, want %q", ack.Effects[0].Event, EventAnswered)
	}
	if !d.AnsweredAt().Equal(testClock.Add(time.Second)) {
		t.Errorf("answeredAt = %s, want the ACK's instant", d.AnsweredAt())
	}
	if d.State() != StateConfirmed {
		t.Errorf("state = %s, want confirmed", d.State())
	}
}

// RFC 3261 §9.2: a CANCEL that arrives after the final response has no effect. The dialog survives,
// the CANCEL's own transaction is answered 481, and the correct teardown is a BYE.
func TestCancelAfterTwoHundredIsAnsweredFourEightyOneAndTheCallSurvives(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})

	outcome, err := d.Apply(Input{Trigger: TriggerRemoteCancel})
	if !errors.Is(err, ErrCancelTooLate) {
		t.Fatalf("err = %v, want ErrCancelTooLate", err)
	}
	assertKinds(t, outcome, EffectRespondToCancel)
	if outcome.Effects[0].Status != 481 {
		t.Errorf("status = %d, want 481", outcome.Effects[0].Status)
	}
	if d.State() != StateEstablished {
		t.Errorf("state = %s, want the dialog to survive the losing CANCEL", d.State())
	}
}

// The other side of the same race: an `answer` after a CANCEL is refused `dialog_gone`.
func TestAnswerAfterCancelIsDialogGone(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalRing})
	apply(t, d, Input{Trigger: TriggerRemoteCancel})

	_, err := d.Apply(Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})
	if !errors.Is(err, ErrDialogGone) {
		t.Fatalf("err = %v, want ErrDialogGone", err)
	}
}

// RFC 5407 §3.1.2: a BYE may arrive before the ACK. It is honoured, the 2xx retransmission stops
// because the far end has plainly received it, and the dialog terminates exactly once.
func TestByeBeforeAckIsHonouredAndStopsTheRetransmission(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})

	outcome := apply(t, d, Input{Trigger: TriggerRemoteBye})
	assertKinds(t, outcome, EffectRespondToRequest, EffectStopRetransmit, EffectPublish, EffectReleaseClaim)
	if outcome.Effects[0].Status != 200 {
		t.Errorf("the BYE must be answered 200, got %d", outcome.Effects[0].Status)
	}
	if d.State() != StateTerminated {
		t.Errorf("state = %s, want terminated", d.State())
	}
	if d.Termination() != ReasonBye || d.Cause() != CauseNormalClearing {
		t.Errorf("termination = %s/%d, want bye/16", d.Termination(), d.Cause())
	}
}

// RFC 3261 §15: a UAS MUST NOT send a BYE before the ACK for its own 2xx.
func TestHangupBeforeTheAckDefersTheByeUntilItArrives(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})

	hangup := apply(t, d, Input{Trigger: TriggerLocalHangup, Cause: CauseNormalClearing})
	assertKinds(t, hangup, EffectDeferBye)
	if d.State() != StateTerminating {
		t.Fatalf("state = %s, want terminating", d.State())
	}

	ack := apply(t, d, Input{Trigger: TriggerRemoteAck})
	assertKinds(t, ack, EffectSendBye)
	if ack.Effects[0].Cause != CauseNormalClearing {
		t.Errorf("the deferred BYE lost its cause: %d", ack.Effects[0].Cause)
	}
}

// The same obligation, released by the OTHER thing that can release it: 64×T1 with no ACK, which
// RFC 3261 §13.3.1.4 says to answer with a BYE.
func TestAnUnackedTwoHundredEventuallySendsAByeAndTerminates(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})

	outcome := apply(t, d, Input{Trigger: TriggerTimeout, Timeout: TimeoutAck})
	assertKinds(t, outcome, EffectSendBye, EffectStopRetransmit, EffectPublish, EffectReleaseClaim)
	if d.Cause() != CauseRecoveryOnTimerExpire {
		t.Errorf("cause = %d, want 102 recovery on timer expiry", d.Cause())
	}
}

// RFC 3261 §9.1: a CANCEL before any provisional response has nothing to match, so it waits for
// the 100 — and goes out the moment one arrives.
func TestUACHangupBeforeAnyProvisionalDefersTheCancel(t *testing.T) {
	d := newTestDialog(t, RoleUAC)

	hangup := apply(t, d, Input{Trigger: TriggerLocalHangup, Cause: CauseNormalClearing})
	assertKinds(t, hangup, EffectDeferCancel)

	provisional := apply(t, d, Input{Trigger: TriggerRemoteProvisional})
	assertKinds(t, provisional, EffectSendCancel)
}

// A hangup issued while the INVITE was ringing, with a 200 landing first: the answer wins and the
// teardown must be ACK-then-BYE, never a CANCEL and never a bare BYE.
func TestUACHangupThatLosesToTheTwoHundredBecomesAckThenBye(t *testing.T) {
	d := newTestDialog(t, RoleUAC)
	apply(t, d, Input{Trigger: TriggerRemoteProvisional})
	apply(t, d, Input{Trigger: TriggerLocalHangup, Cause: CauseNormalClearing})

	outcome := apply(t, d, Input{
		Trigger:   TriggerRemoteAnswer,
		RemoteTag: "far-tag",
		Body:      []byte("v=0\r\n"),
	})
	assertKinds(t, outcome, EffectSendAck, EffectPublish, EffectSendBye)
	if outcome.Effects[1].Event != EventAnswered {
		t.Errorf("published %q, want %q", outcome.Effects[1].Event, EventAnswered)
	}
}

// The answered event must carry the 2xx's negotiated answer: the engine feeds it to
// `rpc.media.v1.accept-answer`, and without it mediad never commits the B-leg codec.
func TestUACAnsweredEventCarriesTheNegotiatedSDP(t *testing.T) {
	d := newTestDialog(t, RoleUAC)
	apply(t, d, Input{Trigger: TriggerRemoteProvisional})

	answer := []byte("v=0\r\no=- 1 1 IN IP4 203.0.113.9\r\nm=audio 40000 RTP/AVP 0\r\n")
	outcome := apply(t, d, Input{Trigger: TriggerRemoteAnswer, RemoteTag: "far", Body: answer})

	assertKinds(t, outcome, EffectSendAck, EffectPublish)
	published := outcome.Effects[1]
	if published.Event != EventAnswered {
		t.Fatalf("published %q, want %q", published.Event, EventAnswered)
	}
	if !bytes.Equal(published.Body, answer) {
		t.Errorf("answered body = %q, want the 2xx's answer %q", published.Body, answer)
	}
}

// RFC 3261 §13.2.2.4 and design §9.7: a second 2xx from a branch we did not take is ACKed then BYEd.
func TestASecondTwoHundredFromAForkedBranchIsAckedAndByed(t *testing.T) {
	d := newTestDialog(t, RoleUAC)
	apply(t, d, Input{Trigger: TriggerRemoteAnswer, RemoteTag: "branch-a"})

	outcome := apply(t, d, Input{Trigger: TriggerRemoteAnswer, RemoteTag: "branch-b"})
	assertKinds(t, outcome, EffectAckAndBye)

	// A retransmission of the SAME branch's 2xx is only re-ACKed.
	repeat := apply(t, d, Input{Trigger: TriggerRemoteAnswer, RemoteTag: "branch-a"})
	assertKinds(t, repeat, EffectSendAck)
}

// A BYE crossing our own BYE must terminate the dialog once: two terminal events is two CDR rows.
func TestSimultaneousHangupTerminatesExactlyOnce(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	apply(t, d, Input{Trigger: TriggerLocalAnswer})
	apply(t, d, Input{Trigger: TriggerRemoteAck})
	ours := apply(t, d, Input{Trigger: TriggerLocalHangup, Cause: CauseNormalClearing})
	assertKinds(t, ours, EffectSendBye, EffectStopSessionTimer)

	theirs := apply(t, d, Input{Trigger: TriggerRemoteBye})
	terminals := 0
	for _, effect := range theirs.Effects {
		if effect.Kind == EffectPublish && effect.Event == EventTerminated {
			terminals++
		}
	}
	if terminals != 1 {
		t.Fatalf("the crossing BYE produced %d terminal events, want 1", terminals)
	}

	// And the teardown completion that follows produces none at all.
	completion, err := d.Apply(Input{Trigger: TriggerTeardownComplete})
	if !errors.Is(err, ErrDialogGone) {
		t.Fatalf("err = %v, want ErrDialogGone once the dialog has ended", err)
	}
	if len(completion.Effects) != 0 {
		t.Errorf("effects after termination = %v, want none", kindsOf(completion))
	}
}

// Hangup chooses the METHOD from the state, which is the whole of what `rpc.sip.v1.hangup` means.
func TestHangupChoosesTheMethodFromTheState(t *testing.T) {
	cases := []struct {
		name  string
		role  Role
		setup func(*testing.T, *Dialog)
		want  EffectKind
	}{
		{
			name:  "a UAS that has not answered sends a failure response",
			role:  RoleUAS,
			setup: func(t *testing.T, d *Dialog) { apply(t, d, Input{Trigger: TriggerLocalRing}) },
			want:  EffectRespond,
		},
		{
			name: "a UAS that has answered and been ACKed sends a BYE",
			role: RoleUAS,
			setup: func(t *testing.T, d *Dialog) {
				apply(t, d, Input{Trigger: TriggerLocalAnswer})
				apply(t, d, Input{Trigger: TriggerRemoteAck})
			},
			want: EffectSendBye,
		},
		{
			name:  "a UAC in an early dialog sends a CANCEL",
			role:  RoleUAC,
			setup: func(t *testing.T, d *Dialog) { apply(t, d, Input{Trigger: TriggerRemoteEarly, RemoteTag: "far"}) },
			want:  EffectSendCancel,
		},
		{
			name: "a UAC that has been answered but has not ACKed sends the ACK first",
			role: RoleUAC,
			setup: func(t *testing.T, d *Dialog) {
				apply(t, d, Input{Trigger: TriggerRemoteAnswer, RemoteTag: "far"})
			},
			want: EffectSendAck,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newTestDialog(t, tc.role)
			tc.setup(t, d)
			outcome := apply(t, d, Input{Trigger: TriggerLocalHangup, Cause: CauseNormalClearing})
			if len(outcome.Effects) == 0 || outcome.Effects[0].Kind != tc.want {
				t.Fatalf("effects = %v, want %v first", kindsOf(outcome), tc.want)
			}
		})
	}
}

// An explicit Q.850 cause on an unanswered UAS leg becomes the SIP status it maps to, so a busy
// extension produces 486 and not a generic 480.
func TestHangupCauseChoosesTheFailureStatus(t *testing.T) {
	cases := []struct {
		cause  int
		status int
	}{
		{CauseUserBusy, 486},
		{CauseSubscriberAbsent, 480},
		{CauseUnallocatedNumber, 404},
		{CauseCallRejected, 403},
		{CauseNoCircuitAvailable, 503},
		{CauseIncompatibleDestination, 488},
	}
	for _, tc := range cases {
		t.Run(StatusForCauseName(tc.cause), func(t *testing.T) {
			d := newTestDialog(t, RoleUAS)
			apply(t, d, Input{Trigger: TriggerLocalRing})
			outcome := apply(t, d, Input{Trigger: TriggerLocalHangup, Cause: tc.cause})
			if outcome.Effects[0].Status != tc.status {
				t.Errorf("status = %d, want %d", outcome.Effects[0].Status, tc.status)
			}
		})
	}
}

// StatusForCauseName is a test helper that names a subtest after the cause it exercises.
func StatusForCauseName(cause int) string {
	status, reason := StatusForCause(cause)
	return reason + " (" + itoa(status) + ")"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 3)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// RFC 3261 §13.2.1: the 200 must repeat the answer a 183 committed, byte for byte.
func TestTheTwoHundredRepeatsTheAnswerCommittedByAnEarlyMediaResponse(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	body := []byte("v=0\r\no=- 1 1 IN IP4 198.51.100.1\r\nm=audio 40000 RTP/AVP 0\r\n")

	apply(t, d, Input{Trigger: TriggerLocalEarlyMedia, Body: body})
	answer := apply(t, d, Input{Trigger: TriggerLocalAnswer})

	if string(answer.Effects[0].Body) != string(body) {
		t.Fatalf("the 200 carried %q, want the 183's answer verbatim", answer.Effects[0].Body)
	}
}

// A ring timeout ends an unanswered UAS leg with a status and an unanswered UAC leg with a CANCEL.
func TestRingTimeoutEndsTheCallByRole(t *testing.T) {
	uas := newTestDialog(t, RoleUAS)
	apply(t, uas, Input{Trigger: TriggerLocalRing})
	outcome := apply(t, uas, Input{Trigger: TriggerTimeout, Timeout: TimeoutRing})
	if outcome.Effects[0].Kind != EffectRespond || outcome.Effects[0].Status != 480 {
		t.Errorf("UAS ring timeout = %v/%d, want respond 480", outcome.Effects[0].Kind, outcome.Effects[0].Status)
	}
	if uas.Cause() != CauseNoAnswer {
		t.Errorf("cause = %d, want 19 no answer", uas.Cause())
	}

	uac := newTestDialog(t, RoleUAC)
	apply(t, uac, Input{Trigger: TriggerRemoteEarly, RemoteTag: "far"})
	outcome = apply(t, uac, Input{Trigger: TriggerTimeout, Timeout: TimeoutRing})
	if outcome.Effects[0].Kind != EffectSendCancel {
		t.Errorf("UAC ring timeout = %v, want a CANCEL", outcome.Effects[0].Kind)
	}
}

// Timer B: no response of any kind. Q.850 18, "no user responding".
func TestInviteTimeoutIsNoUserResponding(t *testing.T) {
	d := newTestDialog(t, RoleUAC)
	outcome := apply(t, d, Input{Trigger: TriggerTimeout, Timeout: TimeoutInvite})
	assertKinds(t, outcome, EffectPublish, EffectReleaseClaim)
	if outcome.Effects[0].Cause != CauseNoUserResponse {
		t.Errorf("cause = %d, want 18", outcome.Effects[0].Cause)
	}
	if outcome.Effects[0].Termination != ReasonTimeout {
		t.Errorf("termination = %s, want timeout", outcome.Effects[0].Termination)
	}
}

func TestNewRefusesADialogWithNoKey(t *testing.T) {
	if _, err := New(Options{Identity: Identity{SIPCallID: "x"}}); !errors.Is(err, ErrNoLegID) {
		t.Errorf("err = %v, want ErrNoLegID", err)
	}
	if _, err := New(Options{LegID: "leg"}); !errors.Is(err, ErrNoIdentity) {
		t.Errorf("err = %v, want ErrNoIdentity", err)
	}
}
