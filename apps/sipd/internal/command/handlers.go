package command

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// Every handler is `[]byte -> []byte`, with no *nats.Msg anywhere, so a handler is a pure function
// of its payload and the unit suite needs no broker. None returns an error: a refusal IS the reply.

// Dialogs is the surface these commands act on. The consumer defines the interface, so the handlers
// can be driven against a stub; nothing in it mentions NATS or sipgo.
//
// Every method reports failure as one of internal/dialog's refusal errors, matched with errors.Is.
// That keeps the reason vocabulary in one place: the implementation never names a wire reason, the
// responder never inspects a dialog state, and adding a refusal is one error and one row in
// refusalFor.
type Dialogs interface {
	// Ring sends a provisional response on a leg that has not been answered.
	Ring(ctx context.Context, legID string, status int, sdpAnswer string) error

	// Answer puts a 200 OK with this body on the socket and reports WHEN it went.
	//
	// It must return when the 2xx is WRITTEN, not when the ACK arrives: sipgo's
	// `DialogServerSession.WriteResponse` blocks until the ACK or 64×T1 ≈ 32 s while retransmitting
	// per RFC 6026, which would blow the contract's 1000 ms deadline on every slightly late ACK. An
	// implementation must hand the response to the dialog's own goroutine and return once written;
	// the ACK is reported later as `dialog.answered`.
	Answer(ctx context.Context, legID string, sdpAnswer string) (sentAt time.Time, err error)

	// Hangup ends a leg with a cause and reports WHICH METHOD it used. The edge chooses it from the
	// dialog state it owns — BYE if confirmed, CANCEL as a UAC in an early dialog, a final response
	// as an unanswered UAS, `deferred` when RFC 3261 §15 or §9.1 says it may not send yet.
	Hangup(ctx context.Context, legID string, cause int, detail string) (contract.SipHangupResponseMethod, error)

	// Originate places an outbound call and returns as soon as the INVITE has been SENT: a started
	// call, not an answered one. The 2xx arrives later as `dialog.answered`, an 18x as
	// `dialog.progressed`. The two results — the URI the INVITE went to and the dialog's Call-ID —
	// are diagnostic, and let a packet capture be lined up before any event has been published.
	Originate(ctx context.Context, request contract.SipOriginateRequest) (requestURI, sipCallID string, err error)
}

// marshal is json.Marshal, named so command.go's encode reads without an import that only it needs.
func marshal(reply any) ([]byte, error) { return json.Marshal(reply) }

// commandTimeout bounds one handler's work. The real bound is the caller's 500 ms or 1000 ms budget;
// this exists so a wedged dialog goroutine cannot leak a handler goroutine per retry.
const commandTimeout = 5 * time.Second

func commandContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), commandTimeout)
}

// HandleRing answers `rpc.sip.v1.ring`: a provisional response on a leg we have not answered.
//
// `180 Ringing` carries no body. A `183` may carry an answer, which commits the offer/answer
// exchange: the dialog records it so the subsequent 200 OK repeats it byte for byte
// (RFC 3261 §13.2.1). A body on anything but a 183 is refused — an uncommitted provisional response
// cannot answer an offer.
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
		// A Go zero value is indistinguishable from an omitted field, so the contract's 180 default
		// is applied here rather than being read as an invalid status.
		status = 180
	}
	if status < 180 || status > 183 {
		return s.refuseRing(request.LegID, ReasonBadRequest,
			fmt.Sprintf("%d is not a provisional response this edge sends (180-183)", status))
	}
	answer := ""
	if request.SDPAnswer != nil {
		answer = *request.SDPAnswer
	}
	if answer != "" && status != 183 {
		return s.refuseRing(request.LegID, ReasonBadRequest,
			fmt.Sprintf("a %d carries no answer: only a 183 commits the offer/answer exchange", status))
	}

	ctx, cancel := commandContext()
	defer cancel()

	if err := s.dialogs.Ring(ctx, request.LegID, status, answer); err != nil {
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

// HandleAnswer answers `rpc.sip.v1.answer`: put a 200 OK with this body on the socket.
//
// It replies when the 2xx is WRITTEN, not when the ACK arrives (see Dialogs.Answer); the RFC 6026
// retransmission loop is a background goroutine nothing here waits on. Idempotent on legId: a
// re-issued `answer` is refused `invalid_state` rather than answering the call twice.
func (s *Server) HandleAnswer(data []byte) []byte {
	var request contract.SipAnswerRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseAnswer("", ReasonBadRequest, fmt.Sprintf("malformed answer request: %v", err))
	}
	if request.LegID == "" {
		return s.refuseAnswer("", ReasonBadRequest, "legId is required")
	}
	if request.SDPAnswer == "" {
		// A 200 OK answering an offer with no body is a call that connects to silence, invisible to
		// everything except the two people on it.
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
		// The anchor for a post-dial-delay plot: the instant the 2xx went on the socket.
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

// HandleHangup answers `rpc.sip.v1.hangup`: end this leg with this cause.
//
// The reply's `method` distinguishes "the hangup succeeded and no packet left" from a bug.
// `deferred` is the one outcome where a later `dialog.terminated` is still owed: RFC 3261 §15
// forbids a BYE on an unACKed 2xx, and §9.1 gives a CANCEL nothing to match before a provisional
// response arrives. Both answer `ok` and send when they may.
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
		// A hangup for a leg this edge never established is the ECHO of an earlier refusal — the
		// engine tears down what it thinks it dialled — so it says nothing the originate refusal has
		// not already said. Debug, or a stale binding costs three warnings for one fact.
		level := levelFor(reason)
		if reason == ReasonUnknownDialog {
			level = slog.LevelDebug
		}
		s.log.Log(ctx, level, "refusing a hangup", "legId", request.LegID, "reason", reason, "error", err)
		return s.refuseHangup(request.LegID, reason, message)
	}
	if !method.Valid() {
		// A method outside the contract's vocabulary is an implementation bug, and reporting it
		// verbatim would put an unparseable value on a closed vocabulary. `none` claims no packet.
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

// HandleReinvite answers `rpc.sip.v1.reinvite` — and refuses it, by name.
//
// sipgo supplies none of a re-INVITE (design §9.2): the INVITE server transaction is never swapped,
// there is no offer/answer version tracking, and RFC 3261 §14.2 glare handling (491 plus the
// asymmetric retry interval) is absent. Shipping it without glare handling would let simultaneous
// holds leave two dialogs each believing they own an outstanding offer, with media direction decided
// by whichever answer landed last — a privacy incident rather than a degraded feature.
//
// It validates first and refuses second, so a malformed reinvite is `bad_request` while a
// well-formed one is `not_supported`: "these bytes will never work" and "this build cannot do this
// yet" are different instructions to the caller. It does not look the dialog up, because the answer
// is the same for a leg we hold and one we do not.
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

// HandleResolveTarget answers `rpc.sip.v1.resolve-target`: where would this target be dialled, if it
// were dialled now. Flat and queue-grouped, because it creates nothing and any instance can answer.
//
// Target resolution is optional on the Dialogs implementation, so an implementation that does not
// offer it is reported as `not_supported` rather than as a missing subject.
func (s *Server) HandleResolveTarget(data []byte) []byte {
	// The resolve request is the legId/orgId/target subset of originate's contract.
	var request contract.SipOriginateRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseOriginate("", ReasonBadRequest, "malformed target resolution request")
	}
	if request.LegID == "" || request.OrgID == "" {
		return s.refuseOriginate(request.LegID, ReasonBadRequest, "legId and orgId are required")
	}
	if detail, ok := validTarget(request.Target); !ok {
		return s.refuseOriginate(request.LegID, ReasonBadRequest, detail)
	}
	resolver, ok := s.dialogs.(interface {
		ResolveTarget(context.Context, string, contract.SipOriginateRequestTarget) (contract.SipResolveTargetResponse, error)
	})
	if !ok {
		return s.refuseOriginate(request.LegID, ReasonNotSupported, "target resolution is not available")
	}
	ctx, cancel := commandContext()
	defer cancel()
	reply, err := resolver.ResolveTarget(ctx, request.OrgID, request.Target)
	if err != nil {
		reason, detail := refusalFor(err)
		return s.refuseOriginate(request.LegID, reason, detail)
	}
	reply.LegID = request.LegID
	return encode(s.log, reply)
}

// HandleOriginate answers `rpc.sip.v1.originate`: place an outbound call.
//
// Served flat and queue-grouped as well as per instance, because it CREATES the dialog and has no
// owner to find. The reply carries this instance's id, and the engine addresses every subsequent
// command for the leg at exactly that instance.
//
// It replies when the INVITE has been SENT, not when it is answered: the far end's ringing is a full
// transaction away and arrives as `dialog.progressed`, the 2xx as `dialog.answered`.
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
		// Without it there is no org token for this leg's event subjects, so the call would end
		// silently and the engine would never learn why.
		return s.refuseOriginate(request.LegID, ReasonBadRequest,
			"orgId is required: it is the subject token this leg's dialog events are published under")
	case request.CallID == "":
		return s.refuseOriginate(request.LegID, ReasonBadRequest, "callId is required")
	case request.SDPOffer == "":
		// The offer is mediad's, written by `create-offer`. A body-less INVITE is refused or
		// mishandled by many carriers and handsets, and the failure mode is silent audio.
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
		s.log.Log(ctx, levelFor(reason), "refusing an originate",
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

// validTarget applies `sipDialTargetSchema`'s refinement on this side of the border: the generated
// struct is a tagged struct with three optional groups (Go has no sum type), so the kind/field
// pairing must be checked here. Without it a `{kind:"trunk"}` with no trunkId reaches the dial path
// as an empty string and becomes an `unknown_trunk` refusal, blaming the directory for a malformed
// request.
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

// refusalFor maps internal/dialog's refusal errors onto SIP_DIALOG_REFUSAL_REASONS.
//
// errors.Is rather than a type switch, because the implementation wraps to put context in the log
// line; a type switch would collapse every wrapped refusal to `internal` and tell the engine to give
// up on a call it should have retried elsewhere. The detail is the error's own text, since a caller
// branches on the code and never on it. The default is `internal`: an error this table does not
// recognise is a failure nobody classified, and `capacity` or `no_route` would be a guess that sends
// the engine retrying elsewhere.
// expectedRefusals are the outcomes a healthy platform produces on its own: a phone that closed its
// tab, a leg the engine has already torn down, a drain. They are recorded as facts about the call,
// not as warnings about this process, because a warning nobody can act on trains operators to
// ignore the ones they can.
var expectedRefusals = map[string]bool{
	ReasonUnknownDialog:      true,
	ReasonDialogGone:         true,
	ReasonInvalidState:       true,
	ReasonUnregisteredTarget: true,
	ReasonNoRoute:            true,
	ReasonShuttingDown:       true,
}

// levelFor is how loudly a refusal is reported.
func levelFor(reason string) slog.Level {
	if expectedRefusals[reason] {
		return slog.LevelInfo
	}
	return slog.LevelWarn
}

func refusalFor(err error) (reason, detail string) {
	if err == nil {
		return ReasonInternal, "no error"
	}
	detail = err.Error()

	switch {
	case errors.Is(err, dialog.ErrUnknownDialog):
		return ReasonUnknownDialog, detail
	case errors.Is(err, dialog.ErrDialogGone), errors.Is(err, dialog.ErrCancelTooLate):
		// From a COMMAND's point of view a dialog that has already had its final response is gone;
		// the distinction the dialog layer draws is about answering a CANCEL's transaction, which no
		// engine command has.
		return ReasonDialogGone, detail
	case errors.Is(err, dialog.ErrInvalidState), errors.Is(err, dialog.ErrWrongRole):
		// ErrWrongRole is `invalid_state` and not `bad_request`: the request was well formed and the
		// DIALOG is the wrong shape for it — an `answer` addressed at a leg this edge originated.
		return ReasonInvalidState, detail
	case errors.Is(err, dialog.ErrSessionClosed):
		// The dialog's goroutine has stopped, which on this edge means a drain. `shutting_down` tells
		// the engine not to retry HERE; only another instance can work.
		return ReasonShuttingDown, detail
	case errors.Is(err, dialog.ErrDuplicateLeg):
		// A second originate for a leg id already in flight: the request is well formed, so the
		// engine's recovery is to look at the leg it already has rather than to fix the bytes.
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
		// The handler ran out of time waiting for a dialog goroutine. Nothing about the request or
		// the dialog was wrong, so `internal` is right.
		return ReasonInternal, detail
	default:
		return ReasonInternal, detail
	}
}
