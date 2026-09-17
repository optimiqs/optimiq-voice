package invite

import (
	"context"
	"fmt"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// The engine's command surface, as methods on the Handler. internal/command owns the wire —
// subjects, payloads, refusal codes, the queue group — and this file owns the dialog: which trigger
// a command becomes, and what its outcome means.
//
// Every method reports failure as one of internal/dialog's refusal errors, wrapped for the log. The
// responder's `errors.Is` is what keeps that safe: a wrapped `dialog.ErrUnknownDialog` still becomes
// `unknown_dialog` on the wire.

// Ring implements the ring half of the engine's command surface: `180 Ringing` without a body. A
// `183` is refused `not_supported` by the responder before it reaches here.
func (h *Handler) Ring(ctx context.Context, legID string, status int, sdpAnswer string) error {
	trigger := dialog.TriggerLocalRing
	var body []byte
	if sdpAnswer != "" {
		// Reachable only when a caller bypasses the responder's refusal. TriggerLocalEarlyMedia
		// commits the answer, so the subsequent 200 OK repeats it byte for byte (RFC 3261 §13.2.1).
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

// Answer implements the answer half: a 200 OK with mediad's body, written to the socket. It returns
// once the 2xx is written and never blocks on an ACK — dialog.Session runs a task's effects on the
// dialog's goroutine before answering the caller, and the RFC 6026 retransmission loop runs in the
// background. That is what lets a 1000 ms RPC wrap a 32-second SIP transaction; sipgo's
// `DialogServerSession.WriteResponse`, which blocks until the ACK or 64×T1, is never called.
//
// The returned instant is when the write happened: the anchor for post-dial delay.
func (h *Handler) Answer(ctx context.Context, legID, sdpAnswer string) (time.Time, error) {
	if err := h.command(ctx, legID, "answer", dialog.Input{
		Trigger: dialog.TriggerLocalAnswer,
		Body:    []byte(sdpAnswer),
	}); err != nil {
		return time.Time{}, err
	}
	// Read after the effects have run, so it is the instant the response went out rather than the
	// instant the command arrived.
	return h.now(), nil
}

// Hangup implements the hangup half and reports which method the dialog layer chose. internal/dialog
// picks a BYE, a CANCEL or a failure response from the state it owns; this only translates the
// resulting effects into the contract's vocabulary.
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

// hangupMethodOf reads the contract's `method` off the effects the machine produced. A teardown can
// produce several, so the check order is a priority rather than "the first effect".
//
// Deferrals come first: a deferred teardown means the hangup succeeded, no packet left, and a later
// `dialog.terminated` is still owed (RFC 3261 §15 for the unACKed 2xx, §9.1 for the pre-provisional
// CANCEL). `none` is the answer for an idempotent repeat, which by design produces no effects at
// all; reporting `bye` would claim a packet went out that did not.
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
// Hangup does not use it, because it needs the outcome rather than only the error.
func (h *Handler) command(ctx context.Context, legID, name string, in dialog.Input) error {
	session, ok := h.session(legID)
	if !ok {
		// `unknown_dialog` and not `wrong_instance`: these subjects are instance-addressed, so a
		// command that reached this instance for a leg it does not hold is almost always a leg that
		// has ended, and `wrong_instance` would send the engine looking for an owner that is gone.
		return fmt.Errorf("invite: %s for leg %s: %w", name, legID, dialog.ErrUnknownDialog)
	}
	if _, err := session.Apply(ctx, in); err != nil {
		return fmt.Errorf("invite: %s for leg %s: %w", name, legID, err)
	}
	return nil
}

// session looks a leg's session up without touching the dialog, so a command naming a leg this
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
