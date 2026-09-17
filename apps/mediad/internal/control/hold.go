package control

import (
	"encoding/json"
	"errors"
	"fmt"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// `rpc.media.v1.mute-session` and `rpc.media.v1.hold-session`, served.
//
// Mute and unmute are the same three fields with one bit flipped, and an unhold is a hold with the
// music left out, so each pair is one subject rather than two whose schemas a reader has to diff.
//
// Everything REFUSABLE is decided before anything changes. `mute-session` does no I/O and keeps the
// family's 500 ms deadline; `hold-session` reads and decodes music first, exactly as
// `start-playback` does, which is why its deadline is a second.
//
// The one deliberate exception: a hold whose music fails AFTER the flags are up lets the hold stand
// and answers `ok` with no `musicRef`. The party who pressed hold expects the other side to stop
// hearing them, and failing that over its soundtrack would put music ahead of privacy.

// HandleMuteSession gates one or both directions of one leg.
//
// A mute is ADDITIVE — muting `in` on a leg already muted `out` leaves both set — so the reply reads
// the state back rather than deriving it from the request. See rtp.Manager.MuteState.
func (s *Server) HandleMuteSession(data []byte) []byte {
	var request contract.MediaMuteSessionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseMute("", ReasonBadRequest, fmt.Sprintf("malformed mute request: %v", err))
	}
	if request.SessionID == "" {
		return s.refuseMute("", ReasonBadRequest, "sessionId is required")
	}

	direction, err := rtp.ParseDirection(string(request.Direction))
	if err != nil {
		// Validated before the session is looked up, exactly as a tap's side letters are: a direction
		// of "left" is a caller bug and should read the same whether or not the call it names is up.
		return s.refuseMute(request.SessionID, ReasonBadRequest, err.Error())
	}

	apply := s.sessions.Mute
	if request.Unmute {
		apply = s.sessions.Unmute
	}
	if err := apply(request.SessionID, direction); err != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(err, rtp.ErrUnknownSession):
			// The directory turns "I do not have this session" into "somebody else does": a caller told
			// "no such session" about a session live on a neighbour retries forever against the wrong instance.
			reason = s.locateRefusal([]string{request.SessionID})
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		s.log.Warn("refusing a mute",
			"sessionId", request.SessionID, "direction", string(direction),
			"unmute", request.Unmute, "reason", reason, "error", err)
		return s.refuseMute(request.SessionID, reason, err.Error())
	}

	mutedIn, mutedOut, _ := s.sessions.MuteState(request.SessionID)
	return encode(s.log, contract.MediaMuteSessionResponse{
		Ok:         true,
		SessionID:  request.SessionID,
		MutedIn:    mutedIn,
		MutedOut:   mutedOut,
		InstanceID: stringPtr(s.instanceID),
	})
}

func (s *Server) refuseMute(sessionID, reason, message string) []byte {
	code := contract.MediaMuteSessionResponseReason(reason)
	return encode(s.log, contract.MediaMuteSessionResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}

// HandleHoldSession takes a leg out of the conversation, or puts it back.
//
// An unhold of a leg that was not held is `ok:true, held:false` — a SUCCESS, the same shape every
// teardown on this surface uses, because the engine retries a teardown after a lost reply.
func (s *Server) HandleHoldSession(data []byte) []byte {
	var request contract.MediaHoldSessionRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return s.refuseHold("", ReasonBadRequest, fmt.Sprintf("malformed hold request: %v", err))
	}
	if request.SessionID == "" {
		return s.refuseHold("", ReasonBadRequest, "sessionId is required")
	}

	if request.Unhold {
		if _, err := s.sessions.Unhold(request.SessionID); err != nil {
			reason := holdRefusalFor(err)
			if reason == ReasonUnknown {
				reason = s.locateRefusal([]string{request.SessionID})
			}
			s.log.Warn("refusing an unhold",
				"sessionId", request.SessionID, "reason", reason, "error", err)
			return s.refuseHold(request.SessionID, reason, err.Error())
		}
		return encode(s.log, contract.MediaHoldSessionResponse{
			Ok:         true,
			SessionID:  request.SessionID,
			Held:       false,
			InstanceID: stringPtr(s.instanceID),
		})
	}

	opts, refusal := s.holdOptions(request)
	if refusal != nil {
		return refusal
	}

	if err := s.sessions.Hold(request.SessionID, opts); err != nil {
		reason := holdRefusalFor(err)
		if reason == ReasonUnknown {
			reason = s.locateRefusal([]string{request.SessionID})
		}
		s.log.Warn("refusing a hold",
			"sessionId", request.SessionID, "music", derefString(request.Music),
			"reason", reason, "error", err)
		return s.refuseHold(request.SessionID, reason, err.Error())
	}

	// Read back rather than echoed. A hold whose music could not start is a hold that STANDS with no
	// loop behind it (see Session.Hold), and the reference is the only place the engine can tell
	// "held with music" from "held in silence" — which is what it would name in a `stop-playback`.
	held, musicRef, _ := s.sessions.HoldState(request.SessionID)
	return encode(s.log, contract.MediaHoldSessionResponse{
		Ok:         true,
		SessionID:  request.SessionID,
		Held:       held,
		MusicRef:   stringPtr(musicRef),
		InstanceID: stringPtr(s.instanceID),
	})
}

// holdOptions resolves the hold's music into decoded frames, or refuses.
//
// The leg is found first because the clip has to be decoded into the law THAT LEG answered, and the
// file is read and decoded before anything is scheduled — which is why this subject's deadline is a
// second rather than the family's 500 ms.
//
// A hold with no music skips both and is a legal, silent hold.
func (s *Server) holdOptions(
	request contract.MediaHoldSessionRequest,
) (rtp.HoldOptions, []byte) {
	music := derefString(request.Music)
	musicRef := derefString(request.MusicRef)
	if musicRef == "" && music != "" {
		// Minted from the session id rather than required on the wire: an engine that only wants the
		// suppression should not have to invent an id for a playback it will never stop by hand, and
		// a hold loop still has to be indexable so `stop-playback` can reach it.
		musicRef = "hold:" + request.SessionID
	}
	if music == "" {
		return rtp.HoldOptions{MusicRef: musicRef}, nil
	}

	payloadType, ok := s.sessions.AudioPayloadType(request.SessionID)
	if !ok {
		return rtp.HoldOptions{}, s.refuseHold(request.SessionID,
			s.locateRefusal([]string{request.SessionID}),
			fmt.Sprintf("no session %s on this instance", request.SessionID))
	}

	source, err := s.library.LoadSource([]string{music}, rtp.EncodingFor(payloadType))
	if err != nil {
		reason := playbackRefusalFor(err)
		s.log.Warn("refusing a hold",
			"sessionId", request.SessionID, "music", music, "reason", reason, "error", err)
		return rtp.HoldOptions{}, s.refuseHold(request.SessionID, reason, err.Error())
	}

	return rtp.HoldOptions{
		MusicRef:         musicRef,
		MusicFrames:      source.Clip.Frames,
		MusicEncoding:    source.Clip.Encoding,
		MusicDescription: source.Description,
	}, nil
}

// holdRefusalFor classifies a hold failure onto the wire's refusal vocabulary.
func holdRefusalFor(err error) string {
	switch {
	case errors.Is(err, rtp.ErrUnknownSession):
		return ReasonUnknown
	case errors.Is(err, rtp.ErrClosed):
		return ReasonShuttingDown
	default:
		return ReasonInternal
	}
}

func (s *Server) refuseHold(sessionID, reason, message string) []byte {
	code := contract.MediaHoldSessionResponseReason(reason)
	return encode(s.log, contract.MediaHoldSessionResponse{
		Ok:         false,
		SessionID:  sessionID,
		InstanceID: stringPtr(s.instanceID),
		Reason:     &code,
		Error:      stringPtr(message),
	})
}
