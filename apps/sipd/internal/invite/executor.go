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
// It runs on the dialog's own goroutine, in order, before the command that produced the effects is
// answered (see dialog.Session): a 200 is on the socket before `answer` replies, and a CANCEL that
// arrives meanwhile queues behind it. Nothing here takes a lock or may block for long — blocking
// stalls every subsequent command for that call.
type executor struct {
	handler *Handler
	state   *legState
}

var _ dialog.EffectHandler = (*executor)(nil)

// Handle implements dialog.EffectHandler.
func (e *executor) Handle(ctx context.Context, d *dialog.Dialog, effect dialog.Effect) error {
	if d.State().Answered() {
		e.stopRingTimer()
	}
	if (d.State() == dialog.StateTerminating || d.State() == dialog.StateTerminated) && e.state.authCancel != nil {
		e.state.authCancel()
		e.state.authCancel = nil
	}
	switch effect.Kind {
	case dialog.EffectRespond:
		return e.respondToInvite(d, effect)
	case dialog.EffectRespondToRequest:
		return e.respondToPending(d, effect)
	case dialog.EffectRespondToCancel:
		return e.respondToPending(d, effect)
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
		// The machine holds the obligation and releases it as EffectSendBye or EffectSendCancel when
		// the ACK or the first provisional arrives. Named rather than defaulted so the wait reads as
		// deliberate.
		e.handler.log.Debug("teardown deferred",
			"legId", d.LegID, "reason", effect.Detail)
		return nil
	case dialog.EffectPublish:
		e.handler.publish(e.eventFor(d, effect))
		return nil
	case dialog.EffectStartSessionTimer:
		e.armSessionTimer(d)
		return nil
	case dialog.EffectStopSessionTimer:
		e.stopSessionTimer()
		return nil
	case dialog.EffectSendSessionRefresh:
		// The refresh is a re-INVITE whose offer comes from mediad by way of the engine, so it
		// cannot be built here. Logged rather than silently skipped: session timers were turned on
		// before a command surface existed to build one.
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

// eventFor reads one publishable event off the dialog and the effect that produced it. It runs on
// the dialog's goroutine immediately after Apply mutated it, so the dialog is the only consistent
// source. Nothing is derived, defaulted or repaired here: a wrong payload is a wrong state machine.
func (e *executor) eventFor(d *dialog.Dialog, effect dialog.Effect) Event {
	now := e.handler.now()
	event := Event{
		Kind:      effect.Event,
		LegID:     d.LegID,
		OrgID:     d.OrgID,
		CallID:    d.CallID,
		SIPCallID: d.Identity.SIPCallID,
		LocalTag:  d.Identity.LocalTag,
		RemoteTag: d.Identity.RemoteTag,
		Role:      d.Role,
		Status:    effect.Status,
		Detail:    effect.Detail,
		At:        now,
	}

	switch effect.Event {
	case dialog.EventProgressed:
		// "Early media" is a 18x that committed an answer, not merely a far end that is ringing.
		if len(effect.Body) > 0 {
			event.HasEarlyMedia = true
			event.SDPAnswer = string(effect.Body)
		}
		if event.Status == 0 {
			// A UAC leg's `progressed` comes from a response we received, so the effect carries no
			// status line. TriggerRemoteEarly is by definition an 18x, so 180 is the default.
			event.Status = 180
		}

	case dialog.EventAnswered:
		event.SDPAnswer = string(effect.Body)
		if answered := d.AnsweredAt(); !answered.IsZero() {
			// Post-dial delay. A negative value is impossible by construction and is dropped rather
			// than sent.
			if setup := answered.Sub(d.CreatedAt()); setup > 0 {
				event.SetupMs = int(setup / time.Millisecond)
			}
		}

	case dialog.EventHeld, dialog.EventResumed:
		// Read back off the dialog rather than re-parsed from the body: internal/dialog already
		// committed it, and parsing the same bytes twice is two chances to disagree.
		event.Direction = d.RemoteDirection()

	case dialog.EventTerminated:
		event.Cause = effect.Cause
		event.Termination = effect.Termination
		event.Initiator = d.Initiator()
		event.CauseFromReasonHeader = d.CauseFromReasonHeader()
		if answered := d.AnsweredAt(); !answered.IsZero() {
			ended := d.EndedAt()
			if ended.IsZero() {
				ended = now
			}
			if billed := ended.Sub(answered); billed > 0 {
				event.AnsweredForSeconds = int(billed / time.Second)
			}
		}
	}
	return event
}

// respondToInvite writes a response on the INVITE server transaction. It also owns the two
// consequences of writing a 2xx: the RFC 6026 retransmission loop and the ring timer's cancellation.
func (e *executor) respondToInvite(d *dialog.Dialog, effect dialog.Effect) error {
	if e.state.inviteTx == nil || e.state.invite == nil {
		return errors.New("invite: no INVITE transaction to respond on")
	}
	res := sip.NewResponseFromRequest(e.state.invite, effect.Status, effect.Reason, effect.Body)
	// Our To tag, on every response above 100: sipgo would otherwise mint one of its own without
	// telling us, and the 180 and the 200 must carry the same tag or the far end sees two early
	// dialogs, one of which never ends.
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
		// RFC 3891 §3: the replaced dialog ends when the replacement is accepted, not when its
		// INVITE arrived — tearing down on arrival and then failing to answer leaves no call at all.
		if e.state.replacesLegID != "" {
			replaced := e.state.replacesLegID
			e.state.replacesLegID = ""
			handler := e.handler
			handler.backgroundWork.Go(func() { handler.completeReplaces(replaced) })
		}
	}
	return nil
}

// respondToPending answers the mid-dialog request currently being processed.
func (e *executor) respondToPending(d *dialog.Dialog, effect dialog.Effect) error {
	if e.state.pendingTx == nil || e.state.pending == nil {
		return errors.New("invite: no pending request to respond to")
	}
	res := sip.NewResponseFromRequest(e.state.pending, effect.Status, effect.Reason, effect.Body)
	answeredInvite := e.state.pending.Method == sip.INVITE && effect.Status >= 200 && effect.Status < 300
	if answeredInvite {
		res.AppendHeader(&sip.ContactHeader{Address: e.handler.contact})
	}
	if len(effect.Body) > 0 {
		res.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	res.AppendHeader(sip.NewHeader("Server", e.handler.server))
	err := e.state.pendingTx.Respond(res)
	if err == nil && answeredInvite {
		e.startRetransmit(d, res)
	}
	e.state.pending, e.state.pendingTx = nil, nil
	return err
}

// startRetransmit runs RFC 6026's 2xx-until-ACK loop.
//
// An INVITE server transaction terminates when a 2xx is sent (RFC 3261 §17.2.1), so nobody but the
// TU retransmits it. The interval doubles from T1 to T2 and the loop gives up at 64×T1, where RFC
// 3261 §13.3.1.4 calls for a BYE — the TimeoutAck trigger.
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

	handler.backgroundWork.Go(func() {
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
				interval = min(interval*2, handler.retransmitCap)
			}
			timer.Reset(interval)
		}
	})
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

// armSessionTimer sets the RFC 4028 deadline for this side: the refresher arms the refresh point
// (half the interval), the other side arms the expiry.
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
	if requester, ok := e.handler.requester.(interface {
		SendAndWait(context.Context, *sip.Request) error
	}); ok {
		legID := d.LegID
		e.handler.backgroundWork.Go(func() {
			waitCtx, cancel := context.WithTimeout(e.handler.baseCtx, 32*time.Second)
			defer cancel()
			if err := requester.SendAndWait(waitCtx, req); err != nil {
				e.handler.log.Warn("SIP teardown did not receive a final response", "legId", legID)
			}
			e.handler.post(legID, dialog.Input{Trigger: dialog.TriggerTeardownComplete})
		})
		return nil
	}
	return e.handler.requester.Send(ctx, req)
}

func (e *executor) sendCancel(ctx context.Context) error {
	if e.state.invite == nil {
		return errors.New("invite: no INVITE to cancel")
	}
	return e.handler.requester.Send(ctx, buildCancel(e.state.invite))
}

func (e *executor) sendAck(ctx context.Context, d *dialog.Dialog, effect dialog.Effect) error {
	// An ACK carries the INVITE's own CSeq number, not a new one (RFC 3261 §13.2.2.4).
	req := buildAck(d, e.state.local, e.state.remote, e.state.localCSeq,
		effect.Body, e.state.profile.NAT, e.handler.contact)
	return e.handler.requester.Send(ctx, req)
}

// parseInt is strconv.Atoi with the error kept, for the DTMF duration field.
func parseInt(raw string) (int, error) { return strconv.Atoi(raw) }
