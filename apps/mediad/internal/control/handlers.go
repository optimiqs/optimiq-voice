package control

import (
	"encoding/json"
	"errors"
	"fmt"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// Every handler is `[]byte -> []byte`, with no *nats.Msg anywhere.
//
// That is the whole reason the unit suite needs no broker: a handler is a pure function of its
// payload, so it can be driven as a table. sipd draws the same line — `credentialFromReply` is
// tested in-package while the transport is left to the gated integration suite. None of them
// returns an error, because there is no caller that could do anything with one: a refusal IS the
// reply.

// HandleAllocateSession reserves a port pair and answers an SDP offer.
//
// The order of operations matters and is not the obvious one:
//
//  1. Parse the offer FIRST. Binding a port for an offer we are going to refuse would take capacity
//     out of the pool for the duration of a round trip, and under a codec-mismatch storm (one badly
//     configured trunk) that is a self-inflicted outage.
//  2. Allocate, which is idempotent on session id — a retry after a timeout returns the same
//     session rather than opening a second port.
//  3. Build the answer from the session's REAL port.
//  4. Record the directory entry. Last, and non-fatally: a session that works but is invisible to
//     its neighbours is strictly better than a call that fails because a KV write was slow.
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
		// Not pedantry: without it there is no org token for the lifecycle subject, so a session
		// allocated without one would end silently and the engine would never learn why.
		return s.refuseAllocate(request.SessionID, ReasonBadRequest,
			"orgId is required: it is the subject token this session's lifecycle events are published under")
	}
	if request.SDPOffer == "" {
		return s.refuseAllocate(request.SessionID, ReasonBadRequest, "sdpOffer is required")
	}

	requested, err := sdp.ParseDirection(string(request.Direction))
	if err != nil {
		return s.refuseAllocate(request.SessionID, ReasonBadRequest, err.Error())
	}
	// Hold is signalling plus music, and mediad has neither yet (design doc §2 rung 5). Answering
	// `sendrecv` to a `sendonly` request would put a held caller back into the conversation, which
	// is a privacy incident rather than a degraded feature, so it is refused by name.
	if requested == sdp.DirectionSendOnly || requested == sdp.DirectionRecvOnly {
		return s.refuseAllocate(request.SessionID, ReasonNotSupported,
			fmt.Sprintf("direction %q needs hold, which is rung 5 of the mediad capability ladder", requested))
	}

	offer, err := sdp.ParseOffer(request.SDPOffer)
	if err != nil {
		reason := ReasonBadRequest
		if errors.Is(err, sdp.ErrNoCommonCodec) {
			// A perfectly valid offer this media plane cannot serve. `not_supported` rather than
			// `bad_request`, because the engine's recovery is to route the leg to Asterisk, not to
			// fix the bytes and retry.
			reason = ReasonNotSupported
		}
		return s.refuseAllocate(request.SessionID, reason, err.Error())
	}

	answerDirection := sdp.AnswerDirection(offer.Direction, requested)

	descriptor, err := s.sessions.Allocate(rtp.AllocateOptions{
		SessionID:                 request.SessionID,
		OrgID:                     request.OrgID,
		CallID:                    request.CallID,
		LegID:                     derefString(request.LegID),
		AudioPayloadType:          offer.Codec.PayloadType(),
		TelephoneEventPayloadType: offer.TelephoneEventPayloadType,
		Inactive:                  answerDirection == sdp.DirectionInactive,
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

	sessionID, sessionVersion := sdpSessionIDs(descriptor.RTPPort)
	answer := sdp.BuildAnswer(sdp.Answer{
		SessionID:                 sessionID,
		SessionVersion:            sessionVersion,
		Address:                   s.publicAddr,
		Port:                      descriptor.RTPPort,
		Codec:                     codecOf(descriptor.AudioPayloadType),
		TelephoneEventPayloadType: descriptor.TelephoneEventPayloadType,
		Direction:                 answerDirection,
	})

	s.recordSession(request, descriptor)

	codec := string(codecOf(descriptor.AudioPayloadType))
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
// The session is already bound and answerable at this point. Failing the command would hand the
// engine an error for a session that exists and is about to receive audio, which is the worst of
// both outcomes: the call fails AND the port stays held until the reaper. Logged at WARN because
// the consequence is real but bounded — the neighbours cannot route to this session, so a bridge
// issued to another instance will answer `unknown_session` instead of `wrong_instance`.
func (s *Server) recordSession(
	request contract.MediaAllocateSessionRequest,
	descriptor rtp.Descriptor,
) {
	ctx, cancel := dirContext()
	defer cancel()

	entry := directory.Entry{
		SessionID:   descriptor.SessionID,
		InstanceID:  s.instanceID,
		OrgID:       request.OrgID,
		CallID:      request.CallID,
		LegID:       derefString(request.LegID),
		Address:     descriptor.Address.String(),
		RTPPort:     descriptor.RTPPort,
		RTCPPort:    descriptor.RTCPPort,
		Codec:       string(codecOf(descriptor.AudioPayloadType)),
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

// HandleBridgeSessions starts a bidirectional relay between two sessions.
func (s *Server) HandleBridgeSessions(data []byte) []byte {
	var request contract.MediaBridgeSessionsRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseBridge("", ReasonBadRequest, fmt.Sprintf("malformed bridge request: %v", err))
	}
	if request.BridgeID == "" {
		return s.refuseBridge("", ReasonBadRequest, "bridgeId is required")
	}
	if len(request.SessionIDs) != 2 {
		// The contract already says `.length(2)`, so this only fires for a caller that bypassed it.
		// Refused by name rather than truncated, because a three-session bridge is a CONFERENCE and
		// silently relaying the first two would put the third participant in a room they cannot
		// hear — the exact failure the ladder's rung 6 exists to do properly.
		return s.refuseBridge(request.BridgeID, ReasonNotSupported,
			fmt.Sprintf("a bridge relays exactly two sessions, got %d; N-way mixing is rung 6 of the mediad capability ladder",
				len(request.SessionIDs)))
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

// locateRefusal turns "I do not have this session" into the more useful "somebody else does".
//
// THE reason the directory exists. `unknown_session` tells the engine its picture is stale;
// `wrong_instance` tells it the session is alive on a named neighbour, and those need opposite
// recoveries. Answering the first when the second is true is how a perfectly healthy call gets torn
// down during a scale-out.
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

// noteBridge stamps the bridge id onto both directory entries.
//
// Best-effort for the same reason recordSession is: the relay is already running, and failing the
// command over a KV write would tear down audio that works. The consequence of a missed write is
// that a bridge is invisible to anything that is not this instance, which matters for a future
// drain and for an operator's "who is this call talking to" — not for the call itself.
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

// HandleUnbridgeSessions stops a relay and leaves both sessions alive.
//
// Separating legs is not hanging them up: an attended transfer takes a leg out of one bridge and
// puts it in another, and a media plane that tore the session down in between would drop the call it
// was in the middle of moving.
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

// HandleReleaseSession frees a session's ports and removes its directory entry.
//
// The directory delete is part of the CONTRACT, not an implementation detail: an entry that
// outlives its session is an instance name the engine keeps routing commands to, and every one of
// them answers `unknown_session` until an operator notices.
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

	// The delete runs whether or not there was a live session. A release for a session this
	// instance does not hold is exactly the shape of a retry that landed on the wrong node after a
	// failover, and leaving the stale entry behind would be leaving the problem the delete exists
	// to prevent.
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

// HandleStartPlayback plays a prompt towards a session's far end. Rung 1 of the ladder.
//
// The order of operations is the same shape as allocate's, and for the same reason: everything that
// can be REFUSED is done before anything that changes state.
//
//  1. Validate the payload.
//  2. Find the session, because the clip has to be decoded into the law THAT LEG answered. Decoding
//     first and discovering the leg is A-law afterwards would mean throwing the work away — or,
//     worse, sending it.
//  3. Read and decode the files. This is the slow step (a disk read and an encode) and it happens
//     BEFORE a single frame is scheduled, so a playback that reports `ok` is one whose audio is
//     already in memory. It is also why this subject's deadline is 1 s where the rest are 500 ms.
//  4. Start it, which returns as soon as the prompt is running.
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

	if !s.library.Configured() {
		return s.refusePlayback(request.SessionID, request.PlaybackRef, ReasonNotSupported,
			"this instance has no prompt library: set MEDIAD_SOUNDS_DIR to the directory prompts are mounted at")
	}

	encoding := rtp.EncodingFor(payloadType)
	clip, err := s.library.LoadAll(request.Media, encoding)
	if err != nil {
		reason := playbackRefusalFor(err)
		s.log.Warn("refusing a playback",
			"sessionId", request.SessionID, "playbackRef", request.PlaybackRef,
			"media", request.Media, "reason", reason, "error", err)
		return s.refusePlayback(request.SessionID, request.PlaybackRef, reason, err.Error())
	}

	startErr := s.sessions.StartPlayback(request.SessionID, rtp.PlaybackOptions{
		Ref:      request.PlaybackRef,
		Frames:   clip.Frames,
		Encoding: clip.Encoding,
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
			// `bad_request` rather than `internal`: the engine asked for a prompt on a leg that is
			// not carrying media, which is a sequencing bug in the call flow rather than a fault
			// here, and retrying the same request will fail the same way.
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
// The split that matters is `bad_request` — a file that is broken, so retrying these bytes fails
// the same way and somebody has to fix the prompt — against `not_supported`, which is a capability
// this rung does not have and which the engine answers by routing the leg to Asterisk. A 44.1 kHz
// prompt is the second: Asterisk plays it happily, mediad does not resample, and that is exactly
// the per-capability cutover working as designed rather than a failed call.
func playbackRefusalFor(err error) string {
	switch {
	case errors.Is(err, audio.ErrNoLibrary),
		errors.Is(err, audio.ErrUnsupportedScheme),
		errors.Is(err, audio.ErrUnsupportedRate),
		errors.Is(err, audio.ErrUnsupportedChannels),
		errors.Is(err, audio.ErrUnsupportedFormat):
		return ReasonNotSupported
	case errors.Is(err, audio.ErrNotFound),
		errors.Is(err, audio.ErrOutsideLibrary),
		errors.Is(err, audio.ErrNotRIFF),
		errors.Is(err, audio.ErrTruncated),
		errors.Is(err, audio.ErrTooLarge),
		errors.Is(err, audio.ErrEmpty):
		return ReasonBadRequest
	default:
		return ReasonInternal
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
// case rather than an edge one. Every `gather` stops its own prompt the moment collection ends,
// whatever ended it, so a caller who listens to the whole menu and then presses a digit produces
// exactly this on every single call. `MediaPort` states the rule directly: stopping an
// already-finished playback is a no-op.
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

// codecOf names a G.711 payload type. Anything else cannot reach here — a session is only ever
// created with a type ParseOffer resolved — so PCMU is the unreachable default rather than a guess.
func codecOf(payloadType uint8) sdp.Codec {
	if payloadType == rtp.PayloadTypePCMA {
		return sdp.CodecPCMA
	}
	return sdp.CodecPCMU
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
