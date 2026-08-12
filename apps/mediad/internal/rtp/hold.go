package rtp

import (
	"errors"
	"fmt"
	"sync"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Rung 5 of plans/mediad-design.md §2: hold, music on hold, and per-direction muting.
//
// # What rung 5 actually is, once rung 1 exists
//
// The ladder calls it "a session sourcing from a loop instead of a peer", and that is nearly the
// whole of it: `PlaybackOptions.Loop` is one field, and the frame source, the pacing, the marker
// handling and the timestamp continuity were all built for prompts. What is genuinely new here is
// the STATE — a leg that is held or muted is in a condition that outlives any one playback — and the
// two gates that state puts on the packet path.
//
// # Hold and mute are different things, and collapsing them is the mistake
//
// `MediaPort` keeps them apart deliberately (`hold` is "SIGNALLING only, and deliberately separate
// from startMusicOnHold"), and so does this file:
//
//   - HOLD is a statement about the CONVERSATION. The held party is out of it: they do not hear the
//     other side and the other side does not hear them. It is what a re-INVITE with `a=sendonly`
//     means, and the media plane's half of it is symmetric suppression plus, usually, music.
//   - MUTE is a statement about ONE DIRECTION of one leg, and it is not visible in signalling at
//     all. `mute(in)` is a participant nobody can hear — a paging group's members, a conference
//     attendee who pressed *6. `mute(out)` is a participant who cannot hear.
//
// A held leg that was also muted must stay muted when it is unheld, which is the reason these are
// two independent flags rather than one mode: an operator who muted a warehouse phone and then
// parked it does not expect parking to have unmuted it.
//
// # Where the gates are, and the one thing they deliberately do not stop
//
// The RECEIVE gate sits between the taps and the relay, so a suppressed leg still has its keypresses
// DETECTED. That is not a detail: a muted conference participant pressing `*6` to unmute themselves
// is the single most common thing a muted participant does, and a gate placed one line earlier would
// make the unmute code unreachable by exactly the people who need it. Recording follows the
// conversation rather than the wire, so a suppressed direction is excluded from the file — a
// `both` recording of a held call should contain the hold, not the music.
//
// The TRANSMIT gate sits in `forward`, which is the peer's audio only. A PLAYBACK still reaches a
// held or muted leg, and that is the point: hold music is a playback, and an engine that explicitly
// asked to play a prompt at a leg has made a decision this layer has no business overriding.

// ErrNotHeld is returned by Unhold for a session that was not on hold.
//
// Reported rather than treated as an error at the wire: the engine retries an unhold, and a retry
// that answered "failed" would make a working recovery look like a broken one. See Manager.Unhold.
var ErrNotHeld = errors.New("rtp: the session is not on hold")

// MediaDirection is which half of a leg's audio path an operation applies to.
//
// The same three values `MediaPort.mute(channelId, direction)` uses, and the same meanings ARI gives
// them, so the two drivers cannot disagree about what a mute did.
type MediaDirection string

// The three directions.
const (
	// DirectionIn is audio arriving FROM the leg: the party cannot be HEARD.
	DirectionIn MediaDirection = "in"
	// DirectionOut is audio sent TO the leg: the party cannot HEAR.
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
		// ARI's own default: a mute with no direction mutes everything. Matching it matters more
		// than picking the direction this service would have chosen.
		return DirectionBoth, nil
	default:
		return "", fmt.Errorf("rtp: unknown media direction %q (want in, out or both)", raw)
	}
}

// HoldOptions is one hold, with the music already resolved by the control surface.
//
// The frames arrive already decoded, exactly as PlaybackOptions' do and for the same reason: reading
// and encoding a file is a filesystem operation, and doing it inside the packet path would put a
// disk read between "the agent pressed hold" and "the caller stopped hearing them".
type HoldOptions struct {
	// MusicRef is the playback reference the hold loop answers to, so a `stop-playback` can name it
	// and so an unhold can stop exactly the loop IT started rather than whatever is playing.
	MusicRef string
	// MusicFrames is the loop. Empty is a legal hold with NO music, which is what an instance with
	// no music class configured does — the caller hears silence, the conversation is still
	// suppressed, and nothing pretends a file existed.
	MusicFrames [][]byte
	// MusicEncoding is the law MusicFrames are in.
	MusicEncoding audio.Encoding
	// MusicDescription names what was resolved, for the log line.
	MusicDescription string
}

// holdState is the per-session hold bookkeeping, guarded by its own mutex.
//
// A mutex rather than an atomic because hold is a COMPOUND change — two suppression flags and a
// playback that has to be started or stopped with them — and two commands racing on one leg (an
// unhold arriving while a hold is still starting its music) must not leave the flags and the music
// disagreeing. It is taken twice in a call's life, so its cost is nothing; the packet path reads the
// flags themselves, which are atomics.
type holdState struct {
	mu       sync.Mutex
	musicRef string
}

// Hold takes a session out of the conversation and, optionally, gives it music.
//
// Idempotent: holding a held session re-points its music and answers success, for the same reason
// allocate and bridge are idempotent — a retry after a lost reply is indistinguishable from a fresh
// request at this layer, and refusing one would turn a recovered timeout into a stuck hold.
func (s *Session) Hold(opts HoldOptions) error {
	if s.isClosed() {
		return ErrUnknownSession
	}

	s.hold.mu.Lock()
	defer s.hold.mu.Unlock()

	// The flags go up BEFORE the music starts. The other order would let one frame of the other
	// party's audio out between "hold pressed" and "music playing", which is a fragment of a
	// conversation the held party was taken out of — small, and exactly the kind of thing a
	// compliance review asks about.
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
		// The hold STANDS even when the music could not start, and that is the important half of
		// this branch. A leg that has not sent a packet yet has no learned far end, so a playback
		// cannot begin — but the caller pressing hold still expects the other party to stop hearing
		// them. Failing the hold over its soundtrack would be putting music ahead of privacy.
		s.log.Warn("a hold started without music; the held party hears silence",
			"musicRef", opts.MusicRef, "music", opts.MusicDescription, "error", err)
		return nil
	}
	s.hold.musicRef = opts.MusicRef
	s.log.Info("session held", "musicRef", opts.MusicRef, "music", opts.MusicDescription)
	return nil
}

// Unhold puts a session back in the conversation and stops the music the hold started.
//
// It reports whether the session WAS held, so a retried unhold can answer honestly rather than as a
// failure.
func (s *Session) Unhold() bool {
	s.hold.mu.Lock()
	defer s.hold.mu.Unlock()

	if ref := s.hold.musicRef; ref != "" {
		// Only the loop this hold started. A prompt the engine began while the caller was held is
		// somebody else's playback, and stopping whatever happens to be playing would silence it.
		s.StopPlayback(ref)
		s.hold.musicRef = ""
	}

	// The flags come down AFTER the music stops, which is the mirror of the ordering in Hold: the
	// audio path must never be open while a loop is still writing to it, or the resumed conversation
	// arrives with hold music mixed into its first frames.
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
// Additive: muting `in` on a leg already muted `out` leaves both muted. The alternative — a single
// direction field that replaces whatever was there — would make `mute(in)` on a leg that could
// already not hear into an unmute of the direction nobody asked about.
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
		// The leg is about to start hearing the conversation again from a timestamp clock it has not
		// been following. Same flag, same reason, as the end of a prompt.
		s.markNextForward.Store(true)
	}
}

// Muted reports the two mute flags.
func (s *Session) Muted() (in, out bool) { return s.mutedIn.Load(), s.mutedOut.Load() }

// receiveSuppressed reports whether audio ARRIVING on this leg should reach the conversation.
//
// Read on the packet path for every audio packet, which is why both halves are atomics. It does NOT
// gate the DTMF tap: see the package note on why a muted participant must still be able to press a
// key.
func (s *Session) receiveSuppressed() bool {
	return s.held.Load() || s.mutedIn.Load()
}

// transmitSuppressed reports whether the PEER's audio should reach this leg.
//
// It does not gate playback, which is how hold music reaches a held leg at all.
func (s *Session) transmitSuppressed() bool {
	return s.held.Load() || s.mutedOut.Load()
}

// countSuppression attributes a dropped frame to whichever state caused it.
//
// Hold wins when both are true, because hold is the state an operator asked about: "why can the
// caller not hear the agent" is answered by "the call is on hold" long before it is answered by "and
// also somebody muted it in 2023".
func (s *Session) countSuppression() {
	if s.held.Load() {
		s.count(func(st *Stats) { st.SuppressedByHold++ })
		return
	}
	s.count(func(st *Stats) { st.SuppressedByMute++ })
}

// Hold puts a live session on hold. Rung 5.
//
// The music is resolved by the control surface and handed in already decoded, so this method does no
// I/O and cannot block on a filesystem while a caller is waiting to be put on hold.
func (m *Manager) Hold(sessionID string, opts HoldOptions) error {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return err
	}
	if err := session.Hold(opts); err != nil {
		return err
	}
	if opts.MusicRef != "" {
		// Indexed like any other playback, so `stop-playback` can find the hold loop by reference —
		// which is what makes `stopMusicOnHold` on a held leg reachable at all.
		m.mu.Lock()
		m.playbacks[opts.MusicRef] = sessionID
		m.mu.Unlock()
	}
	return nil
}

// Unhold returns a session to the conversation. It reports whether the session was held.
func (m *Manager) Unhold(sessionID string) (bool, error) {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return false, err
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

// StartMusicOnHold plays a loop at a session WITHOUT taking it out of the conversation.
//
// Separate from Hold, and the separation is `MediaPort`'s rather than this file's invention:
// `startMusicOnHold` is documented there as "separate from hold, which is signalling". A queue
// playing music to a caller who is very much still in a conversation with the queue is the case that
// needs it, and a hold would make that caller inaudible to an agent who then answered to silence.
func (m *Manager) StartMusicOnHold(sessionID string, opts PlaybackOptions) error {
	opts.Loop = true
	opts.Kind = PlaybackMusicOnHold
	return m.StartPlayback(sessionID, opts)
}

// liveSession is the lookup every command after allocate makes, with the one refusal the engine
// branches on.
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
