package invite

import (
	"context"
	"fmt"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// The engine's command surface, as methods on the Handler.
//
// # Why they live here and not in internal/command
//
// internal/command owns the WIRE: subjects, payloads, refusal codes and the queue group. This file
// owns the DIALOG: which trigger a command becomes, and what its outcome means. Keeping the two
// apart is what lets the responder be unit-tested against a stub with no sipgo in it and lets these
// be unit-tested against a dialog machine with no NATS in it — and it is why neither file contains a
// switch on the other's vocabulary.
//
// Every method here reports failure as one of internal/dialog's refusal errors, wrapped with enough
// context to be worth reading in a log. The wrapping is deliberate and the responder's `errors.Is`
// is what makes it safe: a wrapped `dialog.ErrUnknownDialog` still becomes `unknown_dialog` on the
// wire, and the wrap is what puts the leg id in the operator's log line.

// Ring implements the ring half of the engine's command surface.
//
// `180 Ringing` without a body. The status is passed through so a future early-media slice changes
// one line rather than this whole method; a `183` reaching here today has already been refused
// `not_supported` by the responder, which is where that decision belongs because it is a statement
// about what this BUILD serves rather than about what this dialog is doing.
func (h *Handler) Ring(ctx context.Context, legID string, status int, sdpAnswer string) error {
	trigger := dialog.TriggerLocalRing
	var body []byte
	if sdpAnswer != "" {
		// Reachable only when a caller bypasses the responder's refusal, and correct if it ever is:
		// TriggerLocalEarlyMedia is the trigger that COMMITS the answer, which is what makes the
		// subsequent 200 OK repeat it byte for byte (RFC 3261 §13.2.1).
		trigger = dialog.TriggerLocalEarlyMedia
		body = []byte(sdpAnswer)
	}

	reason := "Ringing"
	if status == 183 {
		reason = "Session Progress"
	}
	return h.command(ctx, legID, "ring", dialog.Input{
		Trigger: trigger,
		Status:  status,
		Reason:  reason,
		Body:    body,
	})
}

// Answer implements the answer half: a 200 OK with mediad's body, written to the socket.
//
// # It returns when the 2xx is WRITTEN, and that is structural rather than a promise
//
// dialog.Session runs a task's effects ON THE DIALOG'S GOROUTINE, in order, BEFORE the task's caller
// is answered. So by the time Apply returns, EffectRespond has already handed the response to the
// INVITE server transaction and the RFC 6026 retransmission loop has been started as a background
// goroutine that nothing here waits on. There is no path through this method that blocks on an ACK.
//
// That is the whole of design §4.6, and it is worth being precise about what it avoids: sipgo's
// `DialogServerSession.WriteResponse` blocks its caller until the ACK or 64×T1 ≈ 32 s. This edge
// never calls it — it drives the transaction directly and owns the retransmission itself
// (executor.startRetransmit explains why the TU must) — which is exactly what lets a 1000 ms RPC
// wrap a 32-second SIP transaction without timing out.
//
// The returned instant is when the write happened, and it is the anchor for a post-dial-delay plot.
func (h *Handler) Answer(ctx context.Context, legID, sdpAnswer string) (time.Time, error) {
	if err := h.command(ctx, legID, "answer", dialog.Input{
		Trigger: dialog.TriggerLocalAnswer,
		Body:    []byte(sdpAnswer),
	}); err != nil {
		return time.Time{}, err
	}
	// Read AFTER the effects have run, so it is the instant the response went out rather than the
	// instant the command arrived. The difference is a mailbox hop and it is the difference between
	// measuring this edge's latency and measuring the broker's.
	return h.now(), nil
}

// Hangup implements the hangup half, and reports which METHOD the dialog layer chose.
//
// The choice is not this method's and not the engine's: internal/dialog picks a BYE, a CANCEL or a
// failure response from the state it owns, because the process holding the CSeq is the only one that
// can. What happens here is a translation of the resulting effects back into the contract's
// five-word vocabulary, and the interesting half of that is `deferred`.
func (h *Handler) Hangup(
	ctx context.Context,
	legID string,
	cause int,
	detail string,
) (contract.SipHangupResponseMethod, error) {
	session, ok := h.session(legID)
	if !ok {
		return contract.SipHangupResponseMethodNone,
			fmt.Errorf("invite: hangup for leg %s: %w", legID, dialog.ErrUnknownDialog)
	}

	outcome, err := session.Apply(ctx, dialog.Input{
		Trigger: dialog.TriggerLocalHangup,
		Cause:   cause,
	})
	if err != nil {
		return contract.SipHangupResponseMethodNone,
			fmt.Errorf("invite: hangup for leg %s: %w", legID, err)
	}
	method := hangupMethodOf(outcome)
	h.log.Info("hangup",
		"legId", legID, "cause", cause, "method", string(method),
		"from", outcome.From.String(), "to", outcome.To.String(), "detail", detail)
	return method, nil
}

// hangupMethodOf reads the contract's `method` off the effects the machine produced.
//
// # The order of the checks is the meaning
//
// A teardown can produce several effects — an ACK before a BYE on the UAC path, a failure response
// plus a terminal publish on the UAS one — so this is not "the first effect" but a priority. The
// DEFERRALS come first, because a deferred BYE is emitted alongside nothing else and is the one
// outcome the caller must be able to tell apart: it is the case where the hangup succeeded, no
// packet left, and a later `dialog.terminated` is genuinely still owed (RFC 3261 §15 for the unACKed
// 2xx, §9.1 for the pre-provisional CANCEL).
//
// `none` is the answer for an idempotent repeat. A second `hangup` for a leg already tearing down
// produces no effects at all, by design (§4.6: a timed-out hangup may be reissued and must not
// produce a second BYE), and reporting `bye` for it would tell the engine a packet went out that
// did not.
func hangupMethodOf(outcome dialog.Outcome) contract.SipHangupResponseMethod {
	switch {
	case outcome.Has(dialog.EffectDeferBye), outcome.Has(dialog.EffectDeferCancel):
		return contract.SipHangupResponseMethodDeferred
	case outcome.Has(dialog.EffectSendBye), outcome.Has(dialog.EffectAckAndBye):
		return contract.SipHangupResponseMethodBye
	case outcome.Has(dialog.EffectSendCancel):
		return contract.SipHangupResponseMethodCancel
	case outcome.Has(dialog.EffectRespond):
		return contract.SipHangupResponseMethodRespond
	default:
		return contract.SipHangupResponseMethodNone
	}
}

// command is the shared body of Ring and Answer: find the leg, apply one trigger, wrap the error.
//
// It is not shared with Hangup, which needs the outcome rather than only the error, and factoring
// the two together would mean returning an Outcome that one caller ignores — which reads as if the
// outcome mattered to both.
func (h *Handler) command(ctx context.Context, legID, name string, in dialog.Input) error {
	session, ok := h.session(legID)
	if !ok {
		// `unknown_dialog` and not `wrong_instance`. This process cannot tell the two apart on its
		// own — it would need to read the `sip-dialogs` bucket to see whether somebody ELSE holds the
		// leg — and these subjects are instance-addressed, so a command that reached this instance
		// for a leg it does not hold is overwhelmingly a leg that has ended. Claiming
		// `wrong_instance` would tell the engine to go looking for an owner that does not exist.
		return fmt.Errorf("invite: %s for leg %s: %w", name, legID, dialog.ErrUnknownDialog)
	}
	if _, err := session.Apply(ctx, in); err != nil {
		return fmt.Errorf("invite: %s for leg %s: %w", name, legID, err)
	}
	return nil
}

// session looks a leg's session up without touching the dialog, so a command that names a leg this
// instance does not hold costs a map read rather than a mailbox round trip.
func (h *Handler) session(legID string) (*dialog.Session, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	found, ok := h.legs[legID]
	if !ok {
		return nil, false
	}
	return found.session, true
}
