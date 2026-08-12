package invite

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// executor turns the dialog machine's effects into wire actions.
//
// # Where it runs, and why that matters
//
// On the dialog's own goroutine, in order, before the command that produced the effects is
// answered (see dialog.Session). That is the whole guarantee: a 200 is on the socket before
// `answer` replies, and a CANCEL that arrives meanwhile queues behind it. Nothing in this type
// takes a lock, and nothing in it may block for long — a handler that waited for a far end's
// response would stall every subsequent command for that call.
type executor struct {
	handler *Handler
	state   *legState
}

var _ dialog.EffectHandler = (*executor)(nil)

// Handle implements dialog.EffectHandler.
func (e *executor) Handle(ctx context.Context, d *dialog.Dialog, effect dialog.Effect) error {
	switch effect.Kind {
	case dialog.EffectRespond:
		return e.respondToInvite(d, effect)
	case dialog.EffectRespondToRequest:
		return e.respondToPending(effect)
	case dialog.EffectRespondToCancel:
		return e.respondToPending(effect)
	case dialog.EffectStopRetransmit:
		e.stopRetransmit()
		return nil
	case dialog.EffectSendBye:
		return e.sendBye(ctx, d, effect)
	case dialog.EffectSendCancel:
		return e.sendCancel(ctx)
	case dialog.EffectSendAck:
		return e.sendAck(ctx, d, effect)
	case dialog.EffectAckAndBye:
		if err := e.sendAck(ctx, d, effect); err != nil {
			return err
		}
		return e.sendBye(ctx, d, effect)
	case dialog.EffectDeferBye, dialog.EffectDeferCancel:
		// Nothing to do now, by construction: the machine holds the obligation and releases it as
		// EffectSendBye or EffectSendCancel when the ACK or the first provisional arrives. Named
		// here rather than defaulted so a reader sees the wait is deliberate.
		e.handler.log.Debug("teardown deferred",
			"legId", d.LegID, "reason", effect.Detail)
		return nil
	case dialog.EffectPublish:
		e.handler.publish(Event{
			Kind:        effect.Event,
			LegID:       d.LegID,
			OrgID:       d.OrgID,
			CallID:      d.CallID,
			SIPCallID:   d.Identity.SIPCallID,
			Cause:       effect.Cause,
			Termination: effect.Termination,
			Detail:      effect.Detail,
			At:          e.handler.now(),
		})
		return nil
	case dialog.EffectStartSessionTimer:
		e.armSessionTimer(d)
		return nil
	case dialog.EffectStopSessionTimer:
		e.stopSessionTimer()
		return nil
	case dialog.EffectSendSessionRefresh:
		// The refresh is a re-INVITE whose offer comes from mediad by way of the engine, so it
		// cannot be built here. Logged rather than silently skipped: a deployment where this fires
		// is one where session timers were turned on before the command surface existed, and the
		// log is what tells the operator which of the two to fix.
		e.handler.log.Warn("a session refresh is due and there is no command surface to build it",
			"legId", d.LegID)
		return nil
	case dialog.EffectReleaseClaim:
		e.stopRetransmit()
		e.stopSessionTimer()
		e.stopRingTimer()
		e.handler.forget(d.LegID)
		return nil
	default:
		return nil
	}
}

// respondToInvite writes a response on the INVITE server transaction.
//
// It also owns the two things that go with a 2xx: the RFC 6026 retransmission loop, and the ring
// timer's cancellation. Both belong here because both are consequences of the response being
// written and neither is knowable before it is.
func (e *executor) respondToInvite(d *dialog.Dialog, effect dialog.Effect) error {
	if e.state.inviteTx == nil || e.state.invite == nil {
		return errors.New("invite: no INVITE transaction to respond on")
	}
	res := sip.NewResponseFromRequest(e.state.invite, effect.Status, effect.Reason, effect.Body)
	// Our To tag, on every response above 100. sipgo mints one of its own when the request carried
	// none and does not tell us which — and the tag on the 180 must be the SAME string as on the
	// 200, or the far end sees two early dialogs and one of them never ends.
	if effect.Status > 100 {
		if to := res.To(); to != nil {
			to.Params.Remove("tag")
			to.Params.Add("tag", d.Identity.LocalTag)
		}
	}
	if len(effect.Body) > 0 {
		res.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	if effect.Status >= 200 && effect.Status < 300 {
		res.AppendHeader(&sip.ContactHeader{Address: e.handler.contact})
		if timer := d.Timer(); timer.Negotiated() {
			res.AppendHeader(sip.NewHeader("Session-Expires",
				dialog.SessionExpiresHeader(timer, d.Role)))
			res.AppendHeader(sip.NewHeader("Min-SE",
				strconv.Itoa(int(timer.MinSE/time.Second))))
			res.AppendHeader(sip.NewHeader("Require", "timer"))
		}
	}
	if e.state.retryAfter > 0 && effect.Status >= 400 {
		res.AppendHeader(retryAfterHeader(e.state.retryAfter))
	}
	res.AppendHeader(sip.NewHeader("Server", e.handler.server))

	if err := e.state.inviteTx.Respond(res); err != nil {
		return err
	}
	if effect.Status >= 200 {
		e.stopRingTimer()
	}
	if effect.Status >= 200 && effect.Status < 300 {
		e.startRetransmit(d, res)
		// RFC 3891 §3: the replaced dialog is ended when the replacement is ACCEPTED, which is now
		// and not when the INVITE arrived. Tearing down on arrival and then failing to answer would
		// leave the user with no call at all, having hung up a conversation that was working.
		if e.state.replacesLegID != "" {
			replaced := e.state.replacesLegID
			e.state.replacesLegID = ""
			handler := e.handler
			handler.backgroundWork.Add(1)
			go func() {
				defer handler.backgroundWork.Done()
				handler.completeReplaces(replaced)
			}()
		}
	}
	return nil
}

// respondToPending answers the mid-dialog request currently being processed.
func (e *executor) respondToPending(effect dialog.Effect) error {
	if e.state.pendingTx == nil || e.state.pending == nil {
		return errors.New("invite: no pending request to respond to")
	}
	res := sip.NewResponseFromRequest(e.state.pending, effect.Status, effect.Reason, effect.Body)
	if len(effect.Body) > 0 {
		res.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	res.AppendHeader(sip.NewHeader("Server", e.handler.server))
	err := e.state.pendingTx.Respond(res)
	e.state.pending, e.state.pendingTx = nil, nil
	return err
}

// startRetransmit runs RFC 6026's 2xx-until-ACK loop.
//
// # Why the TU owns this and not the transaction layer
//
// An INVITE server transaction TERMINATES when a 2xx is sent (RFC 3261 §17.2.1), precisely so that
// the transaction layer stops absorbing retransmissions and the ACK can be a new transaction. The
// consequence is that nobody but the TU retransmits the 2xx, and a 2xx that is lost on a UDP path
// with no retransmission is a call that rang, was answered, and then failed silently.
//
// The interval doubles from T1 to T2 and the loop gives up at 64×T1, at which point RFC 3261
// §13.3.1.4 says to send a BYE — which is what the TimeoutAck trigger produces.
func (e *executor) startRetransmit(d *dialog.Dialog, res *sip.Response) {
	if e.handler.responder == nil {
		return
	}
	e.stopRetransmit()

	ctx, cancel := context.WithCancel(e.handler.baseCtx)
	e.state.answer = res
	e.state.stopRetransmit = cancel

	legID := d.LegID
	handler := e.handler
	interval := handler.retransmitT1
	deadline := time.Now().Add(handler.retransmitFor)

	handler.backgroundWork.Add(1)
	go func() {
		defer handler.backgroundWork.Done()
		defer cancel()
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			if time.Now().After(deadline) {
				handler.post(legID, dialog.Input{
					Trigger: dialog.TriggerTimeout,
					Timeout: dialog.TimeoutAck,
				})
				return
			}
			if err := handler.responder.WriteResponse(res); err != nil {
				handler.log.Warn("cannot retransmit the 200", "legId", legID, "error", err)
			}
			if interval < handler.retransmitCap {
				interval *= 2
				if interval > handler.retransmitCap {
					interval = handler.retransmitCap
				}
			}
			timer.Reset(interval)
		}
	}()
}

func (e *executor) stopRetransmit() {
	if e.state.stopRetransmit != nil {
		e.state.stopRetransmit()
		e.state.stopRetransmit = nil
	}
	e.state.answer = nil
}

func (e *executor) stopRingTimer() {
	if e.state.ringTimer != nil {
		e.state.ringTimer.Stop()
		e.state.ringTimer = nil
	}
}

// armSessionTimer sets the RFC 4028 deadline for this side.
//
// The refresher arms the REFRESH point (half the interval) and the other side arms the EXPIRY. Both
// end up here because both are one timer with two meanings, and conflating them would either
// refresh a session we do not own or tear down one whose refresh is on the wire.
func (e *executor) armSessionTimer(d *dialog.Dialog) {
	e.stopSessionTimer()
	timer := d.Timer()
	if !timer.Negotiated() {
		return
	}
	legID := d.LegID
	handler := e.handler

	if after := timer.RefreshAfter(); after > 0 {
		e.state.sessionTimer = time.AfterFunc(after, func() {
			handler.withLeg(legID, func(session *dialog.Session, _ *legState) {
				ctx, cancel := context.WithTimeout(handler.baseCtx, 5*time.Second)
				defer cancel()
				_, _ = session.Do(ctx, func(*dialog.Dialog) (dialog.Outcome, error) {
					return dialog.Outcome{Effects: []dialog.Effect{
						{Kind: dialog.EffectSendSessionRefresh},
					}}, nil
				})
			})
		})
		return
	}
	e.state.sessionTimer = time.AfterFunc(timer.ExpiresAfter(), func() {
		handler.post(legID, dialog.Input{
			Trigger: dialog.TriggerTimeout,
			Timeout: dialog.TimeoutSession,
		})
	})
}

func (e *executor) stopSessionTimer() {
	if e.state.sessionTimer != nil {
		e.state.sessionTimer.Stop()
		e.state.sessionTimer = nil
	}
}

func (e *executor) sendBye(ctx context.Context, d *dialog.Dialog, effect dialog.Effect) error {
	e.state.localCSeq++
	req := buildBye(d, e.state.local, e.state.remote, e.state.localCSeq,
		effect.Cause, e.state.profile.NAT, e.handler.contact)
	req.AppendHeader(sip.NewHeader("User-Agent", e.handler.server))
	return e.handler.requester.Send(ctx, req)
}

func (e *executor) sendCancel(ctx context.Context) error {
	if e.state.invite == nil {
		return errors.New("invite: no INVITE to cancel")
	}
	return e.handler.requester.Send(ctx, buildCancel(e.state.invite))
}

func (e *executor) sendAck(ctx context.Context, d *dialog.Dialog, effect dialog.Effect) error {
	// An ACK carries the INVITE's OWN CSeq number, not a new one (RFC 3261 §13.2.2.4). Incrementing
	// it would make the far end treat the ACK as belonging to a transaction that does not exist.
	req := buildAck(d, e.state.local, e.state.remote, e.state.localCSeq,
		effect.Body, e.state.profile.NAT, e.handler.contact)
	return e.handler.requester.Send(ctx, req)
}

// parseInt is strconv.Atoi with the error kept, for the DTMF duration field.
func parseInt(raw string) (int, error) { return strconv.Atoi(raw) }
