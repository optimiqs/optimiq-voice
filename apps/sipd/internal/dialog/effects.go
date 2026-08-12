package dialog

// DialogEvent is one member of the `sip.evt.v1` family (design §10.2).
//
// The values are the dotted event token that goes in the subject —
// `sip.evt.v1.<orgId>.<legId>.dialog.answered` — so the string here is the string on the wire and
// there is no second spelling to keep in step. The subject BUILDER belongs in packages/events-go
// alongside every other family's; until it lands, this is the vocabulary and nothing publishes.
type DialogEvent string

const (
	// EventProgressed is a 18x: ringing, or early when the response carried SDP.
	EventProgressed DialogEvent = "dialog.progressed"
	// EventAnswered is the ACK for a UAS leg and the 2xx for a UAC leg (design §3.3). The
	// asymmetry is not sloppiness — it is the moment the call is genuinely up in each direction,
	// and `billsec` counts from it.
	EventAnswered DialogEvent = "dialog.answered"
	// EventHeld is a re-INVITE or UPDATE that moved the far end to sendonly or inactive.
	EventHeld DialogEvent = "dialog.held"
	// EventResumed is the same transition back to sendrecv or recvonly.
	EventResumed DialogEvent = "dialog.resumed"
	// EventTerminated carries a real Q.850 cause, which is the one thing this plane knows and a
	// media plane cannot (design §3.3).
	EventTerminated DialogEvent = "dialog.terminated"
	// EventDTMF is SIP INFO digits only. RFC 4733 is mediad's.
	EventDTMF DialogEvent = "dialog.dtmf"
)

// TerminationReason says WHICH way a dialog ended, alongside the Q.850 cause that says why.
//
// Two fields rather than one because they answer different questions and a consumer needs both: a
// `cancelled` and a `rejected` can both carry cause 16, and a CDR that cannot tell them apart
// cannot tell a caller who hung up from a callee who declined.
type TerminationReason string

const (
	// ReasonBye is the ordinary end of a call: somebody sent a BYE.
	ReasonBye TerminationReason = "bye"
	// ReasonCancelled is a CANCEL that arrived in time.
	ReasonCancelled TerminationReason = "cancelled"
	// ReasonRejected is a final failure response — ours to a caller, or theirs to our INVITE.
	ReasonRejected TerminationReason = "rejected"
	// ReasonTimeout is any expired timer: Timer B, an unACKed 2xx, an RFC 4028 session expiry.
	ReasonTimeout TerminationReason = "timeout"
	// ReasonReplaced is an RFC 3891 Replaces that completed: this dialog was torn down because
	// another one took its place (design's S-replaces rung).
	ReasonReplaced TerminationReason = "replaced"
	// ReasonInstanceLost is design §6.2's reaping path: a surviving instance found an expired claim
	// and published the termination its owner never got to. The engine writes a CDR from a
	// `leg-ended` it would otherwise never have received.
	ReasonInstanceLost TerminationReason = "instance-lost"
	// ReasonShuttingDown is a drain that ran out of patience.
	ReasonShuttingDown TerminationReason = "shutting-down"
)

// Initiator says WHO ended a dialog, alongside the reason that says how and the cause that says
// why.
//
// A third field rather than a refinement of the second, because the reason and the initiator are
// genuinely independent: a `rejected` is LOCAL when this edge refused admission and REMOTE when the
// far end answered `486 Busy Here`, and both carry Q.850 17. A CDR that folded them together could
// not tell a call the platform blocked from a call the callee declined — which is the first question
// asked about every disputed minute.
//
// The values are the contract's verbatim (`SIPDialogTerminatedInitiator`), so the string here is the
// string on the wire and there is no second spelling to keep in step.
type Initiator string

const (
	// InitiatorLocal is this side: an admission refusal, an `rpc.sip.v1.hangup`, a drain.
	InitiatorLocal Initiator = "local"
	// InitiatorRemote is the far end: a BYE, a CANCEL, a final failure response to our INVITE.
	InitiatorRemote Initiator = "remote"
	// InitiatorTimer is nobody: Timer B, an unACKed 2xx, an RFC 4028 expiry, a ring timeout, or a
	// reaper finding an expired claim. It is separate from `local` because "our timer fired" and "we
	// decided" are the same actor and completely different incidents.
	InitiatorTimer Initiator = "timer"
)

// Valid reports whether the initiator is one of the three the contract knows.
func (i Initiator) Valid() bool {
	return i == InitiatorLocal || i == InitiatorRemote || i == InitiatorTimer
}

// EffectKind is one thing the owner of a dialog must DO as a result of a trigger.
//
// # Why effects rather than method calls
//
// The state machine returns a description of what should happen and touches no socket. That is what
// makes a CANCEL racing an answer testable as a table: the race is decided by the ORDER two
// triggers reach one goroutine, and the proof is which effects come back, not what a mock saw. It
// also keeps the sipgo API surface — which changes between minor versions — out of the part of this
// package that encodes the RFC, which does not.
type EffectKind int

const (
	// EffectRespond writes a response on the INVITE server transaction. UAS only.
	EffectRespond EffectKind = iota
	// EffectRespondToRequest answers a mid-dialog request's own transaction — the 200 to a BYE, the
	// 200 to an UPDATE. Distinct from EffectRespond because it targets a different transaction, and
	// answering the wrong one is a call that hangs.
	EffectRespondToRequest
	// EffectRespondToCancel answers a CANCEL's own transaction. The only status it ever carries is
	// 481, for the CANCEL that arrived after the final response (RFC 3261 §9.2); an in-time CANCEL
	// is answered by sipgo's transaction layer before this package hears about it.
	EffectRespondToCancel
	// EffectSendAck sends the ACK for a 2xx we received. UAC only, and mandatory: a 2xx that is
	// never ACKed is retransmitted at us for 32 seconds and then torn down by the far end.
	EffectSendAck
	// EffectSendBye sends a BYE with the dialog's cause in an RFC 3326 Reason header.
	EffectSendBye
	// EffectSendCancel sends a CANCEL for an INVITE we placed and that has not been answered.
	EffectSendCancel
	// EffectDeferBye is RFC 3261 §15 in one word: a hangup was requested on a 2xx we have sent and
	// that has not been ACKed, and a BYE MUST NOT go out until the ACK arrives or the server
	// transaction times out. The owner does nothing now; EffectSendBye follows on the ACK or on the
	// timeout, from this same machine.
	EffectDeferBye
	// EffectDeferCancel is the UAC mirror: a hangup before any provisional response, which RFC 3261
	// §9.1 says must wait, because a CANCEL for a transaction the far end has not acknowledged has
	// nothing to match against.
	EffectDeferCancel
	// EffectAckAndBye answers a 2xx from a branch we did not want — a carrier's forking proxy sent
	// a second one (design §9.7). RFC 3261 §13.2.2.4 requires the ACK anyway, and the BYE follows
	// immediately because we already have a call on the branch that won.
	EffectAckAndBye
	// EffectStopRetransmit stops the RFC 6026 2xx-until-ACK loop early, because the far end has
	// spoken: a BYE arriving before the ACK is proof that the 2xx was received, and retransmitting
	// at a phone that has hung up is 32 seconds of noise.
	EffectStopRetransmit
	// EffectPublish emits one `sip.evt.v1` event.
	EffectPublish
	// EffectReleaseClaim drops this dialog's `sip-dialogs` record. Always last, and always paired
	// with a terminal publish: releasing before the event would leave a window in which a reaper
	// could not find the dialog and the engine had not yet been told it ended.
	EffectReleaseClaim
	// EffectStartSessionTimer arms (or re-arms) the RFC 4028 refresh or expiry timer negotiated on
	// this dialog. See timers.go for which of the two, and why the refresher role decides it.
	EffectStartSessionTimer
	// EffectStopSessionTimer disarms it, on any path that ends the dialog.
	EffectStopSessionTimer
	// EffectSendSessionRefresh is the re-INVITE or UPDATE this side owes because it is the
	// refresher and half the interval has passed.
	EffectSendSessionRefresh
)

// String renders the effect kind for logs and test failures.
func (k EffectKind) String() string {
	switch k {
	case EffectRespond:
		return "respond"
	case EffectRespondToRequest:
		return "respond-to-request"
	case EffectRespondToCancel:
		return "respond-to-cancel"
	case EffectSendAck:
		return "send-ack"
	case EffectSendBye:
		return "send-bye"
	case EffectSendCancel:
		return "send-cancel"
	case EffectDeferBye:
		return "defer-bye"
	case EffectDeferCancel:
		return "defer-cancel"
	case EffectAckAndBye:
		return "ack-and-bye"
	case EffectStopRetransmit:
		return "stop-retransmit"
	case EffectPublish:
		return "publish"
	case EffectReleaseClaim:
		return "release-claim"
	case EffectStartSessionTimer:
		return "start-session-timer"
	case EffectStopSessionTimer:
		return "stop-session-timer"
	case EffectSendSessionRefresh:
		return "send-session-refresh"
	default:
		return "unknown"
	}
}

// Effect is one instruction from the machine to whoever owns the socket.
//
// It is a struct with a kind rather than an interface because the set is closed and small, and
// because a test that asserts on `[]Effect` reads as a list of what happened rather than as a
// sequence of type switches.
type Effect struct {
	Kind EffectKind
	// Status and Reason fill a response's start line.
	Status int
	Reason string
	// Body is the SDP to attach, when there is one. This package never parses it beyond the
	// direction attributes hold needs (see offer.go): sipd holds no codec knowledge in either
	// direction, which is design §5.2's rule and the whole reason mediad exists.
	Body []byte
	// Event, Cause and Termination fill an EffectPublish.
	Event       DialogEvent
	Cause       int
	Termination TerminationReason
	// Detail is free text for the log line that accompanies the effect. It never reaches the wire.
	Detail string
}

// publish is the constructor for a non-terminal event, so the call sites stay one line.
func publish(event DialogEvent) Effect {
	return Effect{Kind: EffectPublish, Event: event}
}

// terminated is the constructor for the one event every teardown path has to emit exactly once.
func terminated(cause int, reason TerminationReason) Effect {
	return Effect{Kind: EffectPublish, Event: EventTerminated, Cause: cause, Termination: reason}
}
