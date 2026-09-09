package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// HandleAllocateSession reserves a port pair and answers an SDP offer.
//
// The offer is parsed before any port is bound, so a refusal costs no capacity. Allocate is
// idempotent on session id, and the directory entry is written last and non-fatally.
func (s *Server) HandleAllocateSession(data []byte) []byte {
	var request contract.MediaAllocateSessionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseAllocate("", ReasonBadRequest, fmt.Sprintf("malformed allocate request: %v", err))
	}
	if request.SessionID == "" {
		return s.refuseAllocate("", ReasonBadRequest,
			"sessionId is required and must be assigned by the caller")
	}
	if request.CallID == "" {
		return s.refuseAllocate(request.SessionID, ReasonBadRequest, "callId is required")
	}
	if request.OrgID == "" {
		// Without an org token there is no subject for this session's lifecycle events, so the session
		// would end silently and the engine would never learn why.
		return s.refuseAllocate(request.SessionID, ReasonBadRequest,
			"orgId is required: it is the subject token this session's lifecycle events are published under")
	}
	if message := tenancyRefusal(request.OrgID, request.CallID); message != "" {
		return s.refuseAllocate(request.SessionID, ReasonBadRequest, message)
	}
	if request.SDPOffer == "" {
		return s.refuseAllocate(request.SessionID, ReasonBadRequest, "sdpOffer is required")
	}
	// One parse for the whole handler: Offer carries the transport as well as the codecs, so the
	// transport-only reader is needed only when the offer did not parse far enough to report it —
	// a SAVPF offer whose codecs are WebRTC's, or a malformed one whose refusal is decided below.
	offer, offerErr := sdp.ParseOffer(request.SDPOffer)
	protocol := offer.AudioProtocol
	if offerErr != nil {
		var err error
		if protocol, err = sdp.AudioProtocol(request.SDPOffer); err != nil {
			return s.refuseAllocate(request.SessionID, ReasonBadRequest, err.Error())
		}
	}
	if protocol == "UDP/TLS/RTP/SAVPF" {
		return s.allocateWebRTC(request)
	}
	if protocol != "RTP/AVP" && protocol != "RTP/AVPF" {
		return s.refuseAllocate(request.SessionID, ReasonNotSupported, "unsupported audio transport: "+protocol)
	}

	requested, err := sdp.ParseDirection(string(request.Direction))
	if err != nil {
		return s.refuseAllocate(request.SessionID, ReasonBadRequest, err.Error())
	}
	// A repeat allocate carrying a NEW direction is a re-INVITE, which is how hold arrives here. See
	// directionToMutes for how RFC 3264's four directions become the media plane's two gates.

	if offerErr != nil {
		reason := ReasonBadRequest
		if errors.Is(offerErr, sdp.ErrNoCommonCodec) {
			// A valid offer this media plane cannot serve. `not_supported` rather than `bad_request`,
			// because the engine's recovery is to route the leg to Asterisk, not to fix the bytes and retry.
			reason = ReasonNotSupported
		}
		return s.refuseAllocate(request.SessionID, reason, offerErr.Error())
	}

	answerDirection := sdp.AnswerDirection(offer.Direction, requested)
	muteIn, muteOut := directionToMutes(answerDirection)

	descriptor, err := s.sessions.Allocate(rtp.AllocateOptions{
		SessionID:                 request.SessionID,
		OrgID:                     request.OrgID,
		CallID:                    request.CallID,
		LegID:                     derefString(request.LegID),
		AudioPayloadType:          offer.AudioPayloadType,
		Format:                    offer.Codec.Format(),
		TelephoneEventPayloadType: offer.TelephoneEventPayloadType,
		Inactive:                  answerDirection == sdp.DirectionInactive,
		MuteIn:                    muteIn,
		MuteOut:                   muteOut,
	})
	if err != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(err, rtp.ErrPortsExhausted):
			reason = ReasonCapacity
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		// WARN rather than ERROR: capacity and shutdown are operational states, and a deploy would
		// otherwise page on every drain.
		s.log.Warn("refusing an allocate",
			"sessionId", request.SessionID, "callId", request.CallID,
			"reason", reason, "error", err)
		return s.refuseAllocate(request.SessionID, reason, err.Error())
	}

	// A repeat allocate for a live session is a retry when the direction is unchanged and a
	// re-negotiation when it differs. Allocate itself stays idempotent: no second port, no mode change.
	if err := s.sessions.ApplyDirection(request.SessionID, muteIn, muteOut); err != nil {
		s.log.Warn("could not apply a renegotiated direction",
			"sessionId", request.SessionID, "direction", answerDirection, "error", err)
	}

	sessionID, sessionVersion := sdpSessionIDs(descriptor.RTPPort)
	negotiated := sdp.CodecForFormat(descriptor.Format)
	toAnswer := sdp.Answer{
		SessionID:                 sessionID,
		SessionVersion:            sessionVersion,
		Address:                   s.publicAddr,
		Port:                      descriptor.RTPPort,
		Codec:                     negotiated,
		AudioPayloadType:          descriptor.AudioPayloadType,
		TelephoneEventPayloadType: descriptor.TelephoneEventPayloadType,
		OpusFmtp:                  offer.OpusFmtp,
		Direction:                 answerDirection,
	}
	if err := toAnswer.Validate(); err != nil {
		// A dynamic codec that reached here without its payload type would render under PT 0, which
		// the far end reads as PCMU: a call with audio that is noise. Refuse instead.
		s.log.Error("cannot render an answer for a negotiated session",
			"sessionId", request.SessionID, "codec", negotiated, "error", err)
		// The port pair is already held; releasing it keeps a rendering failure from leaking capacity.
		s.sessions.Release(request.SessionID)
		return s.refuseAllocate(request.SessionID, ReasonInternal, err.Error())
	}
	answer := sdp.BuildAnswer(toAnswer)

	s.recordSession(request, descriptor)

	codec := string(negotiated)
	response := contract.MediaAllocateSessionResponse{
		Ok:         true,
		SessionID:  descriptor.SessionID,
		SDPAnswer:  stringPtr(answer),
		InstanceID: stringPtr(s.instanceID),
		Address:    stringPtr(descriptor.Address.String()),
		RtpPort:    intPtr(descriptor.RTPPort),
		RtcpPort:   intPtr(descriptor.RTCPPort),
		Ssrc:       intPtr(int(descriptor.SSRC)),
		Codec:      (*contract.MediaAllocateSessionResponseCodec)(&codec),
	}
	if descriptor.TelephoneEventPayloadType != 0 {
		response.TelephoneEventPayloadType = intPtr(int(descriptor.TelephoneEventPayloadType))
	}
	return encode(s.log, response)
}

// recordSession writes the directory entry, and does NOT fail the allocate when it cannot.
//
// The session is already bound and answerable, so failing the command would fail a call that works
// AND hold the port until the reaper. The bounded consequence of the missed write is that
// neighbours cannot route to this session.
func (s *Server) recordSession(
	request contract.MediaAllocateSessionRequest,
	descriptor rtp.Descriptor,
) {
	s.recordSessionEntry(request.OrgID, request.CallID, derefString(request.LegID), descriptor)
}

// recordSessionEntry is the directory write both allocate and create-offer make, taking the tenancy
// as primitives so the two commands share one entry shape and one best-effort failure rule.
func (s *Server) recordSessionEntry(orgID, callID, legID string, descriptor rtp.Descriptor) {
	ctx, cancel := dirContext()
	defer cancel()

	entry := directory.Entry{
		SessionID:   descriptor.SessionID,
		InstanceID:  s.instanceID,
		OrgID:       orgID,
		CallID:      callID,
		LegID:       legID,
		Address:     descriptor.Address.String(),
		RTPPort:     descriptor.RTPPort,
		RTCPPort:    descriptor.RTCPPort,
		Codec:       string(sdp.CodecForFormat(descriptor.Format)),
		AllocatedAt: nowMillis(),
	}
	if err := s.dir.Put(ctx, entry); err != nil {
		s.log.Warn("could not record the session directory entry; neighbours cannot route to it",
			"sessionId", descriptor.SessionID, "error", err)
	}
}

func (s *Server) refuseAllocate(sessionID, reason, message string) []byte {
	code := contract.MediaAllocateSessionResponseReason(reason)
	return encode(s.log, contract.MediaAllocateSessionResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// offeredCodecs is what create-offer proposes, in preference order: exactly what mediad can serve,
// narrowband first, matching the answer path's preference.
var offeredCodecs = []sdp.Codec{sdp.CodecPCMU, sdp.CodecPCMA}

// HandleCreateOffer allocates a port pair for a B-leg that has NO inbound offer and writes the offer.
//
// mediad is the only process that knows its own ports, codecs and reachable address, so it writes
// the offer for an originated leg. As in allocate, everything refusable is decided before a port is
// bound, and the allocation is idempotent on sessionId. The session starts on mediad's default codec
// because the real codec is the callee's to pick and is not known until accept-answer.
func (s *Server) HandleCreateOffer(data []byte) []byte {
	var request contract.MediaCreateOfferRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseCreateOffer("", ReasonBadRequest,
			fmt.Sprintf("malformed create-offer request: %v", err))
	}
	switch {
	case request.SessionID == "":
		return s.refuseCreateOffer("", ReasonBadRequest,
			"sessionId is required and must be assigned by the caller")
	case request.CallID == "":
		return s.refuseCreateOffer(request.SessionID, ReasonBadRequest, "callId is required")
	case request.OrgID == "":
		return s.refuseCreateOffer(request.SessionID, ReasonBadRequest,
			"orgId is required: it is the subject token this session's lifecycle events are published under")
	}
	if message := tenancyRefusal(request.OrgID, request.CallID); message != "" {
		return s.refuseCreateOffer(request.SessionID, ReasonBadRequest, message)
	}
	if request.Transport != nil && string(*request.Transport) == "webrtc" {
		return s.createWebRTCOffer(request)
	}
	if request.Transport != nil && string(*request.Transport) != "rtp" {
		return s.refuseCreateOffer(request.SessionID, ReasonBadRequest, "unsupported media transport")
	}

	direction, err := sdp.ParseDirection(string(request.Direction))
	if err != nil {
		return s.refuseCreateOffer(request.SessionID, ReasonBadRequest, err.Error())
	}
	muteIn, muteOut := directionToMutes(direction)

	descriptor, err := s.sessions.Allocate(rtp.AllocateOptions{
		SessionID: request.SessionID,
		OrgID:     request.OrgID,
		CallID:    request.CallID,
		LegID:     derefString(request.LegID),
		// The DEFAULT codec, not the negotiated one: the callee has not answered yet, so the session starts
		// on PCMU with telephone-event 101 and accept-answer settles the real choice.
		AudioPayloadType:          rtp.PayloadTypePCMU,
		Format:                    audio.FormatULaw,
		TelephoneEventPayloadType: rtp.PayloadTypeTelephoneEvent,
		Inactive:                  direction == sdp.DirectionInactive,
		MuteIn:                    muteIn,
		MuteOut:                   muteOut,
	})
	if err != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(err, rtp.ErrPortsExhausted):
			reason = ReasonCapacity
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		s.log.Warn("refusing a create-offer",
			"sessionId", request.SessionID, "callId", request.CallID,
			"reason", reason, "error", err)
		return s.refuseCreateOffer(request.SessionID, reason, err.Error())
	}

	sessionID, sessionVersion := sdpSessionIDs(descriptor.RTPPort)
	offer := sdp.BuildOffer(sdp.OfferParams{
		SessionID:                 sessionID,
		SessionVersion:            sessionVersion,
		Address:                   s.publicAddr,
		Port:                      descriptor.RTPPort,
		Codecs:                    offeredCodecs,
		TelephoneEventPayloadType: descriptor.TelephoneEventPayloadType,
		Direction:                 direction,
	})

	s.recordSessionEntry(request.OrgID, request.CallID, derefString(request.LegID), descriptor)

	response := contract.MediaCreateOfferResponse{
		Ok:         true,
		SessionID:  descriptor.SessionID,
		SDPOffer:   stringPtr(offer),
		InstanceID: stringPtr(s.instanceID),
		Address:    stringPtr(descriptor.Address.String()),
		RtpPort:    intPtr(descriptor.RTPPort),
		RtcpPort:   intPtr(descriptor.RTCPPort),
		Ssrc:       intPtr(int(descriptor.SSRC)),
	}
	if descriptor.TelephoneEventPayloadType != 0 {
		response.TelephoneEventPayloadType = intPtr(int(descriptor.TelephoneEventPayloadType))
	}
	return encode(s.log, response)
}

func (s *Server) refuseCreateOffer(sessionID, reason, message string) []byte {
	code := contract.MediaCreateOfferResponseReason(reason)
	return encode(s.log, contract.MediaCreateOfferResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// HandleAcceptAnswer settles the callee's negotiated codec onto a B-leg created by create-offer.
//
// A codec mediad cannot serve is `not_supported`, and the engine's recovery is to hang the B-leg up
// with an incompatible-destination cause. An unknown sessionId is `unknown_session`: the answer
// arrived for a leg this instance does not hold.
func (s *Server) HandleAcceptAnswer(data []byte) []byte {
	var request contract.MediaAcceptAnswerRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseAcceptAnswer("", ReasonBadRequest,
			fmt.Sprintf("malformed accept-answer request: %v", err))
	}
	switch {
	case request.SessionID == "":
		return s.refuseAcceptAnswer("", ReasonBadRequest, "sessionId is required")
	case request.SDPAnswer == "":
		return s.refuseAcceptAnswer(request.SessionID, ReasonBadRequest, "sdpAnswer is required")
	}
	// The answer is a session description, so the offer parser reads it: an answer names one codec,
	// and ParseOffer returns the first (here, only) one it recognises plus any telephone-event type.
	// It also reports the transport, so this is the only parse of the answer; the transport-only
	// reader runs only when that parse failed, to keep a transport refusal ahead of a codec one.
	answer, answerErr := sdp.ParseOffer(request.SDPAnswer)
	protocol := answer.AudioProtocol
	if answerErr != nil {
		var err error
		if protocol, err = sdp.AudioProtocol(request.SDPAnswer); err != nil {
			return s.refuseAcceptAnswer(request.SessionID, ReasonBadRequest, err.Error())
		}
	}
	if value, ok := s.webRTCSessions.Load(request.SessionID); ok {
		if protocol != "UDP/TLS/RTP/SAVPF" {
			return s.refuseAcceptAnswer(request.SessionID, ReasonNotSupported, "WebRTC requires an encrypted answer")
		}
		entry := value.(*webRTCSession)
		entry.mu.Lock()
		transport := entry.transport
		entry.mu.Unlock()
		if transport == nil {
			return s.refuseAcceptAnswer(request.SessionID, ReasonBadRequest, "WebRTC session has no offer")
		}
		if err := transport.AcceptAnswer(request.SDPAnswer); err != nil {
			return s.refuseAcceptAnswer(request.SessionID, ReasonNotSupported, err.Error())
		}
	} else if protocol != "RTP/AVP" && protocol != "RTP/AVPF" {
		return s.refuseAcceptAnswer(request.SessionID, ReasonNotSupported, "answer changed the media transport")
	}

	if answerErr != nil {
		reason := ReasonBadRequest
		if errors.Is(answerErr, sdp.ErrNoCommonCodec) {
			// A valid answer naming a codec mediad does not carry at all. `not_supported`, so the
			// engine hangs the B-leg up rather than retrying the same bytes.
			reason = ReasonNotSupported
		}
		return s.refuseAcceptAnswer(request.SessionID, reason, answerErr.Error())
	}
	// mediad offered ONLY G.711, so an answer must land on PCMU or PCMA. A parser that recognises a
	// wider set can return one mediad never offered; refusing it here keeps the answer bounded to what
	// create-offer actually proposed.
	if answer.Codec != sdp.CodecPCMU && answer.Codec != sdp.CodecPCMA {
		return s.refuseAcceptAnswer(request.SessionID, ReasonNotSupported,
			fmt.Sprintf("the answer settled on %s, and create-offer proposed only PCMU and PCMA", answer.Codec))
	}

	descriptor, err := s.sessions.SettleAnswer(
		request.SessionID, answer.Codec.Format(), answer.AudioPayloadType, answer.TelephoneEventPayloadType)
	if err != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(err, rtp.ErrUnknownSession):
			reason = s.locateRefusal([]string{request.SessionID})
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		s.log.Warn("refusing an accept-answer",
			"sessionId", request.SessionID, "reason", reason, "error", err)
		return s.refuseAcceptAnswer(request.SessionID, reason, err.Error())
	}

	settled := string(sdp.CodecForFormat(descriptor.Format))
	response := contract.MediaAcceptAnswerResponse{
		Ok:         true,
		SessionID:  descriptor.SessionID,
		Codec:      (*contract.MediaAcceptAnswerResponseCodec)(&settled),
		InstanceID: stringPtr(s.instanceID),
	}
	if descriptor.TelephoneEventPayloadType != 0 {
		response.TelephoneEventPayloadType = intPtr(int(descriptor.TelephoneEventPayloadType))
	}
	return encode(s.log, response)
}

func (s *Server) refuseAcceptAnswer(sessionID, reason, message string) []byte {
	code := contract.MediaAcceptAnswerResponseReason(reason)
	return encode(s.log, contract.MediaAcceptAnswerResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// maxBridgeSessions mirrors `MEDIA_BRIDGE_MAX_SESSIONS` in packages/events, restated rather than
// imported because the emitter turns a `.max(n)` into a validation rule and not into a Go constant.
// It is a CAPACITY decision: the mixer sums every member's audio once per member per frame, so the
// cost is quadratic in the room.
const maxBridgeSessions = 8

// HandleBridgeSessions puts two or more sessions in one conversation.
//
// Two sessions are relayed and three or more are mixed in a room. Which mechanism carries the audio
// is this process's decision rather than the caller's, because it is a property of a mixer the
// engine cannot see.
//
// A join that fails takes the whole room down and refuses the command: a half-converted room, some
// members mixing and some relaying, is a call where one party can hear and another cannot, which
// reads as a network fault and is not one.
func (s *Server) HandleBridgeSessions(data []byte) []byte {
	var request contract.MediaBridgeSessionsRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseBridge("", ReasonBadRequest, fmt.Sprintf("malformed bridge request: %v", err))
	}
	if request.BridgeID == "" {
		return s.refuseBridge("", ReasonBadRequest, "bridgeId is required")
	}
	switch {
	case len(request.SessionIDs) < 2:
		// A conversation of one is not a conversation. The contract says `.min(2)`, so this fires
		// only for a caller that bypassed it.
		return s.refuseBridge(request.BridgeID, ReasonBadRequest,
			fmt.Sprintf("a conversation needs at least two sessions, got %d", len(request.SessionIDs)))
	case len(request.SessionIDs) > maxBridgeSessions:
		// `not_supported` and not `bad_request`, because the engine's recovery is to route this room to
		// Asterisk, whose mixing bridge has no such ceiling. A retry of the same bytes fails the same way.
		return s.refuseBridge(request.BridgeID, ReasonNotSupported,
			fmt.Sprintf("this mixer holds %d members and %d were asked for; a larger room needs a "+
				"running-sum mixer rather than a larger constant",
				maxBridgeSessions, len(request.SessionIDs)))
	}

	if len(request.SessionIDs) > 2 {
		return s.bridgeAsConference(request)
	}

	err := s.sessions.Bridge(request.BridgeID, request.SessionIDs[0], request.SessionIDs[1])
	if err != nil {
		reason := ReasonBadRequest
		switch {
		case errors.Is(err, rtp.ErrUnknownSession):
			reason = s.locateRefusal(request.SessionIDs)
		case errors.Is(err, rtp.ErrCodecMismatch):
			reason = ReasonNotSupported
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		s.log.Warn("refusing a bridge",
			"bridgeId", request.BridgeID, "sessionIds", request.SessionIDs,
			"reason", reason, "error", err)
		return s.refuseBridge(request.BridgeID, reason, err.Error())
	}

	s.noteBridge(request.BridgeID, request.SessionIDs)

	return encode(s.log, contract.MediaBridgeSessionsResponse{
		Ok:         true,
		BridgeID:   request.BridgeID,
		SessionIDs: request.SessionIDs,
		InstanceID: stringPtr(s.instanceID),
	})
}

// bridgeAsConference seats three or more sessions in one room under the BRIDGE's id, so that the
// engine's `unbridge-sessions` still names something.
//
// Every member is a plain participant — hears everyone, is heard by everyone — because that is what
// a bridge means. Asymmetric membership is what `tap-session` is for.
func (s *Server) bridgeAsConference(request contract.MediaBridgeSessionsRequest) []byte {
	joined := make([]string, 0, len(request.SessionIDs))
	for _, sessionID := range request.SessionIDs {
		err := s.sessions.JoinConference(request.BridgeID, sessionID, rtp.JoinOptions{
			Hear:    rtp.Everyone(),
			SpeakTo: rtp.Everyone(),
		})
		if err == nil {
			joined = append(joined, sessionID)
			continue
		}

		// Everything goes back: a partially built room is worse than no room, because it sounds like a
		// network fault to the members who did make it in.
		s.sessions.DestroyConference(request.BridgeID)

		reason := ReasonBadRequest
		switch {
		case errors.Is(err, rtp.ErrUnknownSession):
			reason = s.locateRefusal(request.SessionIDs)
		case errors.Is(err, rtp.ErrConferenceCodec), errors.Is(err, rtp.ErrCannotTranscode):
			// A leg whose codec cannot be decoded cannot be in a mix. `not_supported` with the codec
			// named, which the engine answers by routing this room to Asterisk.
			reason = ReasonNotSupported
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		s.log.Warn("refusing a conference bridge",
			"bridgeId", request.BridgeID, "sessionIds", request.SessionIDs,
			"seated", len(joined), "reason", reason, "error", err)
		return s.refuseBridge(request.BridgeID, reason, err.Error())
	}

	// The room is stamped onto every member's directory entry, reusing the BRIDGE field exactly as a
	// tap-converted room does: a second field for "the room this is in" would be two names for one
	// fact that could disagree.
	s.noteBridge(request.BridgeID, request.SessionIDs)

	return encode(s.log, contract.MediaBridgeSessionsResponse{
		Ok:         true,
		BridgeID:   request.BridgeID,
		SessionIDs: joined,
		Mixed:      true,
		InstanceID: stringPtr(s.instanceID),
	})
}

// locateRefusal turns "I do not have this session" into the more useful "somebody else does".
//
// `unknown_session` tells the engine its picture is stale; `wrong_instance` tells it the session is
// alive on a named neighbour. Those need opposite recoveries.
func (s *Server) locateRefusal(sessionIDs []string) string {
	ctx, cancel := dirContext()
	defer cancel()

	for _, id := range sessionIDs {
		entry, found, err := s.dir.Get(ctx, id)
		if err != nil {
			// A directory we cannot read tells us nothing, so we fall back to the honest answer we
			// can defend: this instance does not have it.
			s.log.Warn("cannot read the session directory", "sessionId", id, "error", err)
			continue
		}
		if found && entry.InstanceID != s.instanceID {
			return ReasonWrongNode
		}
	}
	return ReasonUnknown
}

// noteBridge stamps the bridge id onto both directory entries. Best-effort for the same reason
// recordSession is: the relay is already running, and failing the command over a KV write would tear
// down audio that works.
func (s *Server) noteBridge(bridgeID string, sessionIDs []string) {
	ctx, cancel := dirContext()
	defer cancel()

	for _, id := range sessionIDs {
		entry, found, err := s.dir.Get(ctx, id)
		if err != nil || !found {
			continue
		}
		entry.BridgeID = bridgeID
		if err := s.dir.Put(ctx, entry); err != nil {
			s.log.Warn("could not record a bridge in the session directory",
				"sessionId", id, "bridgeId", bridgeID, "error", err)
		}
	}
}

func (s *Server) refuseBridge(bridgeID, reason, message string) []byte {
	code := contract.MediaBridgeSessionsResponseReason(reason)
	return encode(s.log, contract.MediaBridgeSessionsResponse{
		Ok:         false,
		BridgeID:   bridgeID,
		SessionIDs: []string{},
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// HandleUnbridgeSessions stops a relay and leaves both sessions alive: an attended transfer moves a
// leg from one bridge to another, and tearing the session down in between would drop the call.
func (s *Server) HandleUnbridgeSessions(data []byte) []byte {
	var request contract.MediaUnbridgeSessionsRequest
	if err := json.Unmarshal(data, &request); err != nil {
		code := contract.MediaUnbridgeSessionsResponseReason(ReasonBadRequest)
		return encode(s.log, contract.MediaUnbridgeSessionsResponse{
			Ok:         false,
			SessionIDs: []string{},
			InstanceID: stringPtr(s.instanceID),
			Reason:     &code,
			Error:      stringPtr(fmt.Sprintf("malformed unbridge request: %v", err)),
		})
	}
	if request.BridgeID == "" {
		code := contract.MediaUnbridgeSessionsResponseReason(ReasonBadRequest)
		return encode(s.log, contract.MediaUnbridgeSessionsResponse{
			Ok:         false,
			SessionIDs: []string{},
			InstanceID: stringPtr(s.instanceID),
			Reason:     &code,
			Error:      stringPtr("bridgeId is required"),
		})
	}

	sessionIDs, unbridged := s.sessions.Unbridge(request.BridgeID)
	if sessionIDs == nil {
		sessionIDs = []string{}
	}
	if unbridged {
		s.noteBridge("", sessionIDs)
	}

	// An unknown bridge is `ok:true, unbridged:false` — a SUCCESS. The engine retries an unbridge,
	// and a retry after a lost reply must not look like a failure.
	return encode(s.log, contract.MediaUnbridgeSessionsResponse{
		Ok:         true,
		BridgeID:   request.BridgeID,
		Unbridged:  unbridged,
		SessionIDs: sessionIDs,
		InstanceID: stringPtr(s.instanceID),
	})
}

// HandleReleaseSession frees a session's ports and removes its directory entry. The delete is part
// of the CONTRACT: an entry that outlives its session is an instance name the engine keeps routing
// commands to, and every one of them answers `unknown_session`.
func (s *Server) HandleReleaseSession(data []byte) []byte {
	var request contract.MediaReleaseSessionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseRelease("", ReasonBadRequest,
			fmt.Sprintf("malformed release request: %v", err))
	}
	if request.SessionID == "" {
		return s.refuseRelease("", ReasonBadRequest, "sessionId is required")
	}

	released := s.sessions.Release(request.SessionID)

	// The delete runs whether or not there was a live session. A release for a session this instance
	// does not hold is the shape of a retry that landed on the wrong node after a failover, and leaving
	// the stale entry behind would leave the problem the delete exists to prevent.
	ctx, cancel := dirContext()
	defer cancel()
	if err := s.dir.Delete(ctx, request.SessionID); err != nil {
		s.log.Warn("could not remove a session directory entry",
			"sessionId", request.SessionID, "error", err)
	}

	return encode(s.log, contract.MediaReleaseSessionResponse{
		Ok:         true,
		SessionID:  request.SessionID,
		Released:   released,
		InstanceID: stringPtr(s.instanceID),
	})
}

func (s *Server) refuseRelease(sessionID, reason, message string) []byte {
	code := contract.MediaReleaseSessionResponseReason(reason)
	return encode(s.log, contract.MediaReleaseSessionResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// HandleStartPlayback plays a prompt towards a session's far end.
//
// Everything that can be REFUSED happens before anything changes state. The session is found first
// because the clip has to be decoded into the law THAT LEG answered, and the files are read and
// decoded before a single frame is scheduled, so a playback that reports `ok` is one whose audio is
// already in memory. That decode is also why this subject's deadline is 1 s where the rest are 500 ms.
func (s *Server) HandleStartPlayback(data []byte) []byte {
	var request contract.MediaStartPlaybackRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refusePlayback("", "", ReasonBadRequest,
			fmt.Sprintf("malformed start-playback request: %v", err))
	}
	switch {
	case request.SessionID == "":
		return s.refusePlayback("", request.PlaybackRef, ReasonBadRequest, "sessionId is required")
	case request.PlaybackRef == "":
		return s.refusePlayback(request.SessionID, "", ReasonBadRequest,
			"playbackRef is required and must be assigned by the caller: stop-playback carries nothing else")
	case len(request.Media) == 0:
		// A play of nothing answered `ok` would report a prompt that never happened, which is the
		// silent failure the whole refusal vocabulary exists to prevent.
		return s.refusePlayback(request.SessionID, request.PlaybackRef, ReasonBadRequest,
			"media is required: a playback needs at least one media reference")
	}

	payloadType, ok := s.sessions.AudioPayloadType(request.SessionID)
	if !ok {
		return s.refusePlayback(request.SessionID, request.PlaybackRef,
			s.locateRefusal([]string{request.SessionID}),
			fmt.Sprintf("no session %s on this instance", request.SessionID))
	}

	// `sound:` and `moh:` are files and need a configured prompt library; `tone:` is GENERATED, so
	// gating it on a mount would mean an instance that can bridge a call cannot signal ringback.
	if !s.library.Configured() && !isGeneratedRef(request.Media) {
		return s.refusePlayback(request.SessionID, request.PlaybackRef, ReasonNotSupported,
			"this instance has no prompt library: set MEDIAD_SOUNDS_DIR to the directory prompts are mounted at")
	}

	encoding := rtp.EncodingFor(payloadType)
	source, err := s.library.LoadSource(request.Media, encoding)
	if err != nil {
		reason := playbackRefusalFor(err)
		s.log.Warn("refusing a playback",
			"sessionId", request.SessionID, "playbackRef", request.PlaybackRef,
			"media", request.Media, "reason", reason, "error", err)
		return s.refusePlayback(request.SessionID, request.PlaybackRef, reason, err.Error())
	}

	startErr := s.sessions.StartPlayback(request.SessionID, rtp.PlaybackOptions{
		Ref:      request.PlaybackRef,
		Frames:   source.Clip.Frames,
		Encoding: source.Clip.Encoding,
		// The LOOP is derived from what was asked for rather than from a flag on the wire, which is
		// what stops a caller asking for a looping voicemail greeting. See audio.Source.
		Loop: source.Loop,
		Kind: playbackKindOf(source.Description),
	})
	if startErr != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(startErr, rtp.ErrUnknownSession):
			reason = ReasonUnknown
		case errors.Is(startErr, rtp.ErrClosed):
			reason = ReasonShuttingDown
		case errors.Is(startErr, rtp.ErrNoRemote):
			// The leg has not sent a packet yet, so symmetric RTP has taught us nowhere to send.
			// `bad_request` rather than `internal`: the engine asked for a prompt on a leg that is not
			// carrying media, and retrying the same request will fail the same way.
			reason = ReasonBadRequest
		case errors.Is(startErr, rtp.ErrPlaybackPayloadType):
			reason = ReasonNotSupported
		}
		s.log.Warn("refusing a playback",
			"sessionId", request.SessionID, "playbackRef", request.PlaybackRef,
			"reason", reason, "error", startErr)
		return s.refusePlayback(request.SessionID, request.PlaybackRef, reason, startErr.Error())
	}

	return encode(s.log, contract.MediaStartPlaybackResponse{
		Ok:          true,
		SessionID:   request.SessionID,
		PlaybackRef: request.PlaybackRef,
		InstanceID:  stringPtr(s.instanceID),
	})
}

// playbackRefusalFor classifies a library failure onto the wire's refusal vocabulary.
//
// `bad_request` is a prompt that is broken, so retrying these bytes fails the same way and somebody
// has to fix the file. `not_supported` is a capability this build does not have — a 44.1 kHz prompt,
// since mediad does not resample — which the engine answers by routing the leg to Asterisk.
func playbackRefusalFor(err error) string {
	switch {
	case errors.Is(err, audio.ErrNoLibrary),
		errors.Is(err, audio.ErrUnsupportedScheme),
		errors.Is(err, audio.ErrUnsupportedRate),
		errors.Is(err, audio.ErrUnsupportedChannels),
		errors.Is(err, audio.ErrUnsupportedFormat),
		// A tone name this build does not define. `not_supported` and not `bad_request`: Asterisk ships a
		// full tone zone for every country and mediad defines eight signals, so the engine's recovery is
		// the one every capability gap gets.
		errors.Is(err, audio.ErrUnknownTone):
		return ReasonNotSupported
	case errors.Is(err, audio.ErrNotFound),
		errors.Is(err, audio.ErrOutsideLibrary),
		errors.Is(err, audio.ErrNotRIFF),
		errors.Is(err, audio.ErrTruncated),
		errors.Is(err, audio.ErrTooLarge),
		errors.Is(err, audio.ErrEmpty),
		// A cadence that does not parse and a looping reference concatenated with a prompt are both
		// `bad_request` rather than `not_supported`: the capability EXISTS and the request is malformed, so
		// routing the leg to Asterisk would produce the same refusal one hop later.
		errors.Is(err, audio.ErrBadToneSpec),
		errors.Is(err, audio.ErrMixedSources):
		return ReasonBadRequest
	default:
		return ReasonInternal
	}
}

// isGeneratedRef reports whether a playback needs no file on disk.
func isGeneratedRef(refs []string) bool {
	for _, ref := range refs {
		if !strings.HasPrefix(strings.TrimSpace(ref), audio.SchemeTone) {
			return false
		}
	}
	return len(refs) > 0
}

// playbackKindOf labels a resolved source for the log line. Diagnostic only; see rtp.PlaybackKind.
func playbackKindOf(description string) rtp.PlaybackKind {
	switch {
	case strings.HasPrefix(description, audio.SchemeMOH):
		return rtp.PlaybackMusicOnHold
	case strings.HasPrefix(description, audio.SchemeTone):
		return rtp.PlaybackTone
	default:
		return rtp.PlaybackPrompt
	}
}

// directionToMutes turns an RFC 3264 answer direction into the media plane's two suppression gates.
//
//	sendrecv   both ways flow. The ordinary call.
//	sendonly   we send and do not receive, so what ARRIVES on this leg goes nowhere. mute(in).
//	recvonly   we receive and do not send, so the peer's audio is not written out. mute(out).
//	inactive   neither. Both gates up, and the session is additionally put in ModeInactive.
//
// Which PARTY hears music is the engine's decision and arrives as a separate `start-playback` of a
// `moh:` reference: "the held caller hears the queue's music" and "the holding agent hears nothing"
// are two commands about two legs, and inferring the second from the first would be a routing
// decision on the far side of the seam.
func directionToMutes(direction sdp.Direction) (muteIn, muteOut bool) {
	switch direction {
	case sdp.DirectionSendOnly:
		return true, false
	case sdp.DirectionRecvOnly:
		return false, true
	case sdp.DirectionInactive:
		return true, true
	default:
		return false, false
	}
}

func (s *Server) refusePlayback(sessionID, playbackRef, reason, message string) []byte {
	code := contract.MediaStartPlaybackResponseReason(reason)
	return encode(s.log, contract.MediaStartPlaybackResponse{
		Ok:          false,
		SessionID:   sessionID,
		PlaybackRef: playbackRef,
		InstanceID:  stringPtr(s.instanceID),
		Reason:      &code,
		Error:       stringPtr(message),
	})
}

// HandleStopPlayback interrupts a prompt by reference.
//
// A stop for a reference nothing is playing is `ok:true, stopped:false` — a SUCCESS, and the COMMON
// case: every `gather` stops its own prompt the moment collection ends, whatever ended it.
func (s *Server) HandleStopPlayback(data []byte) []byte {
	var request contract.MediaStopPlaybackRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseStopPlayback("", ReasonBadRequest,
			fmt.Sprintf("malformed stop-playback request: %v", err))
	}
	if request.PlaybackRef == "" {
		return s.refuseStopPlayback("", ReasonBadRequest, "playbackRef is required")
	}

	sessionID, stopped := s.sessions.StopPlayback(request.PlaybackRef)

	return encode(s.log, contract.MediaStopPlaybackResponse{
		Ok:          true,
		PlaybackRef: request.PlaybackRef,
		Stopped:     stopped,
		SessionID:   stringPtr(sessionID),
		InstanceID:  stringPtr(s.instanceID),
	})
}

func (s *Server) refuseStopPlayback(playbackRef, reason, message string) []byte {
	code := contract.MediaStopPlaybackResponseReason(reason)
	return encode(s.log, contract.MediaStopPlaybackResponse{
		Ok:          false,
		PlaybackRef: playbackRef,
		InstanceID:  stringPtr(s.instanceID),
		Reason:      &code,
		Error:       stringPtr(message),
	})
}

// HandleSendDtmf generates RFC 4733 digits towards a session's far end.
//
// Everything REFUSABLE is decided before anything is put on the wire. Two refusals matter:
//
//   - A leg that negotiated NO telephone-event payload type is `not_supported`, never an inband
//     tone: digits sent under a type the far end never agreed to are dropped, which reads as an IVR
//     that "randomly" ignores keypresses.
//   - A character with no event code is `bad_request` naming the character, decided over the WHOLE
//     string first, so a far-end IVR is never left holding a prefix of what was asked for.
func (s *Server) HandleSendDtmf(data []byte) []byte {
	var request contract.MediaSendDtmfRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseDtmf("", ReasonBadRequest, fmt.Sprintf("malformed send-dtmf request: %v", err))
	}
	switch {
	case request.SessionID == "":
		return s.refuseDtmf("", ReasonBadRequest, "sessionId is required")
	case request.Digits == "":
		return s.refuseDtmf(request.SessionID, ReasonBadRequest, "digits is required")
	}

	telephoneEventPT, ok := s.sessions.TelephoneEventPayloadType(request.SessionID)
	if !ok {
		return s.refuseDtmf(request.SessionID, s.locateRefusal([]string{request.SessionID}),
			fmt.Sprintf("no session %s on this instance", request.SessionID))
	}
	if telephoneEventPT == 0 {
		return s.refuseDtmf(request.SessionID, ReasonNotSupported,
			"this leg negotiated no RFC 4733 telephone-event payload type, and mediad has no tone "+
				"generator to fall back to")
	}

	opts := rtp.DtmfOptions{
		Digits:       request.Digits,
		ToneDuration: millis(request.ToneDurationMs),
		Gap:          millis(request.GapMs),
	}
	if err := s.sessions.SendDtmf(request.SessionID, opts); err != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(err, rtp.ErrUnsendableDigit):
			reason = ReasonBadRequest
		case errors.Is(err, rtp.ErrNoTelephoneEvent):
			reason = ReasonNotSupported
		case errors.Is(err, rtp.ErrUnknownSession):
			reason = ReasonUnknown
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		case errors.Is(err, rtp.ErrNoRemote):
			// The leg has not sent a packet yet, so symmetric RTP has taught us nowhere to send.
			// `bad_request` rather than `internal`, exactly as playback treats it: a retry fails the same way.
			reason = ReasonBadRequest
		}
		s.log.Warn("refusing a send-dtmf",
			"sessionId", request.SessionID, "digits", request.Digits,
			"reason", reason, "error", err)
		return s.refuseDtmf(request.SessionID, reason, err.Error())
	}

	queuedMs := int(opts.QueuedDuration().Milliseconds())
	payloadType := int(telephoneEventPT)
	return encode(s.log, contract.MediaSendDtmfResponse{
		Ok:                        true,
		SessionID:                 request.SessionID,
		Digits:                    request.Digits,
		QueuedMs:                  &queuedMs,
		TelephoneEventPayloadType: &payloadType,
		InstanceID:                stringPtr(s.instanceID),
	})
}

func (s *Server) refuseDtmf(sessionID, reason, message string) []byte {
	code := contract.MediaSendDtmfResponseReason(reason)
	return encode(s.log, contract.MediaSendDtmfResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// HandleStartRecording writes a session's audio to a file.
//
// The path is DERIVED, never accepted: `<MEDIAD_RECORDINGS_DIR>/<orgId>/<callId>/<ref>.wav`, which
// is exactly the object key `apps/engine` computes and exactly what `apps/api`'s archiver stats
// under `CDR_RECORDING_ROOT`, so one mount serves both planes. A caller-supplied directory would let
// a malformed request write anywhere this process can.
//
// The reply comes back once the FILE EXISTS and its header is written — not when the recording ends,
// which is `recording.finished`.
func (s *Server) HandleStartRecording(data []byte) []byte {
	var request contract.MediaStartRecordingRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseRecording("", "", ReasonBadRequest,
			fmt.Sprintf("malformed start-recording request: %v", err))
	}
	switch {
	case request.SessionID == "":
		return s.refuseRecording("", request.RecordingRef, ReasonBadRequest, "sessionId is required")
	case request.RecordingRef == "":
		return s.refuseRecording(request.SessionID, "", ReasonBadRequest,
			"recordingRef is required and must be assigned by the caller: stop-recording carries "+
				"nothing else, and it is the filename stem")
	case !isSafeRefToken(request.RecordingRef):
		// The reference becomes a FILENAME, so a separator or a dot-segment in it is a path
		// traversal. Refused by name rather than sanitised: a caller whose reference was silently
		// rewritten would look for a file under the name it asked for and not find one.
		return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonBadRequest,
			"recordingRef must be one token of [A-Za-z0-9._-] with no path separators: it is the "+
				"name of a file")
	}

	if request.Format != "" && request.Format != contract.MediaStartRecordingRequestFormatWav {
		return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonNotSupported,
			fmt.Sprintf("mediad writes WAV and nothing else; %q would download from apps/api as "+
				"audio/wav and fail to play", request.Format))
	}
	terminateOn := derefString(request.TerminateOn)
	if terminateOn == "none" {
		// ARI's own spelling of "no terminator". Normalised rather than treated as a digit set, or a
		// caller would end their message by pressing `n`.
		terminateOn = ""
	}
	if terminateOn != "" {
		if _, err := rtp.ValidateDigits(terminateOn); err != nil {
			// A terminator no keypad can produce would never fire, so the recording would run to its
			// duration limit on every message.
			return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonBadRequest,
				fmt.Sprintf("terminateOn %q is not a set of DTMF digits: %v", terminateOn, err))
		}
	}

	if s.recordingsDir == "" {
		return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonNotSupported,
			"this instance has no recordings directory: set MEDIAD_RECORDINGS_DIR to the same "+
				"mount apps/api reads as CDR_RECORDING_ROOT")
	}

	payloadType, ok := s.sessions.AudioPayloadType(request.SessionID)
	if !ok {
		return s.refuseRecording(request.SessionID, request.RecordingRef,
			s.locateRefusal([]string{request.SessionID}),
			fmt.Sprintf("no session %s on this instance", request.SessionID))
	}
	orgID, callID, _ := s.sessions.SessionTenancy(request.SessionID)
	if tenancyRefusal(orgID, callID) != "" {
		// Unreachable through the control surface, which holds both tokens to the same rule at
		// allocate. Checked again here because this is the call site that turns them into a path:
		// an empty one gives a file at `//<ref>.wav` that joins to no object key, and a dot-segment one
		// writes outside the recordings root altogether.
		return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonInternal,
			"this session carries no usable org or call, so no object key can be derived for it")
	}

	direction := rtp.RecordingDirection(request.Direction)
	switch direction {
	case "":
		direction = rtp.RecordBoth
	case rtp.RecordReceive, rtp.RecordBoth:
	default:
		// Parsed and refused rather than defaulting to `receive`, which turned a typo into HALF a recording
		// reported as a success.
		return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonBadRequest,
			fmt.Sprintf("direction %q is not a recording direction: it is %q, %q or absent",
				request.Direction, rtp.RecordReceive, rtp.RecordBoth))
	}
	objectKey := recordingObjectKey(orgID, callID, request.RecordingRef)

	startErr := s.sessions.StartRecording(request.SessionID, rtp.RecordingOptions{
		Ref:         request.RecordingRef,
		Path:        filepath.Join(s.recordingsDir, filepath.FromSlash(objectKey)),
		ObjectKey:   objectKey,
		Direction:   direction,
		Encoding:    rtp.EncodingFor(payloadType),
		MaxDuration: millis(request.MaxDurationMs),
		MaxSilence:  millis(request.MaxSilenceMs),
		TerminateOn: terminateOn,
	})
	if startErr != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(startErr, rtp.ErrUnknownSession):
			reason = ReasonUnknown
		case errors.Is(startErr, rtp.ErrClosed):
			reason = ReasonShuttingDown
		case errors.Is(startErr, rtp.ErrAlreadyRecording):
			reason = ReasonBadRequest
		}
		s.log.Warn("refusing a recording",
			"sessionId", request.SessionID, "recordingRef", request.RecordingRef,
			"reason", reason, "error", startErr)
		return s.refuseRecording(request.SessionID, request.RecordingRef, reason, startErr.Error())
	}

	if request.Beep != nil && *request.Beep {
		s.playBeep(request.SessionID, request.RecordingRef, payloadType)
	}

	return encode(s.log, contract.MediaStartRecordingResponse{
		Ok:           true,
		SessionID:    request.SessionID,
		RecordingRef: request.RecordingRef,
		ObjectKey:    stringPtr(objectKey),
		InstanceID:   stringPtr(s.instanceID),
	})
}

// playBeep sounds the record tone at a leg whose recording has just started.
//
// AFTER the recorder is running rather than before it: a beep played first would block the command
// for its length and any word spoken during it would be lost, because the file does not exist yet.
// Playing it into a live recorder costs the beep appearing at the head of a `both` recording, which
// is what actually happened on that leg.
//
// A beep that cannot be played does NOT fail the recording.
func (s *Server) playBeep(sessionID, recordingRef string, payloadType uint8) {
	tone, ok := audio.LookupTone(recordBeepTone)
	if !ok {
		s.log.Warn("no record beep tone is defined", "sessionId", sessionID)
		return
	}
	clip, err := tone.Generate(rtp.EncodingFor(payloadType))
	if err != nil {
		s.log.Warn("could not generate the record beep", "sessionId", sessionID, "error", err)
		return
	}
	// The playback reference is derived from the recording's, so `stop-playback` can interrupt it and a
	// log line ties the two together — and so it can never collide with a reference the engine assigned,
	// which is a UUID and never carries this suffix.
	err = s.sessions.StartPlayback(sessionID, rtp.PlaybackOptions{
		Ref:      recordingRef + beepRefSuffix,
		Frames:   clip.Frames,
		Encoding: clip.Encoding,
		Kind:     rtp.PlaybackTone,
	})
	if err != nil {
		s.log.Warn("the record beep did not play; the caller may talk over the greeting's tail",
			"sessionId", sessionID, "recordingRef", recordingRef, "error", err)
	}
}

// recordBeepTone names the tone `beep: true` sounds, and beepRefSuffix keeps its playback reference
// out of the engine's namespace.
const (
	recordBeepTone = "beep"
	beepRefSuffix  = ".beep"
)

func (s *Server) refuseRecording(sessionID, recordingRef, reason, message string) []byte {
	code := contract.MediaStartRecordingResponseReason(reason)
	return encode(s.log, contract.MediaStartRecordingResponse{
		Ok:           false,
		SessionID:    sessionID,
		RecordingRef: recordingRef,
		InstanceID:   stringPtr(s.instanceID),
		Reason:       &code,
		Error:        stringPtr(message),
	})
}

// HandleStopRecording finalises a recording by reference.
//
// A stop for a reference nothing is recording is `ok:true, stopped:false` — a SUCCESS and the common
// case: a recording that hit its duration limit, or whose leg hung up, has already finalised itself.
//
// The reply says the recorder was TOLD to stop. `recording.finished` says the header has been
// patched, the bytes fsynced and the file renamed into place.
func (s *Server) HandleStopRecording(data []byte) []byte {
	var request contract.MediaStopRecordingRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseStopRecording("", ReasonBadRequest,
			fmt.Sprintf("malformed stop-recording request: %v", err))
	}
	if request.RecordingRef == "" {
		return s.refuseStopRecording("", ReasonBadRequest, "recordingRef is required")
	}

	sessionID, stopped := s.sessions.StopRecording(request.RecordingRef)

	return encode(s.log, contract.MediaStopRecordingResponse{
		Ok:           true,
		RecordingRef: request.RecordingRef,
		Stopped:      stopped,
		SessionID:    stringPtr(sessionID),
		InstanceID:   stringPtr(s.instanceID),
	})
}

func (s *Server) refuseStopRecording(recordingRef, reason, message string) []byte {
	code := contract.MediaStopRecordingResponseReason(reason)
	return encode(s.log, contract.MediaStopRecordingResponse{
		Ok:           false,
		RecordingRef: recordingRef,
		InstanceID:   stringPtr(s.instanceID),
		Reason:       &code,
		Error:        stringPtr(message),
	})
}

// recordingObjectKey builds the key a recording lands under, relative to the recordings root:
// `<orgId>/<callId>/<recordingRef>.wav`, with FORWARD slashes whatever the host filesystem uses.
// This is an object key that travels on the wire and into a database column, not a path.
func recordingObjectKey(orgID, callID, ref string) string {
	return orgID + "/" + callID + "/" + ref + recordingExtension
}

// recordingExtension is the only container mediad writes. See the format refusal above.
const recordingExtension = ".wav"

// tenancyRefusal names the first of org and call that cannot be part of a path, or "" when both
// can. Both tokens become DIRECTORIES under the recordings root, and `filepath.Join` cleans `../`
// rather than rejecting it, so an unchecked token escapes the root entirely.
func tenancyRefusal(orgID, callID string) string {
	switch {
	case !isSafeRefToken(orgID):
		return "orgId must be one token of [A-Za-z0-9._-] with no path separators: it names the " +
			"top directory a recording for this session lands under"
	case !isSafeRefToken(callID):
		return "callId must be one token of [A-Za-z0-9._-] with no path separators: it names a " +
			"directory a recording for this session lands under"
	}
	return ""
}

// isSafeRefToken reports whether a reference can be part of a filename without escaping its
// directory. Deliberately narrow: a dot is allowed, because references are UUIDs today, but `..`
// and every separator are not.
func isSafeRefToken(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, r := range value {
		switch {
		case r == '-' || r == '_' || r == '.' ||
			(r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z'):
		default:
			return false
		}
	}
	return true
}

// millis turns an optional millisecond count on the wire into a duration. Absent is zero, which
// every consumer reads as "no limit" or "use the default" rather than as "immediately".
func millis(value *int) time.Duration {
	if value == nil || *value <= 0 {
		return 0
	}
	return time.Duration(*value) * time.Millisecond
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
