package dialog

import (
	"errors"
	"strings"
	"time"
)

// TimeoutKind says which deadline fired, because "the dialog timed out" is four different calls
// with four different causes and two different teardown methods.
type TimeoutKind int

const (
	// TimeoutInvite is Timer B on a UAC INVITE: no response of any kind in 64×T1. Q.850 18, "no
	// user responding" — the far end never even acknowledged the attempt.
	TimeoutInvite TimeoutKind = iota
	// TimeoutAck is RFC 3261 §13.3.1.4: our 2xx was retransmitted for 64×T1 and never ACKed. The
	// RFC's own instruction is to send a BYE, and the cause is a timer expiry rather than a normal
	// clearing because nothing about it was normal.
	TimeoutAck
	// TimeoutSession is RFC 4028 §10: the session-expiry deadline passed without a refresh. A BYE
	// goes out, because the point of a session timer is that a half-dead call is torn down by
	// somebody.
	TimeoutSession
	// TimeoutRing is the engine's ring timeout arriving here rather than as a hangup command —
	// the belt-and-braces path for an engine that stopped answering mid-walk.
	TimeoutRing
)

// String renders the timeout kind for logs.
func (k TimeoutKind) String() string {
	switch k {
	case TimeoutInvite:
		return "invite"
	case TimeoutAck:
		return "ack"
	case TimeoutSession:
		return "session"
	case TimeoutRing:
		return "ring"
	default:
		return "unknown"
	}
}

// Input is one trigger plus everything the machine needs to decide the effects.
//
// It is one struct rather than a per-trigger method because the owner of a dialog reads its inputs
// off a single mailbox channel (design §4.4), and a channel of one type is the reason exactly one
// of a racing CANCEL and a racing answer can win.
type Input struct {
	Trigger Trigger
	// Status and Reason are the response line, for the triggers that carry one.
	Status int
	Reason string
	// Body is the SDP on the message, opaque here.
	Body []byte
	// Cause overrides the derived Q.850 cause. `rpc.sip.v1.hangup` sets it; everything else leaves
	// it zero and lets the message decide.
	Cause int
	// CauseFromReasonHeader says the Cause above was READ off an RFC 3326 `Reason` header rather
	// than chosen. It is the one bit that lets a consumer prefer stated evidence over derived
	// evidence, and re-deriving the cause from the status code when the far end told us plainly
	// would be discarding better evidence for worse.
	CauseFromReasonHeader bool
	// RemoteTag is the far end's tag on the message that triggered this, used to tell a
	// retransmitted 2xx from a forked one (design §9.7).
	RemoteTag string
	// Timeout says which deadline fired, for TriggerTimeout.
	Timeout TimeoutKind
	// At is the instant to record. Zero means "now" from the dialog's own clock, which the tests
	// replace.
	At time.Time
}

// Outcome is what one Apply did: where the dialog moved, and what the owner must now do.
type Outcome struct {
	From    State
	To      State
	Effects []Effect
}

// Has reports whether the outcome contains an effect of the given kind. It exists for the tests and
// for the two places in the runtime that branch on "did this produce a BYE".
func (o Outcome) Has(kind EffectKind) bool {
	for _, effect := range o.Effects {
		if effect.Kind == kind {
			return true
		}
	}
	return false
}

// Dialog is one SIP dialog and everything this edge knows about it.
//
// # Not safe for concurrent use, deliberately
//
// One goroutine owns one dialog. See the package comment: that is what makes the races decidable
// rather than lucky. The Store is the shared thing and it is locked; a Dialog handed out by the
// Store is handed to exactly one owner.
type Dialog struct {
	// LegID is THE key: the engine's channel id, mediad's sessionId and this dialog's handle, all
	// one string (design §3.1). Never derived from anything the far end chose.
	LegID string
	// OrgID is the tenant, resolved by admission and never guessed here. It is empty between the
	// INVITE arriving and the engine answering, which is exactly why the `sip.evt.v1` family starts
	// after admission (design §4.2) — no event can be published without it.
	OrgID string
	// CallID is the engine's call id, not the SIP Call-ID. The SIP one is on Identity.
	CallID string
	// TrunkID is set when this dialog came from (or goes to) a carrier rather than a registered
	// endpoint. Its presence is what makes the routing context trunk-capable, which is the
	// toll-fraud boundary (design §8.3).
	TrunkID string
	// Role is which end of the INVITE we are.
	Role Role
	// Identity is the SIP dialog triple. Data, never the key.
	Identity Identity
	// Target is where mid-dialog requests go, both as stated and as observed.
	Target Target
	// Profile names the listener profile this dialog arrived on (internal or external), so a
	// mid-dialog decision can apply the same policy the initial request was admitted under.
	Profile string

	state State
	// cause and termination are set by whichever path ends the dialog, and read by the one place
	// that publishes the terminal event.
	cause       int
	termination TerminationReason
	// initiator is WHO ended it, which is a different question from how and cannot be derived from
	// the reason: a `rejected` is ours when we refused admission and theirs when they answered 486,
	// and a CDR that cannot tell those apart cannot tell a blocked call from a busy one.
	initiator Initiator
	// causeFromReasonHeader records that the Q.850 cause came off an RFC 3326 `Reason` header rather
	// than being derived from a status code. It travels on the terminal event because a cause the
	// far end STATED is better evidence than one this edge inferred, and a consumer that cannot tell
	// them apart cannot know which of two disagreeing CDRs to believe.
	causeFromReasonHeader bool
	// terminalPublished stops the terminal event being emitted twice when two paths end one dialog
	// — a BYE crossing our BYE is the ordinary case, and two `leg-ended` events for one leg is two
	// CDR rows for one call.
	terminalPublished bool

	// hangupRequested records that the engine has asked for this leg to end. It survives a state
	// change, which is what makes the UAC hangup/200 race come out right: a hangup issued while the
	// INVITE was still ringing must still end the call if a 2xx lands first.
	hangupRequested bool
	// byeDeferred is RFC 3261 §15's owed BYE, released by the ACK or by TimeoutAck.
	byeDeferred bool
	// cancelDeferred is RFC 3261 §9.1's owed CANCEL, released by the first provisional response.
	cancelDeferred bool

	createdAt  time.Time
	answeredAt time.Time
	endedAt    time.Time

	// offer is the offer/answer and hold bookkeeping. See offer.go.
	offer offerState
	// timer is the RFC 4028 negotiation result, zero when session timers are not in use.
	timer SessionTimer

	now func() time.Time
}

// Options constructs a Dialog. Every field a test needs to control is here, and nothing is read
// from a package-level variable.
type Options struct {
	LegID    string
	OrgID    string
	CallID   string
	TrunkID  string
	Role     Role
	Identity Identity
	Target   Target
	Profile  string
	// Now is injectable so expiry and duration behaviour is testable without sleeping.
	Now func() time.Time
}

// ErrNoLegID refuses a dialog with no key. It is a wiring error rather than a wire condition: a
// dialog that cannot be addressed is one the engine can never hang up.
var ErrNoLegID = errors.New("dialog: a legId is required")

// New builds a dialog in StateInit.
func New(opts Options) (*Dialog, error) {
	if strings.TrimSpace(opts.LegID) == "" {
		return nil, ErrNoLegID
	}
	if opts.Identity.SIPCallID == "" {
		return nil, ErrNoIdentity
	}
	dialog := &Dialog{
		LegID:    opts.LegID,
		OrgID:    opts.OrgID,
		CallID:   opts.CallID,
		TrunkID:  opts.TrunkID,
		Role:     opts.Role,
		Identity: opts.Identity,
		Target:   opts.Target,
		Profile:  opts.Profile,
		state:    StateInit,
		now:      opts.Now,
	}
	if dialog.now == nil {
		dialog.now = time.Now
	}
	dialog.createdAt = dialog.now()
	return dialog, nil
}

// State reports where the dialog is.
func (d *Dialog) State() State { return d.state }

// Cause reports the Q.850 cause recorded so far. Zero until something has an opinion.
func (d *Dialog) Cause() int { return d.cause }

// Termination reports how the dialog ended, empty until it has.
func (d *Dialog) Termination() TerminationReason { return d.termination }

// Initiator reports WHO ended the dialog, empty until it has ended.
func (d *Dialog) Initiator() Initiator { return d.initiator }

// CauseFromReasonHeader reports whether the recorded Q.850 cause was stated by the far end in an
// RFC 3326 `Reason` header rather than derived here from a status code.
func (d *Dialog) CauseFromReasonHeader() bool { return d.causeFromReasonHeader }

// CreatedAt, AnsweredAt and EndedAt are the three instants a CDR row is built from. AnsweredAt is
// the ACK for a UAS leg and the 2xx for a UAC leg, which is what makes `billsec` start where the
// caller started paying rather than where the bridge happened to be built.
func (d *Dialog) CreatedAt() time.Time  { return d.createdAt }
func (d *Dialog) AnsweredAt() time.Time { return d.answeredAt }
func (d *Dialog) EndedAt() time.Time    { return d.endedAt }

// HangupRequested reports whether the engine has asked for this leg to end. The command handler
// reads it so a second `rpc.sip.v1.hangup` is idempotent rather than a second BYE.
func (d *Dialog) HangupRequested() bool { return d.hangupRequested }

// Apply feeds one trigger to the machine and returns what the owner must do.
//
// The contract is narrow on purpose: it mutates the dialog, it touches nothing else, and every
// refusal is one of the four package errors so the command layer can turn it into a refusal reason
// without a state comparison of its own.
func (d *Dialog) Apply(in Input) (Outcome, error) {
	from := d.state
	at := in.At
	if at.IsZero() {
		at = d.now()
	}

	if in.CauseFromReasonHeader {
		// Latched rather than assigned: it accompanies the cause, and the cause is first-write-wins.
		d.causeFromReasonHeader = true
	}

	next, err := transition(d.Role, d.state, in.Trigger)
	if err != nil {
		// One refusal is not a plain refusal: a CANCEL that lost the race still has a transaction
		// waiting for an answer, and leaving it unanswered makes the far end retransmit a CANCEL at
		// a call that is up.
		if errors.Is(err, ErrCancelTooLate) {
			return Outcome{
				From: from,
				To:   d.state,
				Effects: []Effect{{
					Kind:   EffectRespondToCancel,
					Status: 481,
					Reason: "Call/Transaction Does Not Exist",
					Detail: "the 200 had already gone out; the correct teardown is a BYE",
				}},
			}, err
		}
		// A refused IN-DIALOG REQUEST still has a transaction waiting, and a refusal is always a
		// reply and never a silence: a BYE that goes unanswered is retransmitted at us for
		// thirty-two seconds by a far end that believes it has hung up.
		if isRemoteRequest(in.Trigger) {
			return Outcome{
				From: from,
				To:   d.state,
				Effects: []Effect{{
					Kind:   EffectRespondToRequest,
					Status: 481,
					Reason: "Call/Transaction Does Not Exist",
					Detail: "the dialog is not in a state that can take a " + in.Trigger.String(),
				}},
			}, err
		}
		return Outcome{From: from, To: d.state}, err
	}

	effects := d.effectsFor(in, from, next, at)
	d.state = next
	if next == StateTerminated && d.endedAt.IsZero() {
		d.endedAt = at
	}
	return Outcome{From: from, To: next, Effects: effects}, nil
}

// effectsFor is the second half of the machine: what to DO, given that the move is legal.
//
// It is separate from `transition` so the table stays a table. Everything here reads the input's
// data — a status, an SDP body, a cause — which the table deliberately does not have.
func (d *Dialog) effectsFor(in Input, from, next State, at time.Time) []Effect {
	switch in.Trigger {
	case TriggerLocalTrying:
		if from != StateInit {
			return nil // a second 100 changes nothing and is not worth a packet
		}
		return []Effect{{Kind: EffectRespond, Status: 100, Reason: "Trying"}}

	case TriggerLocalRing:
		status, reason := 180, "Ringing"
		if in.Status != 0 {
			status, reason = in.Status, in.Reason
		}
		return []Effect{
			{Kind: EffectRespond, Status: status, Reason: reason},
			publish(EventProgressed),
		}

	case TriggerLocalEarlyMedia:
		// A 183 with an answer COMMITS the offer/answer exchange, and the subsequent 200 must repeat
		// the same answer (RFC 3261 §13.2.1). Recording it here is what makes that repetition
		// automatic rather than a thing somebody remembers.
		d.offer.commitAnswer(in.Body)
		return []Effect{
			{Kind: EffectRespond, Status: 183, Reason: "Session Progress", Body: in.Body},
			{Kind: EffectPublish, Event: EventProgressed, Detail: "early media"},
		}

	case TriggerLocalAnswer:
		body := in.Body
		if body == nil {
			// The answer was already committed by a 183. Repeating it is required, and repeating it
			// from our own record is the only way to be sure it is byte-identical.
			body = d.offer.committedAnswer()
		}
		d.offer.commitAnswer(body)
		// No `answered` event yet: for a UAS the call is up when the ACK arrives, not when the 200
		// is written (design §3.3). Publishing here would start `billsec` before the caller's phone
		// had confirmed it heard us.
		return []Effect{{Kind: EffectRespond, Status: 200, Reason: "OK", Body: body}}

	case TriggerLocalReject:
		cause := d.resolveCause(in, CauseCallRejected)
		status, reason := in.Status, in.Reason
		if status == 0 {
			status, reason = StatusForCause(cause)
		}
		d.recordTermination(cause, ReasonRejected, InitiatorLocal, at)
		return append([]Effect{{Kind: EffectRespond, Status: status, Reason: reason}},
			d.terminalEffects(cause, ReasonRejected)...)

	case TriggerLocalHangup:
		return d.hangupEffects(in, from, at)

	case TriggerLocalAck:
		if from != StateEstablished {
			// A re-ACK for a retransmitted 2xx. Required by RFC 3261 §13.2.2.4 and nothing more.
			return []Effect{{Kind: EffectSendAck}}
		}
		return []Effect{{Kind: EffectSendAck}}

	case TriggerRemoteAck:
		effects := []Effect{}
		if from == StateEstablished {
			d.answeredAt = at
			effects = append(effects, Effect{Kind: EffectPublish, Event: EventAnswered})
			if d.timer.Negotiated() {
				effects = append(effects, Effect{Kind: EffectStartSessionTimer})
			}
		}
		if d.byeDeferred {
			// RFC 3261 §15's wait is over: the ACK arrived, so the BYE we owed may go out.
			d.byeDeferred = false
			effects = append(effects, Effect{
				Kind:   EffectSendBye,
				Cause:  d.cause,
				Detail: "the deferred BYE, released by the ACK (RFC 3261 §15)",
			})
		}
		return effects

	case TriggerRemoteBye:
		cause := in.Cause
		if cause == 0 {
			cause = CauseNormalClearing
		}
		effects := []Effect{{Kind: EffectRespondToRequest, Status: 200, Reason: "OK"}}
		if from == StateEstablished {
			// The far end BYEd a 2xx it never ACKed. It plainly received the 2xx, so retransmitting
			// it for another 30 seconds is noise aimed at a phone that has hung up.
			effects = append(effects, Effect{
				Kind:   EffectStopRetransmit,
				Detail: "a BYE before the ACK is proof the 2xx arrived",
			})
		}
		d.recordTermination(cause, ReasonBye, InitiatorRemote, at)
		return append(effects, d.terminalEffects(cause, ReasonBye)...)

	case TriggerRemoteCancel:
		// sipgo's transaction layer has already answered the CANCEL 200 and driven the INVITE
		// transaction to 487 (`sip/transaction_layer.go:154-185`). What it does NOT do is tell
		// anybody, which is the whole reason this trigger exists.
		d.recordTermination(CauseNormalClearing, ReasonCancelled, InitiatorRemote, at)
		return d.terminalEffects(CauseNormalClearing, ReasonCancelled)

	case TriggerRemoteProvisional:
		if d.cancelDeferred {
			// RFC 3261 §9.1's wait is over: there is now a transaction the far end will recognise a
			// CANCEL against.
			d.cancelDeferred = false
			return []Effect{{
				Kind:   EffectSendCancel,
				Cause:  d.cause,
				Detail: "the deferred CANCEL, released by the first provisional (RFC 3261 §9.1)",
			}}
		}
		return nil

	case TriggerRemoteEarly:
		d.Identity.RemoteTag = in.RemoteTag
		effects := []Effect{}
		if d.cancelDeferred {
			d.cancelDeferred = false
			effects = append(effects, Effect{Kind: EffectSendCancel, Cause: d.cause})
		}
		detail := ""
		if len(in.Body) > 0 {
			d.offer.commitAnswer(in.Body)
			detail = "early media"
		}
		return append(effects, Effect{Kind: EffectPublish, Event: EventProgressed, Detail: detail})

	case TriggerRemoteAnswer:
		return d.remoteAnswerEffects(in, from, at)

	case TriggerRemoteFailure:
		cause := d.resolveCause(in, CauseForStatus(in.Status))
		d.recordTermination(cause, ReasonRejected, InitiatorRemote, at)
		// No ACK effect: sipgo's client transaction ACKs a non-2xx itself (RFC 3261 §17.1.1.3), and
		// a second ACK from here would be a stray message on a dead transaction.
		return d.terminalEffects(cause, ReasonRejected)

	case TriggerTeardownComplete:
		cause := d.cause
		if cause == 0 {
			cause = CauseNormalClearing
		}
		reason := d.termination
		if reason == "" {
			reason = ReasonBye
		}
		d.recordTermination(cause, reason, d.initiator, at)
		return d.terminalEffects(cause, reason)

	case TriggerTimeout:
		return d.timeoutEffects(in, from, at)
	}
	return nil
}

// hangupEffects turns `rpc.sip.v1.hangup` into the right method for the state.
//
// This is the whole of design §10.3's "sipd chooses the method": a BYE if confirmed, a CANCEL if we
// are a UAC in an early dialog, a failure response if we are a UAS that has not answered. The
// engine says "end this leg with this cause" and nothing more, which is exactly what
// MediaPort.hangup(channelId, cause) already says.
func (d *Dialog) hangupEffects(in Input, from State, at time.Time) []Effect {
	cause := d.resolveCause(in, CauseNormalClearing)
	alreadyRequested := d.hangupRequested
	d.hangupRequested = true
	d.cause = cause
	// Recorded HERE and not only at the terminal event, because the paths that end a BYE-shaped
	// hangup — TriggerTeardownComplete, and the ACK that releases a deferred BYE — arrive later with
	// no memory of who asked. Without this the engine's own hangup would be filed as `timer`.
	if d.initiator == "" {
		d.initiator = InitiatorLocal
	}

	switch from {
	case StateInit, StateProceeding, StateEarly:
		if d.Role == RoleUAS {
			// Nothing has been answered, so the honest end is a failure response on the INVITE
			// transaction. 487 is reserved for a CANCEL we actually received; a hangup from the
			// engine is a decision, not a caller giving up.
			status, reason := StatusForCause(cause)
			d.recordTermination(cause, ReasonRejected, InitiatorLocal, at)
			return append([]Effect{{Kind: EffectRespond, Status: status, Reason: reason}},
				d.terminalEffects(cause, ReasonRejected)...)
		}
		if from == StateInit {
			// RFC 3261 §9.1: a CANCEL before any provisional has nothing to match. Wait for the
			// 100, which the first hop sends immediately.
			d.cancelDeferred = true
			return []Effect{{Kind: EffectDeferCancel, Cause: cause,
				Detail: "no provisional response yet (RFC 3261 §9.1)"}}
		}
		return []Effect{{Kind: EffectSendCancel, Cause: cause}}

	case StateEstablished:
		if d.Role == RoleUAS {
			// RFC 3261 §15: a UAS MUST NOT send a BYE until it has received the ACK for its 2xx.
			// Sending one now produces a BYE the far end answers 481 while it is still trying to
			// ACK, and a call that neither side can end.
			d.byeDeferred = true
			return []Effect{{Kind: EffectDeferBye, Cause: cause,
				Detail: "the 2xx has not been ACKed yet (RFC 3261 §15)"}}
		}
		// UAC: we received a 2xx and have not ACKed it. RFC 3261 §13.2.2.4 requires the ACK
		// regardless, and only then may the BYE go out.
		return []Effect{
			{Kind: EffectSendAck, Detail: "the ACK owed for the 2xx, before any BYE"},
			{Kind: EffectSendBye, Cause: cause},
		}

	case StateConfirmed:
		return []Effect{{Kind: EffectSendBye, Cause: cause}, {Kind: EffectStopSessionTimer}}

	default: // StateTerminating
		if alreadyRequested {
			// Idempotent on legId, exactly as design §4.6 requires: a timed-out `hangup` may be
			// reissued and the second one must not produce a second BYE.
			return nil
		}
		return nil
	}
}

// remoteAnswerEffects handles a 2xx to our INVITE, including the two races that live here.
func (d *Dialog) remoteAnswerEffects(in Input, from State, at time.Time) []Effect {
	if from == StateEstablished || from == StateConfirmed {
		if in.RemoteTag != "" && in.RemoteTag != d.Identity.RemoteTag {
			// A second 2xx from a different branch: a carrier's forking proxy answered twice. RFC
			// 3261 §13.2.2.4 still requires the ACK, and the BYE follows immediately because the
			// call is already up on the branch that won. Answering with silence leaks a dialog at
			// the far end and, on some carriers, bills for it (design §9.7).
			return []Effect{{
				Kind:   EffectAckAndBye,
				Cause:  CauseNormalClearing,
				Detail: "a second 2xx from a forked branch we did not take",
			}}
		}
		// A retransmission of the 2xx we already have. Re-ACK and nothing else.
		return []Effect{{Kind: EffectSendAck}}
	}

	d.Identity.RemoteTag = in.RemoteTag
	d.answeredAt = at
	if len(in.Body) > 0 {
		d.offer.commitAnswer(in.Body)
	}
	effects := []Effect{
		{Kind: EffectSendAck, Body: d.offer.ackBody()},
		// For a UAC the call is up at the 2xx, not at the ACK (design §3.3): the far end has
		// committed and the media is already flowing towards us.
		{Kind: EffectPublish, Event: EventAnswered},
	}
	if d.timer.Negotiated() {
		effects = append(effects, Effect{Kind: EffectStartSessionTimer})
	}
	if d.hangupRequested {
		// The hangup raced the answer and the answer won. The call is up for as long as it takes to
		// tear it down properly — ACK first, then BYE — which is the only sequence the far end will
		// accept (RFC 3261 §13.2.2.4 and §15).
		d.cancelDeferred = false
		effects = append(effects, Effect{
			Kind:   EffectSendBye,
			Cause:  d.cause,
			Detail: "a hangup that raced the 200 and lost; the CANCEL is moot",
		})
	}
	return effects
}

// timeoutEffects turns an expired deadline into the right teardown.
func (d *Dialog) timeoutEffects(in Input, from State, at time.Time) []Effect {
	switch in.Timeout {
	case TimeoutInvite:
		d.recordTermination(CauseNoUserResponse, ReasonTimeout, InitiatorTimer, at)
		return d.terminalEffects(CauseNoUserResponse, ReasonTimeout)

	case TimeoutAck:
		// RFC 3261 §13.3.1.4: when the 2xx has been retransmitted for 64×T1 with no ACK, the UAS
		// SHOULD send a BYE. The dialog exists — the far end just never confirmed it.
		d.recordTermination(CauseRecoveryOnTimerExpire, ReasonTimeout, InitiatorTimer, at)
		effects := []Effect{
			{Kind: EffectSendBye, Cause: CauseRecoveryOnTimerExpire,
				Detail: "the 2xx was never ACKed (RFC 3261 §13.3.1.4)"},
			{Kind: EffectStopRetransmit},
		}
		return append(effects, d.terminalEffects(CauseRecoveryOnTimerExpire, ReasonTimeout)...)

	case TimeoutSession:
		// RFC 4028 §10: the refresh never came. Whoever notices tears the call down, and the Reason
		// header says which timer did it so the far end's CDR agrees with ours.
		d.recordTermination(CauseRecoveryOnTimerExpire, ReasonTimeout, InitiatorTimer, at)
		effects := []Effect{
			{Kind: EffectSendBye, Cause: CauseRecoveryOnTimerExpire,
				Detail: "the session timer expired (RFC 4028 §10)"},
			{Kind: EffectStopSessionTimer},
		}
		return append(effects, d.terminalEffects(CauseRecoveryOnTimerExpire, ReasonTimeout)...)

	default: // TimeoutRing
		d.recordTermination(CauseNoAnswer, ReasonTimeout, InitiatorTimer, at)
		switch {
		case d.Role == RoleUAS && !from.Answered():
			status, reason := StatusForCause(CauseNoAnswer)
			return append([]Effect{{Kind: EffectRespond, Status: status, Reason: reason}},
				d.terminalEffects(CauseNoAnswer, ReasonTimeout)...)
		case d.Role == RoleUAC && !from.Answered():
			return append([]Effect{{Kind: EffectSendCancel, Cause: CauseNoAnswer}},
				d.terminalEffects(CauseNoAnswer, ReasonTimeout)...)
		default:
			return append([]Effect{{Kind: EffectSendBye, Cause: CauseNoAnswer}},
				d.terminalEffects(CauseNoAnswer, ReasonTimeout)...)
		}
	}
}

// resolveCause picks the Q.850 cause for an input: the caller's explicitly, otherwise the default
// the call site derived from the message.
func (d *Dialog) resolveCause(in Input, fallback int) int {
	if in.Cause > 0 {
		return in.Cause
	}
	return fallback
}

// recordTermination stamps how, why, by whom and when the dialog ended, without publishing
// anything.
//
// The FIRST recording wins, for every field. A BYE crossing our own BYE is the ordinary
// simultaneous-hangup case, and the honest account of that call is the one that reached the machine
// first — re-stamping it would make a call the engine ended read as a call the caller ended, which
// is the difference a support desk is looking at when it asks "who hung up".
func (d *Dialog) recordTermination(
	cause int,
	reason TerminationReason,
	initiator Initiator,
	at time.Time,
) {
	if d.cause == 0 || d.termination == "" {
		d.cause = cause
		d.termination = reason
		if initiator != "" {
			d.initiator = initiator
		}
	}
	if d.endedAt.IsZero() {
		d.endedAt = at
	}
}

// terminalEffects emits the terminal event and releases the claim, exactly once per dialog.
//
// Once, and the guard is not defensive programming: a BYE crossing our own BYE is the ordinary
// simultaneous-hangup case, and two terminal events for one leg is two CDR rows for one call.
func (d *Dialog) terminalEffects(cause int, reason TerminationReason) []Effect {
	if d.terminalPublished {
		return nil
	}
	d.terminalPublished = true
	effects := []Effect{terminated(cause, reason)}
	if d.timer.Negotiated() {
		effects = append(effects, Effect{Kind: EffectStopSessionTimer})
	}
	return append(effects, Effect{Kind: EffectReleaseClaim})
}

// isRemoteRequest reports whether a trigger arrived as a SIP REQUEST from the far end, and
// therefore has a server transaction owed an answer.
//
// A CANCEL is deliberately not on the list: it has its own refusal path (ErrCancelTooLate) with its
// own status, and folding the two together would answer a losing CANCEL 481 for the right reason
// with the wrong explanation in the log.
func isRemoteRequest(trigger Trigger) bool {
	switch trigger {
	case TriggerRemoteBye:
		return true
	default:
		return false
	}
}
