package control

import (
	"encoding/json"
	"errors"
	"fmt"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// `rpc.media.v1.tap-session` and its partner, served — which is the last of design doc §10 question
// 4's W6 addendum coming true.
//
// The addendum's claim was that shaping the contract as an ASYMMETRIC BRIDGE PARTICIPANT rather than
// as a snoop channel would let rung 6 serve it "by arriving, not by being extended". It arrived: the
// handler below validates two enum fields and calls `Manager.Tap`, which builds a `JoinOptions` and
// calls the same `join` a plain conference participant calls. There is no tap-specific code in the
// mixer at all — eavesdrop, whisper and barge are three `Audience` pairs.
//
// The gap the first version of this file named loudly is closed. `MediaPort.TapRequest` has always
// carried a `targetSide` saying which side of the conversation the target leg IS, and
// `mediaTapSessionRequestSchema` did not — so this implementation fixed the only convention it could
// defend from the ids in the request (`a` is the target, `b` is the other party) and the engine had
// to pass, as `targetSessionId`, the leg it would have called side `a`. The field is on the wire
// now, OPTIONAL, and absent still means that convention: an engine that has not been taught to send
// it behaves exactly as it did. See `Manager.Tap` and `resolveAudiences`.

// HandleTapSession joins a supervisor to a conversation on asymmetric terms. Rung 6.
//
// The order of operations is the family's — everything REFUSABLE is decided before anything changes
// — with one addition specific to this command: the two SIDE fields are validated before the target
// is looked up, because `hear: "left"` is a caller bug that should read the same whether or not the
// call it names still exists.
func (s *Server) HandleTapSession(data []byte) []byte {
	var request contract.MediaTapSessionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseTap("", ReasonBadRequest, fmt.Sprintf("malformed tap request: %v", err))
	}
	switch {
	case request.TapID == "":
		return s.refuseTap("", ReasonBadRequest,
			"tapId is required and must be assigned by the caller: untap-session carries nothing else")
	case request.TapSessionID == "":
		return s.refuseTap(request.TapID, ReasonBadRequest,
			"tapSessionId is required: a tap is a routing statement about sessions that already exist, "+
				"and mediad does not allocate the supervisor's leg for them")
	case request.TargetSessionID == "":
		return s.refuseTap(request.TapID, ReasonBadRequest, "targetSessionId is required")
	}

	hear, err := rtp.ParseSide(string(request.Hear))
	if err != nil {
		return s.refuseTap(request.TapID, ReasonBadRequest, err.Error())
	}
	speakTo, err := rtp.ParseSide(string(request.SpeakTo))
	if err != nil {
		return s.refuseTap(request.TapID, ReasonBadRequest, err.Error())
	}
	// ABSENT is legal and means SideA — the target-first convention that predates the field. It is
	// left empty here rather than defaulted, so `resolveAudiences` is the single place that decision
	// is written down instead of two places that could drift.
	var targetSide rtp.Side
	if request.TargetSide != nil {
		targetSide, err = rtp.ParseSide(string(*request.TargetSide))
		if err != nil {
			return s.refuseTap(request.TapID, ReasonBadRequest, err.Error())
		}
	}

	result, err := s.sessions.Tap(rtp.TapOptions{
		TapID:           request.TapID,
		TapSessionID:    request.TapSessionID,
		TargetSessionID: request.TargetSessionID,
		TargetSide:      targetSide,
		Hear:            hear,
		SpeakTo:         speakTo,
		Mode:            derefString((*string)(request.Mode)),
	})
	if err != nil {
		reason := tapRefusalFor(err)
		if reason == ReasonUnknown {
			// The directory turns "I do not have this session" into the more useful "somebody else
			// does", exactly as it does for a bridge — and it matters more here, because a supervisor
			// told "no such call" about a call that is live on a neighbour will try again and get the
			// same answer forever.
			reason = s.locateRefusal([]string{request.TargetSessionID, request.TapSessionID})
		}
		s.log.Warn("refusing a tap",
			"tapId", request.TapID, "targetSessionId", request.TargetSessionID,
			"hear", string(request.Hear), "speakTo", string(request.SpeakTo),
			"reason", reason, "error", err)
		return s.refuseTap(request.TapID, reason, err.Error())
	}

	// The room is stamped onto every member's directory entry, so a neighbour asked about any leg in
	// a supervised call can see there is one. It reuses the BRIDGE field deliberately: a conference
	// converted from a bridge keeps the bridge's id, and a second field for "the room this is in"
	// would be two names for one fact that could disagree.
	s.noteBridge(result.ConferenceID, result.SessionIDs)

	return encode(s.log, contract.MediaTapSessionResponse{
		Ok:         true,
		TapID:      request.TapID,
		BridgeID:   stringPtr(result.ConferenceID),
		SessionIDs: result.SessionIDs,
		InstanceID: stringPtr(s.instanceID),
	})
}

// tapRefusalFor classifies a tap failure onto the wire's refusal vocabulary.
func tapRefusalFor(err error) string {
	switch {
	case errors.Is(err, rtp.ErrUnknownSession):
		return ReasonUnknown
	case errors.Is(err, rtp.ErrClosed):
		return ReasonShuttingDown
	case errors.Is(err, rtp.ErrNotInConversation):
		// A leg that is talking to nobody, or a side letter that means nothing in a room of five.
		// `bad_request` rather than `not_supported`: the capability exists and the request does not
		// describe a conversation, so routing the leg to Asterisk would not help.
		return ReasonBadRequest
	case errors.Is(err, rtp.ErrConferenceCodec), errors.Is(err, rtp.ErrCannotTranscode):
		// A leg whose codec cannot be decoded cannot be in a mix, and a tap is a mix. `not_supported`
		// with the codec named, which the engine answers by routing supervision for that call to
		// Asterisk — the per-capability cutover working exactly as designed.
		return ReasonNotSupported
	default:
		return ReasonBadRequest
	}
}

func (s *Server) refuseTap(tapID, reason, message string) []byte {
	code := contract.MediaTapSessionResponseReason(reason)
	return encode(s.log, contract.MediaTapSessionResponse{
		Ok:         false,
		TapID:      tapID,
		SessionIDs: []string{},
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// HandleUntapSession takes a tap down, leaving the monitored conversation running.
//
// An unknown tap is `ok:true, untapped:false` — a SUCCESS, and the same shape `unbridge` and
// `stop-playback` use for the same reason: the engine retries, and a retry after a lost reply must
// not look like a failure.
//
// Note what this deliberately does NOT do: it does not put the two remaining parties back on a
// relay. Switching a live conversation from mix to relay means dropping the buffered frames and
// resetting both codecs mid-sentence to give back sixty milliseconds the call has already had. See
// the package note on internal/rtp/conference.go.
func (s *Server) HandleUntapSession(data []byte) []byte {
	var request contract.MediaUntapSessionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseUntap("", ReasonBadRequest, fmt.Sprintf("malformed untap request: %v", err))
	}
	if request.TapID == "" {
		return s.refuseUntap("", ReasonBadRequest, "tapId is required")
	}

	_, untapped := s.sessions.Untap(request.TapID)

	return encode(s.log, contract.MediaUntapSessionResponse{
		Ok:         true,
		TapID:      request.TapID,
		Untapped:   untapped,
		InstanceID: stringPtr(s.instanceID),
	})
}

func (s *Server) refuseUntap(tapID, reason, message string) []byte {
	code := contract.MediaUntapSessionResponseReason(reason)
	return encode(s.log, contract.MediaUntapSessionResponse{
		Ok:         false,
		TapID:      tapID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}
