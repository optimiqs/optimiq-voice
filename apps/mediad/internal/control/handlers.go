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
	// RUNG 5 CHANGED THIS. `sendonly` and `recvonly` were refused by name — "hold is signalling plus
	// music, and mediad has neither yet" — and refusing was right, because answering `sendrecv` to a
	// `sendonly` offer would put a held caller back into a conversation they had been taken out of,
	// which is a privacy incident rather than a degraded feature.
	//
	// mediad now has both halves, and this is where hold ARRIVES: a re-INVITE is seen by sipd,
	// decided by the engine, and delivered here as a repeat allocate carrying the new direction. See
	// directionToMutes for how RFC 3264's four directions become the media plane's two gates.

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

	// A REPEAT allocate for a live session is either a retry or a re-negotiation, and this is the one
	// line that tells them apart: a retry carries the same direction, so applying it changes nothing,
	// and a re-INVITE carries a different one, so applying it is the whole point. `Allocate` itself
	// stays idempotent — it does not open a second port and it does not change the MODE — which is
	// what keeps "a retry must not mutate a live call" true while letting a renegotiation through.
	if err := s.sessions.ApplyDirection(request.SessionID, muteIn, muteOut); err != nil {
		s.log.Warn("could not apply a renegotiated direction",
			"sessionId", request.SessionID, "direction", answerDirection, "error", err)
	}

	sessionID, sessionVersion := sdpSessionIDs(descriptor.RTPPort)
	negotiated := sdp.CodecForFormat(descriptor.Format)
	answer := sdp.BuildAnswer(sdp.Answer{
		SessionID:                 sessionID,
		SessionVersion:            sessionVersion,
		Address:                   s.publicAddr,
		Port:                      descriptor.RTPPort,
		Codec:                     negotiated,
		AudioPayloadType:          descriptor.AudioPayloadType,
		TelephoneEventPayloadType: descriptor.TelephoneEventPayloadType,
		OpusFmtp:                  offer.OpusFmtp,
		Direction:                 answerDirection,
	})

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

	// RUNG 5 CHANGED THIS CHECK. It used to gate every playback on a configured prompt library. Two
	// of the three schemes still need one — `sound:` and `moh:` are files — but `tone:` is
	// GENERATED, and making ringback depend on a mount would mean an instance that can bridge a call
	// cannot tell the caller the far end is ringing.
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
		errors.Is(err, audio.ErrUnsupportedFormat),
		// A tone name this build does not define. `not_supported` and not `bad_request`, because the
		// engine's recovery is the same one every capability gap gets: Asterisk ships a full tone
		// ZONE for every country and mediad defines eight signals, so a leg that needs one of the
		// others is a leg Asterisk can serve.
		errors.Is(err, audio.ErrUnknownTone):
		return ReasonNotSupported
	case errors.Is(err, audio.ErrNotFound),
		errors.Is(err, audio.ErrOutsideLibrary),
		errors.Is(err, audio.ErrNotRIFF),
		errors.Is(err, audio.ErrTruncated),
		errors.Is(err, audio.ErrTooLarge),
		errors.Is(err, audio.ErrEmpty),
		// Rung 5's two new ways to ask for something that cannot mean anything: a cadence that does
		// not parse, and a looping reference concatenated with a prompt nobody would ever reach.
		// Both are `bad_request` rather than `not_supported`, and the distinction is the usual one —
		// the capability EXISTS and the request is malformed, so routing the leg to Asterisk would
		// produce the same refusal one hop later.
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
// The mapping is a statement about what an ANSWER means, and each half is one sentence:
//
//	sendrecv   both ways flow. The ordinary call.
//	sendonly   we send and do not receive, so what ARRIVES on this leg goes nowhere. mute(in).
//	recvonly   we receive and do not send, so the peer's audio is not written out. mute(out).
//	inactive   neither. Both gates up, and the session is additionally put in ModeInactive.
//
// It is the media plane's whole share of hold. Which PARTY hears music is the engine's decision and
// arrives as a separate `start-playback` of a `moh:` reference — deliberately, because "the held
// caller hears the queue's music" and "the holding agent hears nothing" are two different commands
// about two different legs, and a media plane that inferred the second from the first would be
// making a routing decision on the far side of the seam.
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

// HandleSendDtmf generates RFC 4733 digits towards a session's far end. Rung 3.
//
// The order of operations is the family's: everything REFUSABLE is decided before anything is put
// on the wire, so an `ok` reply means the digits are going out rather than that they were accepted
// for consideration. The two refusals that matter are worth naming separately:
//
//   - A leg that negotiated NO telephone-event payload type is `not_supported`, never an inband
//     tone. The far end said it does not expect RFC 4733, and sending under a type it never agreed
//     to produces digits it drops — an IVR that "randomly" ignores keypresses. Synthesising audio
//     instead means a tone generator, which is the same deferral `tone://` carries at
//     `start-playback`, and the engine's answer to either is to route the leg to Asterisk.
//   - A character with no event code is `bad_request` naming the character, decided over the WHOLE
//     string first. Failing halfway would leave a far-end IVR holding a prefix of what was asked
//     for, under a reply that said the request succeeded.
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
			// `bad_request` rather than `internal`, exactly as playback treats it: the engine asked
			// for digits on a leg that is not carrying media, and a retry fails the same way.
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

// HandleStartRecording writes a session's audio to a file. Rung 4.
//
// The path is DERIVED, never accepted: `<MEDIAD_RECORDINGS_DIR>/<orgId>/<callId>/<ref>.wav`, where
// the org and the call came in on the allocate and live on the session. That is exactly the object
// key `apps/engine` computes for the same recording and exactly what `apps/api`'s archiver stats
// under `CDR_RECORDING_ROOT`, so one mount serves both planes and the archive pipeline reads what
// mediad wrote with no change at all. A caller-supplied directory would let a malformed request
// write anywhere this process can, and the engine has nothing to say about a layout mediad can work
// out for itself.
//
// The reply comes back once the FILE EXISTS and its header is written — not when the recording
// ends, which is `recording.finished`, and not before the file is open, which would let the opening
// moments be dropped on the floor and reported as success.
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
	// BOTH of rung 4's remaining refusals are gone, and they had to go together. design doc §10
	// questions 10 and 11 recorded exactly why: `terminateOn` needed DTMF detection, `beep` needed a
	// tone generator, voicemail — the only caller — sends both, and "implementing one without the
	// other moves no call off Asterisk". Detection landed in the wave before this one and the tone
	// generator landed in this one, so the pair closes here.
	terminateOn := derefString(request.TerminateOn)
	if terminateOn == "none" {
		// ARI's own spelling of "no terminator". Normalised rather than treated as a digit set, or a
		// caller would end their message by pressing `n`.
		terminateOn = ""
	}
	if terminateOn != "" {
		if _, err := rtp.ValidateDigits(terminateOn); err != nil {
			// A terminator no keypad can produce would never fire, so the recording would run to its
			// duration limit on every message — which is the silent failure the refusal replaced.
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
	if orgID == "" || callID == "" {
		// Unreachable through the control surface, which refuses an allocate without either. Checked
		// anyway, because the failure it prevents is a file at `//<ref>.wav` — a path that exists,
		// is written to, and joins to no object key any consumer will ever look for.
		return s.refuseRecording(request.SessionID, request.RecordingRef, ReasonInternal,
			"this session carries no org or call, so no object key can be derived for it")
	}

	direction := rtp.RecordingDirection(request.Direction)
	if request.Direction == "" {
		direction = rtp.RecordBoth
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
// AFTER the recorder is running rather than before it, and that is the ordering decision. A beep
// played first would need the command to block for its length — a quarter of a second of a caller
// waiting inside a 1 s deadline — and any word spoken during it would be lost, because the file does
// not exist yet. Playing it into a live recorder costs the beep appearing at the head of a `both`
// recording, which is what actually happened on that leg and is what a person listening back expects
// to hear.
//
// A beep that cannot be played does NOT fail the recording. The refusal it replaced existed because
// a voicemail whose beep never sounds clips the first words of every message; a recording that is
// already running and merely started quietly is a smaller problem than one that did not start.
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
	// The playback reference is derived from the recording's, so `stop-playback` could interrupt it
	// and a log line ties the two together — and so it can never collide with a reference the engine
	// assigned, which is a UUID and never carries this suffix.
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
// A stop for a reference nothing is recording is `ok:true, stopped:false` — a SUCCESS, and the
// common case rather than an edge one: a recording that hit its duration limit, or whose leg hung
// up, has already finalised itself by the time the engine's teardown gets around to stopping it.
//
// The reply says the recorder was TOLD to stop. `recording.finished` says the header has been
// patched, the bytes fsynced and the file renamed into place, and that is the event a consumer must
// wait for before reading the file.
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

// recordingObjectKey builds the key a recording lands under, relative to the recordings root.
//
// `<orgId>/<callId>/<recordingRef>.wav`, with FORWARD slashes whatever the host filesystem uses:
// this is an object key that travels on the wire and into a database column, not a path. The
// absolute path is derived from it once, at the one place that knows the root.
func recordingObjectKey(orgID, callID, ref string) string {
	return orgID + "/" + callID + "/" + ref + recordingExtension
}

// recordingExtension is the only container mediad writes. See the format refusal above.
const recordingExtension = ".wav"

// isSafeRefToken reports whether a reference can be part of a filename without escaping its
// directory. Deliberately narrower than the subject-token rule: a dot is allowed, because
// references are UUIDs today and could reasonably carry one, but `..` and every separator are not.
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
// every consumer of it reads as "no limit" or "use the default" rather than as "immediately".
func millis(value *int) time.Duration {
	if value == nil || *value <= 0 {
		return 0
	}
	return time.Duration(*value) * time.Millisecond
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
