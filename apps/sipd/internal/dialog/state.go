// Package dialog is sipd's SIP dialog layer: the state machine behind INVITE.
//
// # Why this exists when sipgo already has one
//
// sipgo v1.4.3 gives transactions and a dialog CACHE, and gives no SIP application semantics
// (plans/sipd-invite-design.md §9.11). Concretely, `sip.DialogState` has three values —
// Established, Confirmed, Ended (`sip/dialog.go:5-12`) — with no Early state, no CANCEL-after-200
// rule, no deferred-BYE rule, no glare, no session timers and no re-INVITE. Every one of those is
// a decision this edge has to make correctly on a call path where the failure mode is silent: the
// phone rang and there was no audio, or the call ended and no CDR was written.
//
// So the semantics live here, as a PURE state machine, and sipgo stays what it is good at: sockets,
// transactions and retransmission timers. The split is deliberate and is what makes the races in
// RFC 3261 §13 and §15 table-testable without a socket, a broker or a clock.
//
// # The identity discipline
//
// One string names the leg, the mediad session and this dialog (design §3.1). The SIP dialog
// identifier — Call-ID plus the two tags — is DATA on the record and never the key; it is a lookup
// index, exactly as `sipTransferRequestSchema.sipCallId` is documented to be. See identity.go.
//
// # Concurrency
//
// A Dialog is NOT safe for concurrent use, on purpose. One goroutine owns one dialog and every
// input — a command from the engine, a CANCEL from the wire, a timer — is a message on its mailbox
// (design §4.4, and the same shape mediad chose for a session). Exactly one of a racing CANCEL and
// a racing `answer` wins BY CONSTRUCTION, and the loser is refused by name rather than by luck.
// The Store below is the only shared thing, and it is locked.
package dialog

import "errors"

// State is where one dialog is in its life.
//
// It is deliberately finer than sipgo's three values in two places, and both are load-bearing:
//
//   - Early exists because an 18x carrying a To tag CREATES a dialog (RFC 3261 §12.1), and a
//     dialog that exists is one a CANCEL can end, a session timer can be negotiated on, and an
//     UPDATE can retarget. sipgo models none of that because it models no Early state (design §9.3).
//   - Terminating exists because teardown is not instantaneous and the rules for what may be sent
//     during it are the sharpest edges in RFC 3261 — a BYE owed but not yet sendable (§15), an ACK
//     owed before a BYE may go out (§13.2.2.4), a CANCEL that has already lost (§9.2).
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
	// seen. It is the most dangerous state in SIP and the reason it is named separately: a CANCEL
	// arriving here has already lost, a BYE arriving here is legal and must be honoured, and a
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

// Alive reports whether the dialog can still carry a command. It is the check every command handler
// makes before doing anything, so "the call ended while the RPC was in flight" is one branch in one
// place instead of a status comparison at every call site.
func (s State) Alive() bool { return s != StateTerminated }

// Answered reports whether a 2xx has been committed on this dialog. It is the predicate that
// decides the METHOD of a teardown — BYE if answered, CANCEL or a failure response if not — which
// is the whole of what `rpc.sip.v1.hangup` means when it says "end this leg with this cause"
// (design §10.3).
func (s State) Answered() bool { return s == StateEstablished || s == StateConfirmed }

// Role is which end of the INVITE this process is.
//
// It is not cosmetic: half of the trigger vocabulary is legal for exactly one role, and mixing them
// is how a UAS ends up trying to send a CANCEL for an INVITE it received.
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

// Trigger is one input to the machine.
//
// The names say WHO did the thing, because that is the distinction the RFC's races turn on: a
// CANCEL we receive and a CANCEL we send are different events with different legal windows, and a
// vocabulary that called both "cancel" would make the table unwritable.
type Trigger int

const (
	// TriggerLocalTrying is the 100 this edge sends before consulting the engine. It is out before
	// the admission RPC, always: a silent engine must not cost the caller a Timer B (design §4.2).
	TriggerLocalTrying Trigger = iota
	// TriggerLocalRing is `rpc.sip.v1.ring` — a 180 with our To tag, which creates the early dialog.
	TriggerLocalRing
	// TriggerLocalEarlyMedia is a 183 carrying an SDP answer. Deferred at slice 1 (design §4.3) and
	// in the vocabulary now because the offer/answer commitment it makes is a state change, not a
	// header.
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
	// TriggerRemoteCancel is a CANCEL from the far end. UAS only — a UAC receives no CANCEL for its
	// own INVITE, and treating one as valid would let a stranger who guessed a Call-ID end a call we
	// placed.
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

// The refusal vocabulary, as errors.
//
// These are the Go half of SIP_DIALOG_REFUSAL_REASONS (design §10.4). They are errors rather than
// a string because every one of them is a branch a caller takes, and because `errors.Is` at the
// command boundary is how the reason reaches the wire without a switch on a string in three files.
var (
	// ErrDialogGone is a command against a dialog that has already ended — the CANCEL/answer race
	// of design §4.4, seen from the losing side. The engine treats it as it already treats
	// `channel_gone` in the transfer responder.
	ErrDialogGone = errors.New("dialog: the dialog has already ended")
	// ErrInvalidState is a command that is legal in general and wrong here: an `answer` on an
	// already-answered dialog, an ACK for a 2xx nobody sent.
	ErrInvalidState = errors.New("dialog: the dialog is not in a state that allows this")
	// ErrWrongRole is a UAS trigger on a UAC dialog or the reverse. It is a programming error, not a
	// wire condition, and it is an error rather than a panic because the wire can produce it: a
	// CANCEL that matched a UAC dialog by Call-ID is a stranger's guess, and the answer is 481.
	ErrWrongRole = errors.New("dialog: that trigger belongs to the other role")
	// ErrCancelTooLate is RFC 3261 §9.2 exactly: a CANCEL for an INVITE whose final response has
	// already gone out has no effect, and the correct answer is 481. The correct TEARDOWN is a BYE,
	// which is why this is distinct from ErrDialogGone — the dialog is very much alive.
	ErrCancelTooLate = errors.New("dialog: the CANCEL arrived after the final response")
)

// The rest of SIP_DIALOG_REFUSAL_REASONS, as errors.
//
// # Why they live here and not next to the NATS responder that reports them
//
// The four above were declared when only the dialog machine could raise them. These five are raised
// by the ORIGINATE path — a lookup that found no registration, a trunk this edge holds no
// configuration for, a target that will not resolve — which is a different file in a different
// package. Putting them there would split one closed vocabulary across two packages and give the
// responder two switches to keep in step.
//
// So the whole of SIP_DIALOG_REFUSAL_REASONS is here, which is what the paragraph above already
// claims this block is, and `errors.Is` at the command boundary turns any of the nine into a wire
// reason without a single string comparison anywhere else.
var (
	// ErrUnregisteredTarget is an originate to an AOR with no live binding. The engine's
	// `USER_NOT_REGISTERED`, and NOT an error: a phone that is unplugged is the ordinary case, which
	// is why it is a named refusal rather than an internal failure.
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
	// ErrNotSupported is a command this build understands and cannot serve. `reinvite` answers it
	// until sipgo has a re-INVITE at all (design §9.2), and answering it is strictly better than the
	// alternative: a hold that silently no-opped is a call whose media direction is whatever the last
	// answer happened to say, and nobody finds that until a customer is overheard.
	ErrNotSupported = errors.New("dialog: this build cannot serve that command")
)

// transition is the whole machine: a pure function of role, state and trigger.
//
// Every "no" is one of the four errors above, so a caller never has to infer a reason from a state
// comparison. Every "yes" returns the next state and nothing else — the effects that go with it are
// Dialog.Apply's job, because they need the data on the input and this table deliberately has none.
func transition(role Role, state State, trigger Trigger) (State, error) {
	if state == StateTerminated {
		// One rule, before anything else, because it is the one that keeps a hung-up call from being
		// answered by a command that was already in flight when it ended.
		return StateTerminated, ErrDialogGone
	}
	if err := roleAllows(role, trigger); err != nil {
		return state, err
	}

	switch trigger {
	// -- teardown, which is legal from almost everywhere and therefore comes first ----------------
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

	// -- UAS forward progress ---------------------------------------------------------------------
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

	// -- UAC forward progress ---------------------------------------------------------------------
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
			// A second 2xx: either a retransmission of the one we already ACKed, or a fork we did
			// not ask for. Apply tells them apart by the To tag and answers the fork with ACK+BYE
			// (design §9.7) — a fork answered with silence leaks a dialog at the far end and, on
			// some carriers, bills for it.
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

// roleAllows refuses the triggers that belong to the other end of the INVITE.
//
// The two lists are exhaustive rather than defaulted: a trigger added later without a decision here
// is a compile-time-invisible bug, and this way it is refused loudly on its first test.
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
