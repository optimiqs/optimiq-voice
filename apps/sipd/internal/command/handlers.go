package command

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// Every handler is `[]byte -> []byte`, with no *nats.Msg anywhere.
//
// That is the whole reason the unit suite needs no broker: a handler is a pure function of its
// payload, so it can be driven as a table. None of them returns an error, because there is no caller
// that could do anything with one — a refusal IS the reply.

// Dialogs is the surface these commands act on.
//
// # Why the interface is here and the implementation is in internal/invite
//
// The consumer defines the interface, which is what lets the unit suite drive all five handlers
// against a stub with no socket and no dialog machine in it. Nothing in it mentions NATS and nothing
// in it mentions sipgo: the four dialog commands take a leg id and their own arguments, and the one
// that creates a dialog takes the contract's own request struct because there is no smaller honest
// summary of a dial target.
//
// # The error contract, which is the load-bearing half
//
// Every method reports failure as one of internal/dialog's refusal errors, matched with `errors.Is`.
// That is what keeps the reason vocabulary in ONE place: the implementation never names a wire
// reason, the responder never inspects a dialog state, and adding a refusal is one error and one
// row in refusalFor.
type Dialogs interface {
	// Ring sends a provisional response on a leg that has not been answered.
	Ring(ctx context.Context, legID string, status int, sdpAnswer string) error

	// Answer puts a 200 OK with this body on the socket and reports WHEN it went.
	//
	// # It must return when the 2xx is WRITTEN, not when the ACK arrives
	//
	// The single most important consequence of sipgo's shape for this whole design (§4.6).
	// `DialogServerSession.WriteResponse` BLOCKS its calling goroutine until the ACK or 64×T1 ≈ 32 s,
	// retransmitting the 2xx per RFC 6026 — so an implementation that waited for it would blow the
	// contract's 1000 ms deadline on every call whose ACK is even slightly late, and the engine would
	// re-issue an `answer` against a call that is already up.
	//
	// The obligation therefore sits on the IMPLEMENTATION and is stated here because this interface
	// is where a future implementer will look: hand the response to the dialog's own goroutine and
	// return as soon as it has been written. The ACK is reported later as `sip.evt.v1…dialog.answered`.
	Answer(ctx context.Context, legID string, sdpAnswer string) (sentAt time.Time, err error)

	// Hangup ends a leg with a cause and reports WHICH METHOD it used.
	//
	// The edge chooses the method from the dialog state it owns — a BYE if confirmed, a CANCEL if we
	// are a UAC in an early dialog, a 4xx/5xx/6xx final if we are a UAS that has not answered — and
	// `deferred` when RFC 3261 says it may not send yet (§15's unACKed 2xx, §9.1's pre-provisional
	// CANCEL). The engine says "end this leg with this cause" and nothing more.
	Hangup(ctx context.Context, legID string, cause int, detail string) (contract.SipHangupResponseMethod, error)

	// Originate places an outbound call and returns as soon as the INVITE has been SENT.
	//
	// The same split MediaPort.originate already has: it returns a started call, not an answered
	// one. The 2xx arrives later as `dialog.answered` and an 18x as `dialog.progressed`.
	//
	// The two results are the URI the INVITE actually went to and the dialog's Call-ID, both purely
	// diagnostic — they let a packet capture be lined up before any event has been published, which
	// is the only way to debug an outbound call that fails inside the first hundred milliseconds.
	Originate(ctx context.Context, request contract.SipOriginateRequest) (requestURI, sipCallID string, err error)
}

// marshal is json.Marshal, named so command.go's encode reads without an import that only it needs.
func marshal(reply any) ([]byte, error) { return json.Marshal(reply) }

// commandTimeout bounds one handler's work.
//
// It is deliberately SHORTER than nothing and longer than the contract's deadline is not an option:
// each of these subjects has a 500 ms or 1000 ms budget at the caller, and a handler that ran past
// it would do work for a reply nobody is still waiting for — worse, it would apply a state change
// for a command the engine has already declared failed and may already have retried. Five seconds
// is the mailbox-hop ceiling the rest of this service uses for the same job; the real bound is the
// caller's, and this exists so a wedged dialog goroutine cannot leak a handler goroutine per retry.
const commandTimeout = 5 * time.Second

func commandContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), commandTimeout)
}

// ---------------------------------------------------------------------------------------------
// ring
// ---------------------------------------------------------------------------------------------

// HandleRing answers `rpc.sip.v1.ring`: a provisional response on a leg we have not answered.
//
// `180 Ringing` without a body is the whole of it at this slice. A `183` carrying an answer is
// refused `not_supported` and is refused rather than half-built, because a `183` with an answer
// COMMITS the offer/answer exchange and the subsequent `200 OK` must then repeat that same answer
// (RFC 3261 §13.2.1) — get it wrong and the call connects with no audio, which is the defect class
// that is invisible at the moment it happens.
func (s *Server) HandleRing(data []byte) []byte {
	var request contract.SipRingRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseRing("", ReasonBadRequest, fmt.Sprintf("malformed ring request: %v", err))
	}
	if request.LegID == "" {
		return s.refuseRing("", ReasonBadRequest, "legId is required")
	}
	status := request.Status
	if status == 0 {
		// The contract defaults it to 180 and a Go zero value is indistinguishable from an omitted
		// field, so the default is applied here rather than being read as an invalid status.
		status = 180
	}
	if status < 180 || status > 183 {
		return s.refuseRing(request.LegID, ReasonBadRequest,
			fmt.Sprintf("%d is not a provisional response this edge sends (180-183)", status))
	}
	if request.SDPAnswer != nil && *request.SDPAnswer != "" {
		return s.refuseRing(request.LegID, ReasonNotSupported,
			"early media is not implemented: a 183 carrying an answer commits the offer/answer "+
				"exchange and the 200 OK must then repeat it byte for byte (RFC 3261 §13.2.1), and a "+
				"half-built early media path is a call that connects with no audio")
	}

	ctx, cancel := commandContext()
	defer cancel()

	if err := s.dialogs.Ring(ctx, request.LegID, status, ""); err != nil {
		reason, detail := refusalFor(err)
		s.log.Warn("refusing a ring", "legId", request.LegID, "status", status, "reason", reason, "error", err)
		return s.refuseRing(request.LegID, reason, detail)
	}
	return encode(s.log, contract.SipRingResponse{
		Ok:         true,
		LegID:      request.LegID,
		InstanceID: stringPtr(s.instance),
	})
}

func (s *Server) refuseRing(legID, reason, message string) []byte {
	code := contract.SipRingResponseReason(reason)
	return encode(s.log, contract.SipRingResponse{
		Ok:         false,
		LegID:      legID,
		InstanceID: stringPtr(s.instance),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// ---------------------------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------------------------

// HandleAnswer answers `rpc.sip.v1.answer`: put a 200 OK with this body on the socket.
//
// It replies when the 2xx IS WRITTEN, not when the ACK arrives — see Dialogs.Answer for the whole
// argument, and note that the guarantee is structural rather than a promise: the dialog session runs
// its effects on the dialog's own goroutine BEFORE the task's caller is answered, so by the time
// this returns the response has been handed to the transaction and the RFC 6026 retransmission loop
// is a background goroutine that nothing here waits on.
//
// Idempotent on legId, like every command in this family: a timed-out `answer` may be re-issued, and
// the second one is refused `invalid_state` rather than answering the call twice.
func (s *Server) HandleAnswer(data []byte) []byte {
	var request contract.SipAnswerRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseAnswer("", ReasonBadRequest, fmt.Sprintf("malformed answer request: %v", err))
	}
	if request.LegID == "" {
		return s.refuseAnswer("", ReasonBadRequest, "legId is required")
	}
	if request.SDPAnswer == "" {
		// Not pedantry. A 200 OK answering an offer with no body is a call that connects to silence,
		// which is exactly the failure this contract exists to prevent, and it is invisible to
		// everything except the two people on the call.
		return s.refuseAnswer(request.LegID, ReasonBadRequest,
			"sdpAnswer is required: a 200 OK to an offer with no body is a call that connects to silence")
	}

	ctx, cancel := commandContext()
	defer cancel()

	sentAt, err := s.dialogs.Answer(ctx, request.LegID, request.SDPAnswer)
	if err != nil {
		reason, detail := refusalFor(err)
		s.log.Warn("refusing an answer", "legId", request.LegID, "reason", reason, "error", err)
		return s.refuseAnswer(request.LegID, reason, detail)
	}
	response := contract.SipAnswerResponse{
		Ok:         true,
		LegID:      request.LegID,
		InstanceID: stringPtr(s.instance),
	}
	if !sentAt.IsZero() {
		// The anchor for a post-dial-delay plot: the instant the 2xx went on the socket, measured on
		// the only plane that can see it.
		stamp := contract.EventTime{Time: sentAt}
		response.SentAt = &stamp
	}
	return encode(s.log, response)
}

func (s *Server) refuseAnswer(legID, reason, message string) []byte {
	code := contract.SipAnswerResponseReason(reason)
	return encode(s.log, contract.SipAnswerResponse{
		Ok:         false,
		LegID:      legID,
		InstanceID: stringPtr(s.instance),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// ---------------------------------------------------------------------------------------------
// hangup
// ---------------------------------------------------------------------------------------------

// HandleHangup answers `rpc.sip.v1.hangup`: end this leg with this cause.
//
// The reply's `method` is not decoration. "The hangup succeeded and no packet left" is otherwise
// indistinguishable from a bug, and `deferred` is the one outcome where a later `dialog.terminated`
// is genuinely still owed — RFC 3261 §15 forbids a BYE on a 2xx we sent and that has not been ACKed,
// and §9.1 gives a CANCEL nothing to match against before a provisional response arrives. Both
// answer `ok` and send when they may.
func (s *Server) HandleHangup(data []byte) []byte {
	var request contract.SipHangupRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseHangup("", ReasonBadRequest, fmt.Sprintf("malformed hangup request: %v", err))
	}
	if request.LegID == "" {
		return s.refuseHangup("", ReasonBadRequest, "legId is required")
	}
	cause := 0
	if request.Cause != nil {
		cause = *request.Cause
	}
	detail := ""
	if request.Detail != nil {
		detail = *request.Detail
	}

	ctx, cancel := commandContext()
	defer cancel()

	method, err := s.dialogs.Hangup(ctx, request.LegID, cause, detail)
	if err != nil {
		reason, message := refusalFor(err)
		s.log.Warn("refusing a hangup", "legId", request.LegID, "reason", reason, "error", err)
		return s.refuseHangup(request.LegID, reason, message)
	}
	if !method.Valid() {
		// A method outside the contract's five is a bug in the implementation rather than in the
		// request, and reporting it verbatim would put an unparseable value on a closed vocabulary.
		// `none` is the honest fallback: the leg is ended either way and no packet is claimed.
		s.log.Error("the dialog layer reported a hangup method the contract does not know",
			"legId", request.LegID, "method", string(method))
		method = contract.SipHangupResponseMethodNone
	}
	return encode(s.log, contract.SipHangupResponse{
		Ok:         true,
		LegID:      request.LegID,
		InstanceID: stringPtr(s.instance),
		Method:     &method,
	})
}

func (s *Server) refuseHangup(legID, reason, message string) []byte {
	code := contract.SipHangupResponseReason(reason)
	return encode(s.log, contract.SipHangupResponse{
		Ok:         false,
		LegID:      legID,
		InstanceID: stringPtr(s.instance),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// ---------------------------------------------------------------------------------------------
// reinvite
// ---------------------------------------------------------------------------------------------

// HandleReinvite answers `rpc.sip.v1.reinvite` — and refuses it, by name.
//
// # Why this refuses rather than half-works
//
// sipgo supplies none of a re-INVITE (design §9.2): `DialogServerSession.inviteTx` is the ORIGINAL
// transaction and nothing swaps it, there is no offer/answer version tracking, and RFC 3261 §14.2
// glare — `491 Request Pending` plus the asymmetric retry interval, 2.1–4.0 s for the higher
// Call-ID and 0–2.0 s for the lower — is absent entirely. Shipping a re-INVITE without glare
// handling would let a hold issued at the same instant the far end holds produce two dialogs each
// believing they own an outstanding offer, with the media direction decided by whichever answer
// landed last. That is a call where one party can hear a conversation they were taken out of, which
// is a privacy incident rather than a degraded feature.
//
// So it answers `not_supported`, and the detail names sipgo and the missing piece rather than saying
// "not implemented" — because the engine's operator reading that log line needs to know whether to
// wait for a release or to file a bug.
//
// # Why it validates first and refuses second
//
// A malformed reinvite is `bad_request` even though a well-formed one is `not_supported`. The two
// are different instructions to the caller: one says "these bytes will never work" and the other
// says "this build cannot do this yet". Collapsing them would hide a client bug behind a known gap
// for however long the gap lasts. It deliberately does NOT look the dialog up: the answer is the
// same for a leg we hold and a leg we do not, and spending a mailbox round trip to reach a foregone
// conclusion would put load on a dialog goroutine for nothing.
func (s *Server) HandleReinvite(data []byte) []byte {
	var request contract.SipReinviteRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseReinvite("", ReasonBadRequest, fmt.Sprintf("malformed reinvite request: %v", err))
	}
	if request.LegID == "" {
		return s.refuseReinvite("", ReasonBadRequest, "legId is required")
	}
	if request.SDPOffer == "" {
		return s.refuseReinvite(request.LegID, ReasonBadRequest, "sdpOffer is required")
	}
	if request.Intent != "" && !request.Intent.Valid() {
		return s.refuseReinvite(request.LegID, ReasonBadRequest,
			fmt.Sprintf("%q is not a reinvite intent this contract knows", request.Intent))
	}

	s.log.Info("refusing a reinvite: this build has no re-INVITE",
		"legId", request.LegID, "intent", string(request.Intent))
	return s.refuseReinvite(request.LegID, ReasonNotSupported,
		"sipgo has no re-INVITE (design §9.2): the INVITE server transaction is never swapped, there "+
			"is no offer/answer version tracking, and RFC 3261 §14.2 glare handling is absent. A hold "+
			"that silently no-opped would be a call whose media direction is whatever answer landed "+
			"last, so this refuses instead")
}

func (s *Server) refuseReinvite(legID, reason, message string) []byte {
	code := contract.SipReinviteResponseReason(reason)
	return encode(s.log, contract.SipReinviteResponse{
		Ok:         false,
		LegID:      legID,
		InstanceID: stringPtr(s.instance),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// ---------------------------------------------------------------------------------------------
// originate
// ---------------------------------------------------------------------------------------------

// HandleOriginate answers `rpc.sip.v1.originate`: place an outbound call.
//
// The one subject in this family that is FLAT and queue-grouped, because it CREATES the dialog and
// has no owner to find. The reply carries this instance's id, and the engine addresses every
// subsequent command for the leg at exactly that instance — the pattern
// `mediaAllocateSessionResponseSchema.instanceId` established.
//
// It replies when the INVITE has been SENT, not when it is answered. The far end's ringing is a full
// transaction away and is not inside the contract's one-second budget; it arrives as
// `dialog.progressed`, and the 2xx as `dialog.answered`.
func (s *Server) HandleOriginate(data []byte) []byte {
	var request contract.SipOriginateRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseOriginate("", ReasonBadRequest, fmt.Sprintf("malformed originate request: %v", err))
	}
	switch {
	case request.LegID == "":
		return s.refuseOriginate("", ReasonBadRequest,
			"legId is required and must be assigned by the caller")
	case request.OrgID == "":
		// Without it there is no org token for this leg's event subjects, so a call originated
		// without one would end silently and the engine would never learn why.
		return s.refuseOriginate(request.LegID, ReasonBadRequest,
			"orgId is required: it is the subject token this leg's dialog events are published under")
	case request.CallID == "":
		return s.refuseOriginate(request.LegID, ReasonBadRequest, "callId is required")
	case request.SDPOffer == "":
		// The offer is mediad's, written by `create-offer`. A body-less INVITE is refused or
		// mishandled by a meaningful share of carriers and handsets, and the failure mode is "the
		// phone rang and there was no audio" — invisible at the moment it happens.
		return s.refuseOriginate(request.LegID, ReasonBadRequest,
			"sdpOffer is required: this edge forwards an offer it did not write and never synthesises one")
	}
	if detail, ok := validTarget(request.Target); !ok {
		return s.refuseOriginate(request.LegID, ReasonBadRequest, detail)
	}
	if request.RingTimeoutMs != nil && *request.RingTimeoutMs <= 0 {
		return s.refuseOriginate(request.LegID, ReasonBadRequest,
			"ringTimeoutMs must be positive: an originate that rings for ever is a dialog and an RTP "+
				"port pair held by nobody")
	}

	ctx, cancel := commandContext()
	defer cancel()

	requestURI, sipCallID, err := s.dialogs.Originate(ctx, request)
	if err != nil {
		reason, detail := refusalFor(err)
		s.log.Warn("refusing an originate",
			"legId", request.LegID, "orgId", request.OrgID, "callId", request.CallID,
			"targetKind", string(request.Target.Kind), "reason", reason, "error", err)
		return s.refuseOriginate(request.LegID, reason, detail)
	}
	return encode(s.log, contract.SipOriginateResponse{
		Ok:         true,
		LegID:      request.LegID,
		InstanceID: stringPtr(s.instance),
		RequestURI: stringPtr(requestURI),
		SIPCallID:  stringPtr(sipCallID),
	})
}

// validTarget applies `sipDialTargetSchema`'s refinement on this side of the border.
//
// The contract's note says why the shape is a tagged struct with three optional groups rather than a
// discriminated union — Go has no sum type, so the codegen would have emitted an `any` or a
// hand-written unmarshaller — and it says explicitly that the pairing is "checked identically on
// both sides because both sides run the same validation, one against the schema and one against the
// generated struct's required-field switch". This is that switch. Without it a `{kind:"trunk"}` with
// no trunkId reaches the dial path as an empty string and becomes an `unknown_trunk` refusal, which
// blames the directory for what is a malformed request.
func validTarget(target contract.SipOriginateRequestTarget) (string, bool) {
	switch target.Kind {
	case contract.SipOriginateRequestTargetKindAOR:
		if target.AOR == nil || *target.AOR == "" {
			return `target.aor is required when kind is "aor"`, false
		}
	case contract.SipOriginateRequestTargetKindTrunk:
		if target.TrunkID == nil || *target.TrunkID == "" {
			return `target.trunkId is required when kind is "trunk"`, false
		}
		if target.Number == nil || *target.Number == "" {
			return `target.number is required when kind is "trunk"`, false
		}
	case contract.SipOriginateRequestTargetKindURI:
		if target.URI == nil || *target.URI == "" {
			return `target.uri is required when kind is "uri"`, false
		}
	default:
		return fmt.Sprintf("%q is not a dial target kind this contract knows", target.Kind), false
	}
	return "", true
}

func (s *Server) refuseOriginate(legID, reason, message string) []byte {
	code := contract.SipOriginateResponseReason(reason)
	return encode(s.log, contract.SipOriginateResponse{
		Ok:         false,
		LegID:      legID,
		InstanceID: stringPtr(s.instance),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// ---------------------------------------------------------------------------------------------
// the one place a Go error becomes a wire reason
// ---------------------------------------------------------------------------------------------

// refusalFor maps internal/dialog's refusal errors onto SIP_DIALOG_REFUSAL_REASONS.
//
// # One table, and `errors.Is` rather than a type switch
//
// `errors.Is` because the implementation wraps: an originate that could not resolve an AOR returns
// something like `fmt.Errorf("originate: %s: %w", aor, dialog.ErrUnregisteredTarget)`, and the wrap
// is what puts the AOR in the log line. A type switch would miss it, and the symptom would be every
// wrapped refusal collapsing to `internal` — which tells the engine to give up on a call it should
// have retried elsewhere.
//
// The DETAIL is the error's own text, not a restatement. The contract is explicit that a caller
// branches on the code and never on the human-readable `error`, so the text is free to be as
// specific as the implementation can make it, and it is the only thing an operator has when a
// refusal is unexpected.
//
// The default is `internal`, and it is the honest default rather than a convenient one: an error
// this table does not recognise is a failure nobody classified, and answering `capacity` or
// `no_route` would tell the engine to retry somewhere else on the strength of a guess.
func refusalFor(err error) (reason, detail string) {
	if err == nil {
		return ReasonInternal, "no error"
	}
	detail = err.Error()

	switch {
	case errors.Is(err, dialog.ErrUnknownDialog):
		return ReasonUnknownDialog, detail
	case errors.Is(err, dialog.ErrDialogGone), errors.Is(err, dialog.ErrCancelTooLate):
		// ErrCancelTooLate joins ErrDialogGone here and nowhere else: from a COMMAND's point of view
		// a dialog that has already had its final response is gone, and the distinction the dialog
		// layer draws — the dialog is alive and the CANCEL lost — is about answering a CANCEL's
		// transaction, which no engine command has.
		return ReasonDialogGone, detail
	case errors.Is(err, dialog.ErrInvalidState), errors.Is(err, dialog.ErrWrongRole):
		// ErrWrongRole is `invalid_state` and not `bad_request`: the request was well formed and the
		// DIALOG is the wrong shape for it — an `answer` addressed at a leg this edge originated.
		return ReasonInvalidState, detail
	case errors.Is(err, dialog.ErrSessionClosed):
		// The dialog's goroutine has stopped, which on this edge means a drain. `shutting_down` tells
		// the engine not to retry HERE, which is exactly right: the leg is going away with the
		// process, and a retry at another instance is the only thing that can work.
		return ReasonShuttingDown, detail
	case errors.Is(err, dialog.ErrDuplicateLeg):
		// A second originate for a leg id already in flight. `invalid_state` rather than
		// `bad_request`, because the request is well formed and it is the WORLD that disagrees — and
		// the engine's recovery is to look at the leg it already has rather than to fix the bytes.
		return ReasonInvalidState, detail
	case errors.Is(err, dialog.ErrUnregisteredTarget):
		return ReasonUnregisteredTarget, detail
	case errors.Is(err, dialog.ErrUnknownTrunk):
		return ReasonUnknownTrunk, detail
	case errors.Is(err, dialog.ErrNoRoute):
		return ReasonNoRoute, detail
	case errors.Is(err, dialog.ErrCapacity):
		return ReasonCapacity, detail
	case errors.Is(err, dialog.ErrNotSupported):
		return ReasonNotSupported, detail
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// The handler ran out of time waiting for a dialog goroutine. The caller's own deadline has
		// almost certainly expired too, so this reply is usually thrown away — but when it is not,
		// `internal` is right: nothing about the request or the dialog was wrong, and this edge
		// simply did not get to it.
		return ReasonInternal, detail
	default:
		return ReasonInternal, detail
	}
}
