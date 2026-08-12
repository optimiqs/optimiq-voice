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
// # Rung 5 built the capability; this is the rung 5 CONTRACT arriving
//
// `internal/rtp/hold.go` has held both suppression gates, the hold's compound state and the music
// loop since rung 5. What it never had was a subject: the only thing that could reach any of it was
// a repeat `allocate-session` carrying a re-negotiated `direction`, which is the SIGNALLING half of
// hold arriving from sipd. So the engine's `MediadMediaPort` refused `hold`, `unhold`, `mute`,
// `unmute`, `startMusicOnHold` and `stopMusicOnHold` by name and routed those calls to Asterisk —
// five capabilities that existed, were tested, and were unreachable.
//
// # Why two subjects and not four, when playback and recording each get a pair
//
// Because the shapes are different, not because the count is. `stop-playback` carries a
// `playbackRef` and NOTHING else — there is no session id on it, because the engine stops a prompt
// from a barge-in handler that holds a reference and nothing more — so the start and the stop are
// two genuinely different payloads. A mute and an unmute are the same three fields with one bit
// flipped, and an unhold is a hold with the music left out. Splitting those would be two subjects
// per pair whose schemas a reader has to diff to see that they agree.
//
// # The order of operations, which is the family's
//
// Everything REFUSABLE is decided before anything changes. For `mute-session` that is trivial —
// there is no I/O on the path at all, which is why it keeps the family's 500 ms — and for
// `hold-session` it is the reason the deadline is a second: a hold that names music READS AND
// DECODES A FILE first, exactly as `start-playback` does, so an `ok` means the loop is in memory
// rather than that the request was accepted for consideration.
//
// The one place that order is deliberately broken is a hold whose music fails AFTER the flags are
// up. `Session.Hold` lets the hold stand and logs, and this handler answers `ok` with no `musicRef`:
// the party who pressed hold expects the other side to stop hearing them, and failing that over its
// soundtrack would be putting music ahead of privacy.

// HandleMuteSession gates one or both directions of one leg. Rung 5.
//
// A mute is ADDITIVE — muting `in` on a leg already muted `out` leaves both set — so the reply reads
// the state back rather than deriving it from the request. See rtp.Manager.MuteState for why that is
// an interface method and not an inference.
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
			// The directory turns "I do not have this session" into "somebody else does", for the
			// reason every other handler on this surface does it: a caller told "no such session"
			// about a session that is live on a neighbour retries forever against the wrong instance.
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

// HandleHoldSession takes a leg out of the conversation, or puts it back. Rung 5.
//
// An unhold of a leg that was not held is `ok:true, held:false` — a SUCCESS, and the same shape
// `unbridge`, `stop-playback` and `untap` use for the same reason: the engine retries a teardown
// after a lost reply, and a retry that answered "failed" would make a working recovery look broken.
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
	// "held with music" from "held in silence" — which matters, because it is what it would name in
	// a `stop-playback`.
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
// It is the whole reason this subject's deadline is a second rather than the family's 500 ms, and
// the steps are `start-playback`'s in the same order and for the same reasons:
//
//  1. Find the leg, because the clip has to be decoded into the law THAT LEG answered. A µ-law loop
//     on an A-law leg is a rasp rather than wrong-sounding music.
//  2. Read and decode the file, BEFORE anything is scheduled.
//
// A hold with no music skips both and is a legal, silent hold — which is what an instance with no
// music mounted does, and what `tone:silence` asks for explicitly.
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
