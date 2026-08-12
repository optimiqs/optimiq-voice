package dialog

import (
	"time"

	"github.com/emiago/sipgo/sip"
)

// MidDialogKind distinguishes the two ways a far end renegotiates an established session.
//
// They are not interchangeable and the difference is the whole reason UPDATE exists: an INVITE may
// only be re-sent on a CONFIRMED dialog, whereas an UPDATE (RFC 3311) is legal on an EARLY one
// too. A phone that puts a ringing call on hold sends UPDATE; one that puts a live call on hold
// sends a re-INVITE. Treating them as one method means one of those two cases is answered wrongly.
type MidDialogKind int

const (
	// KindReInvite is a second INVITE inside an established dialog.
	KindReInvite MidDialogKind = iota
	// KindUpdate is RFC 3311 UPDATE.
	KindUpdate
)

// String renders the kind for logs.
func (k MidDialogKind) String() string {
	if k == KindUpdate {
		return "UPDATE"
	}
	return "re-INVITE"
}

// MidDialogInput is one mid-dialog offer arriving from the far end.
type MidDialogInput struct {
	Kind MidDialogKind
	// Body is the SDP offer, opaque except for its direction attribute.
	Body []byte
	// Contact is the far end's Contact header when it sent one, for the RFC 3261 §12.2.1.1 target
	// refresh. A dialog whose far end moved — a phone that re-registered from a different port, a
	// carrier that failed over to a second SBC — sends mid-dialog requests from the new place and
	// expects ours to arrive there.
	Contact *sip.Uri
	// Observed is the transport-level source of this request, which is what a phone behind NAT is
	// actually reachable at even when its Contact says otherwise.
	Observed string
	// Timer is the peer's RFC 4028 headers on this request, so a refresh renegotiates rather than
	// silently keeping the old interval.
	Timer TimerRequest
	// At is the instant to record; zero means the dialog's own clock.
	At time.Time
}

// MidDialogOutcome is what to do with a mid-dialog offer.
type MidDialogOutcome struct {
	// Accepted is true when the offer may be answered. The answer itself comes from the engine
	// (which gets it from mediad), so acceptance here means "hold the transaction open and expect
	// an answer command", not "200 sent".
	Accepted bool
	// Status, Reason and RetryAfter describe the refusal when Accepted is false.
	Status     int
	Reason     string
	RetryAfter time.Duration
	// HoldChanged reports whether the far end's direction moved across the hold boundary, and Held
	// says which way. Only a CHANGE is worth an event: publishing `dialog.held` for a codec change
	// or a NAT re-latch would start music-on-hold over a live conversation.
	HoldChanged bool
	Held        bool
	// Direction is the far end's declared direction, for the log.
	Direction Direction
	// Effects are the events to publish and the timers to move.
	Effects []Effect
}

// ApplyMidDialog decides what happens to a re-INVITE or UPDATE from the far end.
//
// # The three refusals, each RFC-mandated and each with a different meaning
//
//  1. 491 Request Pending, when an offer of OURS is outstanding. RFC 3261 §14.2: two dialogs each
//     believing they own an offer is a call whose media direction is decided by whichever answer
//     lands last. The far end retries after a randomised interval (GlareBackoff), and so do we.
//  2. 500 Server Internal Error with Retry-After, when a re-INVITE arrives before the INITIAL
//     INVITE has been finally answered. RFC 3261 §14.2 names this case exactly; it is not a glare
//     because there is no competing offer, it is a peer running ahead of the dialog's own state.
//  3. 481, when the dialog is over. The transaction layer would say the same thing; saying it here
//     means the log records which dialog it was.
//
// An UPDATE is exempt from (2): RFC 3311 §5.1 exists precisely so a party can change a session
// before it is answered, and refusing one on an early dialog would break hold-while-ringing on
// every handset that implements it properly.
func (d *Dialog) ApplyMidDialog(in MidDialogInput) (MidDialogOutcome, error) {
	at := in.At
	if at.IsZero() {
		at = d.now()
	}

	switch d.state {
	case StateTerminating, StateTerminated:
		return MidDialogOutcome{Status: 481, Reason: "Call/Transaction Does Not Exist"}, ErrDialogGone
	case StateInit, StateProceeding, StateEarly:
		if in.Kind == KindReInvite {
			return MidDialogOutcome{
				Status:     500,
				Reason:     "Server Internal Error",
				RetryAfter: 10 * time.Second,
			}, ErrInvalidState
		}
	}

	if d.offer.outstanding {
		return MidDialogOutcome{Status: 491, Reason: "Request Pending"}, nil
	}

	// The target refresh happens on ACCEPTANCE and not on the answer, because the far end has
	// already moved: its next request comes from the new place whether or not we answer this one.
	if in.Contact != nil {
		d.Target.Contact = *in.Contact
	}
	if in.Observed != "" {
		d.Target.Observed = in.Observed
	}

	direction := DirectionOf(in.Body)
	changed, held := d.offer.noteRemoteDirection(direction)

	outcome := MidDialogOutcome{
		Accepted:    true,
		HoldChanged: changed,
		Held:        held,
		Direction:   direction,
	}
	if changed {
		event := EventResumed
		if held {
			event = EventHeld
		}
		outcome.Effects = append(outcome.Effects, publish(event))
	}
	// A refresh re-arms the timer even when nothing else changed — that is what a refresh IS
	// (RFC 4028 §8): the session lives another interval because somebody said so.
	if d.timer.Negotiated() {
		outcome.Effects = append(outcome.Effects, Effect{Kind: EffectStartSessionTimer})
	}
	return outcome, nil
}

// AnswerMidDialog commits the answer the engine couriered back and produces the 200.
//
// The body is committed before the response goes out, for the same reason the initial answer is:
// a later message that must repeat this answer (a 200 following a 183, a refresh that changes
// nothing) has to repeat it byte for byte, and the only reliable source of those bytes is our own
// record of what we sent.
func (d *Dialog) AnswerMidDialog(body []byte) []Effect {
	d.offer.commitAnswer(body)
	return []Effect{{Kind: EffectRespondToRequest, Status: 200, Reason: "OK", Body: body}}
}

// BeginReOffer marks an offer of OURS as outstanding, so a colliding offer from the far end is
// answered 491 rather than accepted (RFC 3261 §14.2).
//
// It refuses when one is already outstanding: two of our own offers in flight is not glare, it is
// this process having lost track, and issuing the second would produce an answer nobody can match
// to an offer.
func (d *Dialog) BeginReOffer() error {
	if !d.state.Answered() {
		return ErrInvalidState
	}
	if d.offer.outstanding {
		return ErrInvalidState
	}
	d.offer.outstanding = true
	return nil
}

// CompleteReOffer clears the outstanding flag when our offer has been answered.
func (d *Dialog) CompleteReOffer(answer []byte) {
	d.offer.commitAnswer(answer)
	d.offer.outstanding = false
}

// AbandonReOffer clears the outstanding flag when our offer failed — a 491, a 408, or a transport
// error. Without it, one failed re-INVITE would make every subsequent offer from the far end look
// like glare, for the life of the call.
func (d *Dialog) AbandonReOffer() { d.offer.outstanding = false }

// ReOfferOutstanding reports whether one of our offers is in flight.
func (d *Dialog) ReOfferOutstanding() bool { return d.offer.outstanding }

// GlareRetryAfter is how long to wait before re-sending a re-INVITE that was answered 491.
//
// The range is chosen by comparing Call-IDs, which is RFC 3261 §14.1's rule and the only tie-break
// both ends can compute identically without another round trip. `fraction` is rand.Float64() in
// production and a constant in a test.
func (d *Dialog) GlareRetryAfter(remoteCallID string, fraction float64) time.Duration {
	return GlareBackoff(HasHigherCallID(d.Identity.SIPCallID, remoteCallID), fraction)
}

// RemoteDirection reports the far end's last declared media direction, defaulting to sendrecv for
// a dialog on which nobody has said anything.
func (d *Dialog) RemoteDirection() Direction {
	if d.offer.remoteDirection == "" {
		return DirectionSendRecv
	}
	return d.offer.remoteDirection
}

// Held reports whether the far end currently has us on hold.
func (d *Dialog) Held() bool { return d.RemoteDirection().Holds() }

// RefreshTimer applies a renegotiated RFC 4028 result from a refresh, and reports whether the
// interval actually moved. A refresh that changes the interval must re-arm both sides' timers; one
// that does not is still a refresh and still re-arms them, which is why the caller starts the timer
// either way and only logs on a change.
func (d *Dialog) RefreshTimer(timer SessionTimer) bool {
	changed := d.timer.Interval != timer.Interval || d.timer.Refresher != timer.Refresher
	d.timer = timer
	return changed
}

// NoteLocalDirection records the direction WE last declared, which is what makes an unhold
// idempotent: a second `unhold` on a call that is not held must not put a re-INVITE on the wire.
func (d *Dialog) NoteLocalDirection(direction Direction) { d.offer.localDirection = direction }

// LocalDirection reports the direction we last declared.
func (d *Dialog) LocalDirection() Direction {
	if d.offer.localDirection == "" {
		return DirectionSendRecv
	}
	return d.offer.localDirection
}
