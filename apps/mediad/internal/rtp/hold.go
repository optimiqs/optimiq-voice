package rtp

import (
	"errors"
	"fmt"
	"sync"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Hold, music on hold, and per-direction muting.
//
// Hold and mute are separate states, not one mode:
//
//   - Hold is a statement about the conversation. The held party neither hears the other side nor is
//     heard by it — the media half of a re-INVITE with `a=sendonly` — plus, usually, music.
//   - Mute is a statement about one direction of one leg and is invisible in signalling. `mute(in)`
//     is a participant nobody can hear; `mute(out)` is one who cannot hear.
//
// They are independent flags so a leg that was muted before being held is still muted after unhold.
//
// The receive gate sits between the taps and the relay, so a suppressed leg still has its keypresses
// detected — a muted participant pressing `*6` to unmute must reach the unmute code. The transmit
// gate sits in `forward`, which is the peer's audio only: a playback still reaches a held or muted
// leg, which is how hold music gets there.

// ErrNotHeld is returned by Unhold for a session that was not on hold. Reported rather than treated
// as an error at the wire, so a retried unhold does not look like a failure. See Manager.Unhold.
var ErrNotHeld = errors.New("rtp: the session is not on hold")

// MediaDirection is which half of a leg's audio path an operation applies to. The same three values
// and meanings ARI gives them, so the two drivers cannot disagree about what a mute did.
type MediaDirection string

// The three directions.
const (
	// DirectionIn is audio arriving from the leg: the party cannot be heard.
	DirectionIn MediaDirection = "in"
	// DirectionOut is audio sent to the leg: the party cannot hear.
	DirectionOut MediaDirection = "out"
	// DirectionBoth is both of the above.
	DirectionBoth MediaDirection = "both"
)

// ParseDirection validates a direction from the wire.
func ParseDirection(raw string) (MediaDirection, error) {
	switch MediaDirection(raw) {
	case DirectionIn, DirectionOut, DirectionBoth:
		return MediaDirection(raw), nil
	case "":
		// ARI's own default: a mute with no direction mutes everything.
		return DirectionBoth, nil
	default:
		return "", fmt.Errorf("rtp: unknown media direction %q (want in, out or both)", raw)
	}
}

// HoldOptions is one hold, with the music already resolved and decoded by the control surface, so
// no disk read sits between "the agent pressed hold" and "the caller stopped hearing them".
type HoldOptions struct {
	// MusicRef is the playback reference the hold loop answers to, so a `stop-playback` can name it
	// and an unhold stops exactly the loop it started.
	MusicRef string
	// MusicFrames is the loop. Empty is a legal hold with no music: the caller hears silence and the
	// conversation is still suppressed.
	MusicFrames [][]byte
	// MusicEncoding is the law MusicFrames are in.
	MusicEncoding audio.Encoding
	// MusicDescription names what was resolved, for the log line.
	MusicDescription string
}

// holdState is the per-session hold bookkeeping. A mutex rather than an atomic because hold is a
// compound change — suppression flags plus a playback — and two racing commands must not leave the
// flags and the music disagreeing. The packet path reads the flags, which are atomics.
type holdState struct {
	mu       sync.Mutex
	musicRef string
}

// Hold takes a session out of the conversation and, optionally, gives it music.
//
// Idempotent: holding a held session re-points its music and answers success, because a retry after
// a lost reply is indistinguishable from a fresh request at this layer.
func (s *Session) Hold(opts HoldOptions) error {
	if s.isClosed() {
		return ErrUnknownSession
	}

	s.hold.mu.Lock()
	defer s.hold.mu.Unlock()

	// The flags go up before the music starts: the other order would let a frame of the other
	// party's audio out between "hold pressed" and "music playing".
	s.held.Store(true)

	if previous := s.hold.musicRef; previous != "" && previous != opts.MusicRef {
		s.StopPlayback(previous)
		s.hold.musicRef = ""
	}
	if len(opts.MusicFrames) == 0 {
		return nil
	}

	if _, err := s.StartPlayback(PlaybackOptions{
		Ref:      opts.MusicRef,
		Frames:   opts.MusicFrames,
		Encoding: opts.MusicEncoding,
		Loop:     true,
		Kind:     PlaybackMusicOnHold,
	}); err != nil {
		// The hold stands even when the music could not start (a leg that has not sent a packet yet
		// has no learned far end, so no playback can begin). Privacy comes before the soundtrack.
		s.log.Warn("a hold started without music; the held party hears silence",
			"musicRef", opts.MusicRef, "music", opts.MusicDescription, "error", err)
		return nil
	}
	s.hold.musicRef = opts.MusicRef
	s.log.Info("session held", "musicRef", opts.MusicRef, "music", opts.MusicDescription)
	return nil
}

// Unhold puts a session back in the conversation and stops the music the hold started. It reports
// whether the session was held, so a retried unhold answers honestly rather than as a failure.
func (s *Session) Unhold() bool {
	s.hold.mu.Lock()
	defer s.hold.mu.Unlock()

	if ref := s.hold.musicRef; ref != "" {
		// Only the loop this hold started: a prompt the engine began while the caller was held is
		// somebody else's playback.
		s.StopPlayback(ref)
		s.hold.musicRef = ""
	}

	// The flags come down after the music stops, mirroring Hold: the audio path must never be open
	// while a loop is still writing to it.
	if !s.held.Swap(false) {
		return false
	}
	// The stream is switching clocks back to the peer's, exactly as it does at the end of a prompt.
	s.markNextForward.Store(true)
	s.log.Info("session unheld")
	return true
}

// Held reports whether the session is on hold.
func (s *Session) Held() bool { return s.held.Load() }

// HoldMusicRef is the playback reference of the loop this session's hold started, or empty.
func (s *Session) HoldMusicRef() string {
	s.hold.mu.Lock()
	defer s.hold.mu.Unlock()
	return s.hold.musicRef
}

// Mute suppresses one or both directions of a session's audio.
//
// Additive: muting `in` on a leg already muted `out` leaves both muted, so a mute never
// accidentally lifts the direction nobody asked about.
func (s *Session) Mute(direction MediaDirection) {
	if direction == DirectionIn || direction == DirectionBoth {
		s.mutedIn.Store(true)
	}
	if direction == DirectionOut || direction == DirectionBoth {
		s.mutedOut.Store(true)
	}
}

// Unmute lifts a mute on one or both directions.
func (s *Session) Unmute(direction MediaDirection) {
	if direction == DirectionIn || direction == DirectionBoth {
		s.mutedIn.Store(false)
	}
	if direction == DirectionOut || direction == DirectionBoth {
		s.mutedOut.Store(false)
		// The leg starts hearing the conversation again from a timestamp clock it has not been
		// following. Same flag, same reason, as the end of a prompt.
		s.markNextForward.Store(true)
	}
}

// Muted reports the two mute flags.
func (s *Session) Muted() (in, out bool) { return s.mutedIn.Load(), s.mutedOut.Load() }

// receiveSuppressed reports whether audio arriving on this leg should reach the conversation. Read
// on the packet path for every audio packet, which is why both halves are atomics. It does not gate
// the DTMF tap — see the file note.
func (s *Session) receiveSuppressed() bool {
	return s.held.Load() || s.mutedIn.Load()
}

// transmitSuppressed reports whether the peer's audio should reach this leg. It does not gate
// playback, which is how hold music reaches a held leg at all.
func (s *Session) transmitSuppressed() bool {
	return s.held.Load() || s.mutedOut.Load()
}

// countSuppression attributes a dropped frame to whichever state caused it. Hold wins when both are
// true, because hold is the state an operator asked about.
func (s *Session) countSuppression() {
	if s.held.Load() {
		s.count(func(st *Stats) { st.SuppressedByHold++ })
		return
	}
	s.count(func(st *Stats) { st.SuppressedByMute++ })
}

// Hold puts a live session on hold. The music arrives already decoded, so this method does no I/O.
func (m *Manager) Hold(sessionID string, opts HoldOptions) error {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return err
	}
	if err := session.Hold(opts); err != nil {
		return err
	}
	// Indexed and watched like any other playback, so `stop-playback` can find the hold loop by
	// reference. Read back from the session rather than assumed from the options: a hold whose music
	// failed to start stands with no playback at all (see Session.Hold).
	if session.HoldMusicRef() == opts.MusicRef && opts.MusicRef != "" {
		if playback := session.ActivePlayback(); playback != nil && playback.Ref() == opts.MusicRef {
			m.trackPlayback(sessionID, session, opts.MusicRef, playback)
		}
	}
	return nil
}

// Unhold returns a session to the conversation. It reports whether the session was held.
func (m *Manager) Unhold(sessionID string) (bool, error) {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return false, err
	}
	if session.Held() {
		session.rtpGraceUntil.Store(m.now().Add(m.rtpTimeout).UnixMilli())
	}
	return session.Unhold(), nil
}

// Mute suppresses one or both directions of a live session. Rung 5.
func (m *Manager) Mute(sessionID string, direction MediaDirection) error {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return err
	}
	session.Mute(direction)
	m.log.Info("session muted", "sessionId", sessionID, "direction", direction)
	return nil
}

// Unmute lifts a mute on one or both directions of a live session.
func (m *Manager) Unmute(sessionID string, direction MediaDirection) error {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return err
	}
	session.Unmute(direction)
	m.log.Info("session unmuted", "sessionId", sessionID, "direction", direction)
	return nil
}

// MuteState reports a live session's two suppression gates as values, so the control surface never
// holds a live session. It exists because a mute is additive, so the reply to `mute-session` cannot
// be derived from the request alone.
func (m *Manager) MuteState(sessionID string) (in, out, ok bool) {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return false, false, false
	}
	mutedIn, mutedOut := session.Muted()
	return mutedIn, mutedOut, true
}

// HoldState reports whether a live session is held and what its music, if any, is playing under. A
// hold stands even when its music could not start (see Session.Hold), so the empty reference is how
// the engine learns it got "held in silence".
func (m *Manager) HoldState(sessionID string) (held bool, musicRef string, ok bool) {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return false, "", false
	}
	return session.Held(), session.HoldMusicRef(), true
}

// StartMusicOnHold plays a loop at a session without taking it out of the conversation — a queue
// playing music to a caller who must still be audible when an agent answers.
func (m *Manager) StartMusicOnHold(sessionID string, opts PlaybackOptions) error {
	opts.Loop = true
	opts.Kind = PlaybackMusicOnHold
	return m.StartPlayback(sessionID, opts)
}

// liveSession is the lookup every command after allocate makes.
func (m *Manager) liveSession(sessionID string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSession, sessionID)
	}
	return session, nil
}
