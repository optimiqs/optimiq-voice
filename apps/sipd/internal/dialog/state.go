// Package dialog is sipd's SIP dialog layer: the state machine behind INVITE. sipgo supplies
// sockets, transactions and retransmission timers but no application semantics — no Early state, no
// CANCEL-after-200 rule, no deferred BYE, no glare, no session timers — so those live here as a pure
// state machine, which is what makes the RFC 3261 §13 and §15 races table-testable without a socket,
// a broker or a clock.
//
// Two invariants hold throughout. One string (`legId`) names the leg, the mediad session and this
// dialog (design §3.1); the SIP triple is only an index onto it (identity.go). And a Dialog is NOT
// safe for concurrent use: one goroutine owns one dialog and every input reaches it as a mailbox
// message (design §4.4), so a racing CANCEL and answer have exactly one winner by construction.
// Store is the only shared thing here, and it is locked.
package dialog

import "errors"

// State is where one dialog is in its life. It is finer than sipgo's three values in two
// load-bearing places: Early, because an 18x with a To tag CREATES a dialog a CANCEL can end and an
// UPDATE can retarget (RFC 3261 §12.1); and Terminating, because teardown is not instantaneous and
// what may be sent during it is the sharpest edge in the RFC (§15, §13.2.2.4, §9.2).
type State int32

const (
	// StateInit is a dialog that exists in this process and on no wire yet: a UAS that has received
	// an INVITE and answered nothing, or a UAC whose INVITE has gone out with no response back.
	StateInit State = iota
	// StateProceeding is "a 100 has been sent or received". No tag, therefore still no dialog in the
	// RFC's sense — but a distinct state, because it is the point after which a UAC may CANCEL
	// (RFC 3261 §9.1) and a caller has stopped retransmitting.
	StateProceeding
	// StateEarly is an early dialog: an 18x WITH a To tag has been sent or received.
	StateEarly
	// StateEstablished is "a 2xx has been sent (UAS) or received (UAC)" and the ACK has not been
	// seen. A CANCEL arriving here has already lost, a BYE arriving here must be honoured, and a
	// hangup issued here may not send a BYE yet.
	StateEstablished
	// StateConfirmed is "the ACK has been seen". Billing starts here — `billsec` counts from the
	// ACK, not from the bridge (design §7.4).
	StateConfirmed
	// StateTerminating is "teardown has started and something is still owed": a BYE waiting for its
	// 200, a BYE waiting for the ACK that must precede it, or a CANCEL waiting for its 487.
	StateTerminating
	// StateTerminated is final. Nothing leaves it, and every command against it is refused
	// `dialog_gone` rather than silently ignored.
	StateTerminated
)

// String renders the state as the token that goes on the `sip-dialogs` claim and into logs. The
// spellings match design §6.2's example record where they overlap.
func (s State) String() string {
	switch s {
	case StateInit:
		return "init"
	case StateProceeding:
		return "proceeding"
	case StateEarly:
		return "early"
	case StateEstablished:
		return "established"
	case StateConfirmed:
		return "confirmed"
	case StateTerminating:
		return "terminating"
	case StateTerminated:
		return "terminated"
	default:
		return "unknown"
	}
}

// Alive reports whether the dialog can still carry a command: the check every command handler makes
// before doing anything.
func (s State) Alive() bool { return s != StateTerminated }

// Answered reports whether a 2xx has been committed on this dialog. It decides the METHOD of a
// teardown — BYE if answered, CANCEL or a failure response if not (design §10.3).
func (s State) Answered() bool { return s == StateEstablished || s == StateConfirmed }

// Role is which end of the INVITE this process is. Half the trigger vocabulary is legal for exactly
// one role (roleAllows).
type Role int

const (
	// RoleUAS means the INVITE arrived here: a phone or a carrier called us.
	RoleUAS Role = iota
	// RoleUAC means this process sent the INVITE: the engine originated a B-leg.
	RoleUAC
)

// String renders the role as the token on the claim record (design §6.2: "uas = we answered").
func (r Role) String() string {
	if r == RoleUAC {
		return "uac"
	}
	return "uas"
}

// Trigger is one input to the machine. The names say WHO did the thing, because that is what the
// RFC's races turn on: a CANCEL we receive and a CANCEL we send have different legal windows.
type Trigger int

const (
	// TriggerLocalTrying is the 100 this edge sends before consulting the engine. It is out before
	// the admission RPC, always: a silent engine must not cost the caller a Timer B (design §4.2).
	TriggerLocalTrying Trigger = iota
	// TriggerLocalRing is `rpc.sip.v1.ring` — a 180 with our To tag, which creates the early dialog.
	TriggerLocalRing
	// TriggerLocalEarlyMedia is a 183 carrying an SDP answer. It is a state change and not a header,
	// because of the offer/answer commitment it makes (design §4.3).
	TriggerLocalEarlyMedia
	// TriggerLocalAnswer is `rpc.sip.v1.answer` — the 200 with the SDP the engine couriered from
	// mediad.
	TriggerLocalAnswer
	// TriggerLocalReject is a final 4xx/5xx/6xx from this side: admission refused, or a hangup
	// before we ever answered.
	TriggerLocalReject
	// TriggerLocalHangup is `rpc.sip.v1.hangup`. The METHOD is chosen from the state, not by the
	// caller — see State.Answered.
	TriggerLocalHangup
	// TriggerLocalAck is the ACK this side sends for a 2xx it received. UAC only.
	TriggerLocalAck
	// TriggerRemoteProvisional is a 1xx without a tag, so no dialog yet. UAC only.
	TriggerRemoteProvisional
	// TriggerRemoteEarly is an 18x WITH a To tag: the far end created an early dialog. UAC only.
	TriggerRemoteEarly
	// TriggerRemoteAnswer is a 2xx to our INVITE. UAC only.
	TriggerRemoteAnswer
	// TriggerRemoteFailure is a final non-2xx to our INVITE. UAC only.
	TriggerRemoteFailure
	// TriggerRemoteAck is the far end's ACK for our 2xx. UAS only.
	TriggerRemoteAck
	// TriggerRemoteBye is a BYE from the far end, in any state a BYE can reach.
	TriggerRemoteBye
	// TriggerRemoteCancel is a CANCEL from the far end. UAS only: a UAC receives no CANCEL for its
	// own INVITE, and honouring one would let a guessed Call-ID end a call we placed.
	TriggerRemoteCancel
	// TriggerTeardownComplete is the final response to the BYE we sent, or the 487 for a CANCEL we
	// sent. It is what turns Terminating into Terminated.
	TriggerTeardownComplete
	// TriggerTimeout covers every deadline that ends a dialog: Timer B on a UAC INVITE, 64×T1 with
	// no ACK on a UAS 2xx (RFC 3261 §13.3.1.4), a session-timer expiry (RFC 4028 §10), and a ring
	// timeout the engine did not act on.
	TriggerTimeout
)

// String renders the trigger for logs and for test failure messages.
func (t Trigger) String() string {
	switch t {
	case TriggerLocalTrying:
		return "local-trying"
	case TriggerLocalRing:
		return "local-ring"
	case TriggerLocalEarlyMedia:
		return "local-early-media"
	case TriggerLocalAnswer:
		return "local-answer"
	case TriggerLocalReject:
		return "local-reject"
	case TriggerLocalHangup:
		return "local-hangup"
	case TriggerLocalAck:
		return "local-ack"
	case TriggerRemoteProvisional:
		return "remote-provisional"
	case TriggerRemoteEarly:
		return "remote-early"
	case TriggerRemoteAnswer:
		return "remote-answer"
	case TriggerRemoteFailure:
		return "remote-failure"
	case TriggerRemoteAck:
		return "remote-ack"
	case TriggerRemoteBye:
		return "remote-bye"
	case TriggerRemoteCancel:
		return "remote-cancel"
	case TriggerTeardownComplete:
		return "teardown-complete"
	case TriggerTimeout:
		return "timeout"
	default:
		return "unknown"
	}
}

// The refusal vocabulary, as errors: the Go half of SIP_DIALOG_REFUSAL_REASONS (design §10.4).
// `errors.Is` at the command boundary turns any of them into a wire reason without a string
// comparison anywhere else.
var (
	// ErrDialogGone is a command against a dialog that has already ended — the CANCEL/answer race of
	// design §4.4, seen from the losing side.
	ErrDialogGone = errors.New("dialog: the dialog has already ended")
	// ErrInvalidState is a command that is legal in general and wrong here: an `answer` on an
	// already-answered dialog, an ACK for a 2xx nobody sent.
	ErrInvalidState = errors.New("dialog: the dialog is not in a state that allows this")
	// ErrWrongRole is a UAS trigger on a UAC dialog or the reverse. It is an error rather than a
	// panic because the wire can produce it: a CANCEL matching a UAC dialog by Call-ID is a
	// stranger's guess, and the answer is 481.
	ErrWrongRole = errors.New("dialog: that trigger belongs to the other role")
	// ErrCancelTooLate is RFC 3261 §9.2: a CANCEL for an INVITE whose final response has already
	// gone out has no effect and is answered 481. Distinct from ErrDialogGone because the dialog is
	// alive and the correct teardown is a BYE.
	ErrCancelTooLate = errors.New("dialog: the CANCEL arrived after the final response")
)

// The rest of SIP_DIALOG_REFUSAL_REASONS, as errors. These five are raised by the ORIGINATE path in
// another package, and they live here so one closed vocabulary is not split across two.
var (
	// ErrUnregisteredTarget is an originate to an AOR with no live binding: the engine's
	// `USER_NOT_REGISTERED`, a named refusal rather than an internal failure.
	ErrUnregisteredTarget = errors.New("dialog: the target address of record has no live registration")
	// ErrUnknownTrunk is an originate naming a trunk this edge holds no configuration for. It means
	// the trunk directory has not reached this instance — not that the trunk does not exist — so the
	// engine's recovery is to try another instance rather than to fail the call.
	ErrUnknownTrunk = errors.New("dialog: no configuration for that trunk")
	// ErrNoRoute is a DNS or transport failure reaching the target. NOTHING was sent, which is the
	// part that matters: the engine may safely re-originate this leg somewhere else.
	ErrNoRoute = errors.New("dialog: the target could not be reached")
	// ErrCapacity is a trunk's maxChannels or this instance's own dialog cap. A LOAD signal, and the
	// one refusal here whose correct handling is to try a different instance rather than to give up.
	ErrCapacity = errors.New("dialog: the capacity limit for that target is reached")
	// ErrNotSupported is a command this build understands and cannot serve. Answering it beats
	// no-opping: a hold that silently did nothing leaves the media direction at whatever the last
	// answer said, and nobody notices until a customer is overheard.
	ErrNotSupported = errors.New("dialog: this build cannot serve that command")
)

// transition is the whole machine: a pure function of role, state and trigger. Every refusal is one
// of the four errors above; every acceptance returns only the next state, since the effects need
// data from the input that this table deliberately does not see (Dialog.Apply).
func transition(role Role, state State, trigger Trigger) (State, error) {
	if state == StateTerminated {
		// Checked before anything else: it is what keeps a hung-up call from being answered by a
		// command that was already in flight when it ended.
		return StateTerminated, ErrDialogGone
	}
	if err := roleAllows(role, trigger); err != nil {
		return state, err
	}

	// Teardown is legal from almost everywhere, so it is decided first.
	switch trigger {
	case TriggerRemoteBye:
		// A BYE is legal from Established onwards, INCLUDING before the ACK. RFC 3261 §15 forbids
		// the UAS from sending one before the ACK; it says nothing about receiving one, and a far
		// end that BYEs a call it never ACKed is a real handset behaviour (RFC 5407 §3.1.2). The
		// alternative — 481 — leaves us retransmitting a 2xx at a phone that has hung up.
		if state == StateEstablished || state == StateConfirmed || state == StateTerminating {
			return StateTerminated, nil
		}
		// Before a 2xx there is no confirmed dialog to BYE. The far end wanted CANCEL.
		return state, ErrInvalidState

	case TriggerRemoteCancel:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			return StateTerminated, nil
		case StateEstablished, StateConfirmed:
			// The 200 won. The dialog survives and the state does not move; the CANCEL gets 481.
			return state, ErrCancelTooLate
		default: // StateTerminating — we are already tearing down, so the CANCEL is moot.
			return state, ErrCancelTooLate
		}

	case TriggerLocalHangup:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			// UAS: a final failure response ends it outright, there is nothing to wait for. UAC: a
			// CANCEL is a transaction of its own and its 487 is still owed, so we wait.
			if role == RoleUAS {
				return StateTerminated, nil
			}
			return StateTerminating, nil
		case StateEstablished, StateConfirmed:
			return StateTerminating, nil
		default: // StateTerminating — hangup is idempotent on legId, per design §4.6.
			return StateTerminating, nil
		}

	case TriggerTeardownComplete:
		if state == StateTerminating {
			return StateTerminated, nil
		}
		return state, ErrInvalidState

	case TriggerTimeout:
		// Every timeout ends the dialog. Which timer fired changes the CAUSE and whether a BYE goes
		// out with it, and both of those live on the input rather than in this table.
		return StateTerminated, nil

	case TriggerLocalTrying:
		if state == StateInit {
			return StateProceeding, nil
		}
		// A second 100 is a no-op rather than an error: the transaction layer may retransmit and the
		// engine may retry an admission that already produced one.
		return state, nil

	case TriggerLocalRing, TriggerLocalEarlyMedia:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			return StateEarly, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerLocalAnswer:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			return StateEstablished, nil
		default:
			// Answering twice is the defect that produces two CDR rows for one call.
			return state, ErrInvalidState
		}

	case TriggerLocalReject:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			return StateTerminated, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerRemoteAck:
		switch state {
		case StateEstablished:
			return StateConfirmed, nil
		case StateConfirmed:
			// A retransmitted ACK. Absorbed, because the far end retransmits until it sees us stop
			// retransmitting the 2xx and there is nothing wrong with either of them.
			return StateConfirmed, nil
		case StateTerminating:
			// The ACK we were waiting for so the deferred BYE may go out (RFC 3261 §15). The state
			// does not move; Apply releases the BYE.
			return StateTerminating, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerRemoteProvisional:
		switch state {
		case StateInit:
			return StateProceeding, nil
		case StateProceeding, StateEarly:
			return state, nil
		case StateTerminating:
			// A hangup was requested before any response came back, so the CANCEL is owed and this
			// is what releases it (RFC 3261 §9.1). Refusing the provisional here would strand the
			// deferred CANCEL and leave the far end ringing a phone nobody will answer.
			return StateTerminating, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerRemoteEarly:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			return StateEarly, nil
		case StateTerminating:
			// Same window, one response later: an 18x arriving after the hangup was requested.
			return StateTerminating, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerRemoteAnswer:
		switch state {
		case StateInit, StateProceeding, StateEarly:
			return StateEstablished, nil
		case StateTerminating:
			// The hangup raced the answer and the answer won. The dialog EXISTS — the far end
			// picked up — and it stays in teardown, because the ACK and the BYE it now owes are
			// exactly what makes the far end agree the call is over (RFC 3261 §13.2.2.4 and §15).
			return StateTerminating, nil
		case StateEstablished, StateConfirmed:
			// A second 2xx: a retransmission of the one we ACKed, or a fork we did not ask for. Apply
			// tells them apart by the To tag and answers a fork with ACK+BYE (design §9.7), because a
			// fork answered with silence leaks a dialog at the far end.
			return state, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerRemoteFailure:
		switch state {
		case StateInit, StateProceeding, StateEarly, StateTerminating:
			// A 487 for the CANCEL we sent arrives here, and it is the ordinary end of a cancelled
			// outbound call rather than an error.
			return StateTerminated, nil
		default:
			return state, ErrInvalidState
		}

	case TriggerLocalAck:
		switch state {
		case StateEstablished:
			return StateConfirmed, nil
		case StateConfirmed, StateTerminating:
			// Re-ACKing a retransmitted 2xx is required (RFC 3261 §13.2.2.4) and changes nothing.
			return state, nil
		default:
			return state, ErrInvalidState
		}
	}

	return state, ErrInvalidState
}

// roleAllows refuses the triggers that belong to the other end of the INVITE. A trigger in neither
// list — the teardown and timeout inputs — is legal for both roles.
func roleAllows(role Role, trigger Trigger) error {
	switch trigger {
	case TriggerLocalTrying, TriggerLocalRing, TriggerLocalEarlyMedia, TriggerLocalAnswer,
		TriggerLocalReject, TriggerRemoteAck, TriggerRemoteCancel:
		if role != RoleUAS {
			return ErrWrongRole
		}
	case TriggerLocalAck, TriggerRemoteProvisional, TriggerRemoteEarly, TriggerRemoteAnswer,
		TriggerRemoteFailure:
		if role != RoleUAC {
			return ErrWrongRole
		}
	}
	return nil
}
