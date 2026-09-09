package rtp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"sync"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// ErrClosed is returned by Allocate after the manager has begun draining. Distinct from
// ErrPortsExhausted, which means "retry"; this one means "do not retry here".
var ErrClosed = errors.New("rtp: the session manager is shutting down")

// ErrUnknownSession is returned by the commands that address an existing session. The control
// surface turns it into `unknown_session`: the caller's picture of the call is wrong.
var ErrUnknownSession = errors.New("rtp: no such session on this instance")

// ErrCodecMismatch is an alias kept for callers that predate transcoding.
//
// Deprecated: a codec mismatch is now translated. Branch on ErrCannotTranscode.
var ErrCodecMismatch = ErrCannotTranscode

// Descriptor is what a caller needs to tell a far end where to send its media: the reply body of an
// allocate, so the control package never reaches into a Session.
type Descriptor struct {
	SessionID                 string
	Address                   netip.Addr
	RTPPort                   int
	RTCPPort                  int
	SSRC                      uint32
	Mode                      Mode
	AudioPayloadType          uint8
	Format                    audio.Format
	TelephoneEventPayloadType uint8
}

// AllocateOptions is everything the control surface has decided about a new session.
type AllocateOptions struct {
	Transport PacketTransport
	// SessionID is caller-assigned and required. See the note on Allocate.
	SessionID string
	// OrgID, CallID and LegID travel to the session directory and the lifecycle events; mediad
	// routes on none of them.
	OrgID  string
	CallID string
	LegID  string
	// AudioPayloadType is the audio payload type the SDP answer settled on.
	AudioPayloadType uint8
	// Format is the codec that payload type carries; a number alone does not name one (Opus is
	// dynamic).
	Format audio.Format
	// TelephoneEventPayloadType is the RFC 4733 type the answer settled on, or 0 for none.
	TelephoneEventPayloadType uint8
	// Inactive puts the session in ModeInactive — a leg that is ringing but not yet talking.
	Inactive bool
	// MuteIn and MuteOut are the media-plane half of a non-sendrecv answer direction. They arrive on
	// the allocate so the gate is up before the first packet after a renegotiation.
	MuteIn  bool
	MuteOut bool
}

// EndReason is why a session stopped existing. The values match the wire contract's
// `MediaSessionEndReason` (packages/events/src/schemas/media-events.ts) exactly.
type EndReason string

// Every way a media session can end.
const (
	// EndReasonReleased is the engine asking. The normal end of a leg.
	EndReasonReleased EndReason = "released"
	// EndReasonRTPTimeout is audio stopping while the session was still allocated.
	EndReasonRTPTimeout EndReason = "rtp-timeout"
	// EndReasonIdleReaped is the port-leak backstop collecting a session nobody released.
	EndReasonIdleReaped EndReason = "idle-reaped"
	// EndReasonDrained is the instance shutting down under a live call.
	EndReasonDrained EndReason = "drained"
)

// Lifecycle is how the packet path tells the outside world a session changed state. The Manager
// calls it synchronously but from a goroutine it owns, so the packet path never blocks on a publish.
// A Manager with no Lifecycle simply announces nothing.
type Lifecycle interface {
	// SessionEnded is called exactly once per session, after its sockets are closed.
	SessionEnded(session SessionSummary, reason EndReason)
	// RTPTimedOut is called before the SessionEnded that follows it, and only for that reason.
	RTPTimedOut(session SessionSummary, silentFor time.Duration)
	// PlaybackFinished is called exactly once per started playback, however it ended — including
	// when the SESSION ended under it, which is why the summary is passed rather than looked up.
	// Its ordering against SessionEnded is NOT guaranteed.
	PlaybackFinished(session SessionSummary, playback PlaybackSummary)
	// DtmfReceived is called once per detected KEYPRESS, never once per RFC 4733 packet, and
	// whether or not the session is bridged. Called from the session's read goroutine, so an
	// implementation MUST NOT block on anything slower than a channel send.
	DtmfReceived(session SessionSummary, digit DtmfDigit)
	// RecordingFinished is called exactly once per started recording, after the file is finalised
	// and renamed. Unlike PlaybackFinished its ordering IS guaranteed: it runs BEFORE the
	// SessionEnded that follows, since consumers tear the leg down on that event.
	RecordingFinished(session SessionSummary, recording RecordingSummary)
}

// SessionSummary is a session's facts, flattened, so a Lifecycle implementation never holds a
// pointer to a Session whose sockets are already closed.
type SessionSummary struct {
	SessionID  string
	OrgID      string
	CallID     string
	LegID      string
	RTPPort    int
	Stats      Stats
	Duration   time.Duration
	RemoteAddr string
	// Quality is the RTCP view of the leg: jitter measured here, and loss, jitter and round-trip
	// time as the far end reported them. It is on the summary only; the wire contract has no field
	// for it yet.
	Quality QualityStats
}

// Manager owns every live session: it allocates ports, runs each session's read loop, reaps idle
// ones, and drains them all on shutdown. It is the only thing that knows how many calls are up.
type Manager struct {
	allocator *Allocator
	public    netip.Addr
	log       *slog.Logger
	idleAfter time.Duration
	// now is swapped in tests so idle reaping is asserted without sleeping.
	now func() time.Time

	// rtpTimeout is the "audio stopped" window. Distinct from idleAfter — see ReapIdle.
	rtpTimeout time.Duration
	// echoDiagnostic makes a freshly allocated session echo instead of relay. Off in production.
	echoDiagnostic bool
	lifecycle      Lifecycle
	// ticker is handed to every session it creates. See ManagerOptions.Ticker.
	ticker func(time.Duration) (<-chan time.Time, func())
	// dtmfMaxDigit bounds one detected digit on every session it creates.
	dtmfMaxDigit time.Duration

	mu       sync.Mutex
	sessions map[string]*Session
	// bridges maps a caller-assigned bridge id to the two sessions relaying under it. The peer
	// pointers are the packet path's view of the same fact; this one is addressable by id.
	bridges map[string][2]string
	// playbacks maps a playback reference to the session playing it, because `stop-playback` carries
	// a reference and nothing else.
	playbacks map[string]string
	// recordings maps a recording reference to the session being recorded, for the same reason.
	recordings map[string]string
	// conferences maps a room id to the mix running under it. Deliberately separate from `bridges`:
	// collapsing the two would put a jitter buffer and a codec round trip on every two-party call.
	conferences map[string]*Conference
	// taps maps a tap id to the room it joined, because `untap-session` carries a tap id only.
	taps   map[string]tapRecord
	closed bool

	// running tracks each session's read goroutine so Drain can wait for the packet path to stop
	// before the process exits.
	running sync.WaitGroup
}

// ManagerOptions configures a Manager.
type ManagerOptions struct {
	// Allocator is required.
	Allocator *Allocator
	// PublicAddr is the address handed back in a Descriptor. Required.
	PublicAddr netip.Addr
	// IdleAfter reaps sessions with no traffic for this long. Zero disables reaping.
	IdleAfter time.Duration
	// RTPTimeout is the window after which a session that HAS received audio and then stopped is
	// declared timed out. Zero falls back to IdleAfter.
	RTPTimeout time.Duration
	// EchoDiagnostic makes new sessions echo rather than relay. Never on in production.
	EchoDiagnostic bool
	// Lifecycle receives session-ended and rtp-timeout notifications. Optional.
	Lifecycle Lifecycle
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// Now is the clock, for tests.
	Now func() time.Time
	// Ticker builds every session's playback pacing clock. Nil is a real 20 ms ticker.
	Ticker func(time.Duration) (<-chan time.Time, func())
	// DtmfMaxDigitDuration bounds one DETECTED digit on every session this manager creates. Zero
	// means DefaultDtmfMaxDigitDuration.
	DtmfMaxDigitDuration time.Duration
}

// NewManager builds a Manager.
func NewManager(opts ManagerOptions) (*Manager, error) {
	switch {
	case opts.Allocator == nil:
		return nil, errors.New("rtp: a port allocator is required")
	case !opts.PublicAddr.IsValid():
		return nil, errors.New("rtp: a public address is required")
	}

	manager := &Manager{
		allocator:      opts.Allocator,
		public:         opts.PublicAddr.Unmap(),
		log:            opts.Logger,
		idleAfter:      opts.IdleAfter,
		rtpTimeout:     opts.RTPTimeout,
		echoDiagnostic: opts.EchoDiagnostic,
		lifecycle:      opts.Lifecycle,
		now:            opts.Now,
		ticker:         opts.Ticker,
		dtmfMaxDigit:   opts.DtmfMaxDigitDuration,
		sessions:       make(map[string]*Session),
		bridges:        make(map[string][2]string),
		playbacks:      make(map[string]string),
		recordings:     make(map[string]string),
		conferences:    make(map[string]*Conference),
		taps:           make(map[string]tapRecord),
	}
	if manager.rtpTimeout <= 0 {
		manager.rtpTimeout = opts.IdleAfter
	}
	if manager.log == nil {
		manager.log = slog.Default()
	}
	if manager.now == nil {
		manager.now = time.Now
	}
	return manager, nil
}

// Allocate creates a session, starts its read loop and returns its descriptor.
//
// IDEMPOTENT by session id: an allocate for an id that already has a session returns that session
// and opens no second port, because a retry over request-reply is indistinguishable from a fresh
// request here. A repeat allocate does NOT change an existing session's mode — a retry must not
// mutate a live call.
func (m *Manager) Allocate(opts AllocateOptions) (Descriptor, error) {
	sessionID := opts.SessionID
	if sessionID == "" {
		return Descriptor{}, errors.New("rtp: a session id is required")
	}

	mode := ModeRelay
	switch {
	case opts.Inactive:
		mode = ModeInactive
	case m.echoDiagnostic:
		mode = ModeEcho
	}
	audioPT := opts.AudioPayloadType

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Descriptor{}, ErrClosed
	}
	if existing, ok := m.sessions[sessionID]; ok {
		m.mu.Unlock()
		if (existing.transport == nil) != (opts.Transport == nil) {
			return Descriptor{}, errors.New("rtp: a live session cannot change its transport")
		}
		return m.describe(existing), nil
	}
	m.mu.Unlock()

	// Bind OUTSIDE the lock: holding the map's mutex across a syscall would serialise every call
	// setup behind the slowest bind.
	ports, err := m.allocator.Allocate()
	if err != nil {
		return Descriptor{}, err
	}

	session, err := NewSession(Options{
		Transport:                 opts.Transport,
		ID:                        sessionID,
		MuteIn:                    opts.MuteIn,
		MuteOut:                   opts.MuteOut,
		Ports:                     ports,
		Mode:                      mode,
		OrgID:                     opts.OrgID,
		CallID:                    opts.CallID,
		LegID:                     opts.LegID,
		AudioPayloadType:          audioPT,
		Format:                    opts.Format,
		TelephoneEventPayloadType: opts.TelephoneEventPayloadType,
		Logger:                    m.log,
		Ticker:                    m.ticker,
		OnDtmf:                    m.announceDtmf,
		DtmfMaxDigitDuration:      m.dtmfMaxDigit,
	})
	if err != nil {
		_ = ports.Close()
		return Descriptor{}, err
	}

	m.mu.Lock()
	// Re-check both invariants: a concurrent allocate may have won and Drain may have started.
	// Losing either race must release the port just taken rather than leak it.
	if m.closed {
		m.mu.Unlock()
		_ = session.Close()
		return Descriptor{}, ErrClosed
	}
	if existing, ok := m.sessions[sessionID]; ok {
		m.mu.Unlock()
		_ = session.Close()
		if (existing.transport == nil) != (opts.Transport == nil) {
			return Descriptor{}, errors.New("rtp: a live session cannot change its transport")
		}
		return m.describe(existing), nil
	}
	m.sessions[sessionID] = session
	m.mu.Unlock()

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		if err := session.Run(context.Background()); err != nil {
			m.log.Error("session read loop stopped", "sessionId", sessionID, "error", err)
		}
	}()

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		if err := session.RunRTCP(context.Background()); err != nil {
			m.log.Debug("session RTCP loop stopped", "sessionId", sessionID, "error", err)
		}
	}()

	m.log.Info("session allocated",
		"sessionId", sessionID,
		"callId", opts.CallID,
		"rtpPort", session.LocalPort(),
		"mode", session.Mode(),
		"audioPayloadType", audioPT,
		"live", m.Len())
	return m.describe(session), nil
}

// ApplyDirection re-points a live session's suppression gates after a renegotiation. Idempotent: it
// SETS both flags rather than toggling them.
//
// It does NOT touch the HOLD flag — a renegotiation answering `sendrecv` must not take a held
// caller off hold.
func (m *Manager) ApplyDirection(sessionID string, muteIn, muteOut bool) error {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return err
	}
	if (session.mutedIn.Load() || session.mutedOut.Load()) && !muteIn && !muteOut {
		session.rtpGraceUntil.Store(m.now().Add(m.rtpTimeout).UnixMilli())
	}
	session.mutedIn.Store(muteIn)
	if session.mutedOut.Swap(muteOut) && !muteOut {
		// The leg is about to hear a clock it has not been following, as at the end of a prompt.
		session.markNextForward.Store(true)
	}
	return nil
}

// SettleAnswer re-points a live session's negotiated codec once the callee's SDP answer arrives: a
// B-leg is originated without an offer, so its port is bound before the codec is known.
//
// It returns the session's updated descriptor, or ErrUnknownSession when the id names nothing here.
func (m *Manager) SettleAnswer(
	sessionID string,
	format audio.Format,
	audioPT, telephoneEventPT uint8,
) (Descriptor, error) {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return Descriptor{}, err
	}
	session.settleCodec(format, audioPT, telephoneEventPT)
	m.log.Info("session codec settled",
		"sessionId", sessionID,
		"audioPayloadType", audioPT,
		"telephoneEventPayloadType", telephoneEventPT)
	return m.describe(session), nil
}

// Release tears a session down, reporting whether there was one to tear down so a retried release
// can answer false rather than error.
func (m *Manager) Release(sessionID string) bool {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	var leftConference string
	if ok {
		delete(m.sessions, sessionID)
		// Releasing one half of a bridge tears the relay down; the other leg stays ALIVE and simply
		// stops having a peer.
		m.unbridgeSessionLocked(sessionID)
		// The room survives; what must not survive is a seat pointing at a closed socket.
		leftConference, _ = m.leaveConferenceLocked(sessionID)
	}
	m.mu.Unlock()

	if leftConference != "" {
		m.destroyConferenceIfEmpty(leftConference)
	}

	if !ok {
		return false
	}
	m.closeAndAnnounce(session, EndReasonReleased)
	m.log.Info("session released", "sessionId", sessionID, "live", m.Len())
	return true
}

// closeAndAnnounce shuts a session down and tells the Lifecycle, in that order.
//
// The summary is taken BEFORE the close, so it holds the session's final counters and latched far
// end. A live recording is finalised in BETWEEN: consumers tear the leg down on `session.ended`, so
// a `recording.finished` published after it would never be acted on.
func (m *Manager) closeAndAnnounce(session *Session, reason EndReason) {
	// A digit still open when the leg went away, surfaced before anything else about the session:
	// the arrival-driven cutoff never fires for a far end that stopped sending entirely.
	session.FlushDtmf()

	summary := session.Summary()
	recording := session.ActiveRecording()

	if err := session.Close(); err != nil {
		m.log.Warn("closing a session", "sessionId", session.ID, "error", err)
	}
	if recording != nil {
		m.awaitRecording(summary, recording)
	}
	if m.lifecycle != nil {
		m.lifecycle.SessionEnded(summary, reason)
	}
}

// awaitRecording waits for a recorder to finalise its file, then announces it. Bounded, so a drain
// on a stuck filesystem cannot turn one lost recording into a process that never exits.
func (m *Manager) awaitRecording(session SessionSummary, recording *Recording) {
	select {
	case <-recording.Done():
		m.announceRecording(session, recording)
	case <-time.After(recordingFinaliseTimeout):
		m.log.Warn("a recording did not finalise in time; its file may be left as a partial",
			"sessionId", session.SessionID, "recordingRef", recording.Ref())
	}
}

// recordingFinaliseTimeout bounds the wait above. See awaitRecording.
const recordingFinaliseTimeout = 5 * time.Second

// announceDtmf hands one detected keypress to the Lifecycle. Unindexed: a digit has no reference
// and nothing can be done to it after the fact.
func (m *Manager) announceDtmf(session *Session, digit DtmfDigit) {
	if m.lifecycle == nil {
		return
	}
	m.lifecycle.DtmfReceived(session.Summary(), digit)
}

// announceRecording cleans the reference index and tells the Lifecycle, exactly once. Two paths
// reach a finished recording — the watcher goroutine and a session teardown that waited for it —
// and the Once on the recording is what keeps them from announcing it twice.
func (m *Manager) announceRecording(session SessionSummary, recording *Recording) {
	recording.announceOnce.Do(func() {
		m.mu.Lock()
		if owner, ok := m.recordings[recording.Ref()]; ok && owner == session.SessionID {
			delete(m.recordings, recording.Ref())
		}
		m.mu.Unlock()

		summary := recording.Summary()
		if summary.Reason == RecordingError {
			m.log.Warn("a recording produced no file",
				"sessionId", session.SessionID, "recordingRef", summary.Ref,
				"detail", summary.Detail)
		}
		if m.lifecycle != nil {
			m.lifecycle.RecordingFinished(session, summary)
		}
	})
}

// Bridge starts a bidirectional relay between two sessions: each forwards what it receives out of
// the OTHER's socket, with no decode, mix or jitter buffer.
//
// Idempotent, and re-pointable: bridging the same pair again succeeds, and bridging a session that
// is already in another bridge MOVES it, which is what an attended transfer needs.
func (m *Manager) Bridge(bridgeID string, first, second string) error {
	switch {
	case bridgeID == "":
		return errors.New("rtp: a bridge id is required")
	case first == "" || second == "":
		return errors.New("rtp: a bridge needs two session ids")
	case first == second:
		return errors.New("rtp: cannot bridge a session to itself")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.closed {
		return ErrClosed
	}
	a, ok := m.sessions[first]
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownSession, first)
	}
	b, ok := m.sessions[second]
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownSession, second)
	}

	// Legs that agreed relay byte for byte; legs that differ get a translation installed on each
	// direction. The only bridge still refused is one whose codec this build cannot decode.
	transcoders, err := prepareTranscoders(a, b)
	if err != nil {
		return err
	}

	// Detach both first, so a re-bridge cannot leave a stale pointer pushing audio at a party that
	// is no longer in the conversation.
	m.unbridgeSessionLocked(first)
	m.unbridgeSessionLocked(second)
	m.leaveConferenceLocked(first)
	m.leaveConferenceLocked(second)

	transcoders.install(a, b)
	a.SetPeer(b)
	b.SetPeer(a)
	m.bridges[bridgeID] = [2]string{first, second}

	m.log.Info("sessions bridged", "bridgeId", bridgeID, "sessionIds", []string{first, second})
	return nil
}

// Unbridge stops a relay and leaves both sessions alive, reporting whether there was one to stop.
func (m *Manager) Unbridge(bridgeID string) ([]string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pair, ok := m.bridges[bridgeID]
	if !ok {
		return nil, false
	}
	m.detachLocked(bridgeID, pair)
	m.log.Info("sessions unbridged", "bridgeId", bridgeID, "sessionIds", pair[:])
	return []string{pair[0], pair[1]}, true
}

// unbridgeSessionLocked removes whatever bridge a session is in. Caller holds m.mu.
func (m *Manager) unbridgeSessionLocked(sessionID string) {
	for bridgeID, pair := range m.bridges {
		if pair[0] == sessionID || pair[1] == sessionID {
			m.detachLocked(bridgeID, pair)
			return
		}
	}
}

// detachLocked clears both peer pointers and forgets the bridge. Caller holds m.mu.
func (m *Manager) detachLocked(bridgeID string, pair [2]string) {
	for _, id := range pair {
		if session, ok := m.sessions[id]; ok {
			session.SetPeer(nil)
			// The translation goes with the bridge: leaving it installed would carry stale codec
			// state into whatever the leg is bridged to next.
			clearTranscoders(session)
		}
	}
	delete(m.bridges, bridgeID)
}

// StartPlayback plays a decoded clip towards one session's far end. It returns when the prompt is
// RUNNING, not when it has finished. The reference is indexed so a later `stop-playback` can find
// the session without scanning; the watcher below cleans the entry however the playback ended.
func (m *Manager) StartPlayback(sessionID string, opts PlaybackOptions) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrUnknownSession, sessionID)
	}
	m.mu.Unlock()

	// Started OUTSIDE the lock: it spawns a goroutine and touches the socket.
	playback, err := session.StartPlayback(opts)
	if err != nil {
		return err
	}

	m.trackPlayback(sessionID, session, opts.Ref, playback)

	m.log.Info("playback started",
		"sessionId", sessionID, "playbackRef", opts.Ref, "frames", len(opts.Frames))
	return nil
}

// trackPlayback indexes a running playback by reference and watches it to the end. Every playback
// the instance starts goes through here, hold music included.
func (m *Manager) trackPlayback(sessionID string, session *Session, ref string, playback *Playback) {
	m.mu.Lock()
	m.playbacks[ref] = sessionID
	m.mu.Unlock()

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		<-playback.Done()

		m.mu.Lock()
		// Only if it is still ours: a superseding playback with the same reference would otherwise
		// have its entry deleted by the one it replaced.
		if owner, ok := m.playbacks[ref]; ok && owner == sessionID &&
			session.ActivePlayback() == nil {
			delete(m.playbacks, ref)
		}
		m.mu.Unlock()

		summary := playback.Summary()
		if summary.Reason == PlaybackError {
			m.log.Warn("a playback failed; the far end heard part of a prompt or none of it",
				"sessionId", sessionID, "playbackRef", summary.Ref,
				"playedMs", summary.PlayedMs, "detail", summary.Detail)
		}
		if m.lifecycle != nil {
			m.lifecycle.PlaybackFinished(session.Summary(), summary)
		}
	}()
}

// StopPlayback interrupts a playback by reference and reports the session it was on. A false for a
// reference nothing is playing is a success at the wire, not an error.
func (m *Manager) StopPlayback(ref string) (string, bool) {
	m.mu.Lock()
	sessionID, ok := m.playbacks[ref]
	var session *Session
	if ok {
		session = m.sessions[sessionID]
	}
	m.mu.Unlock()

	if session == nil {
		return sessionID, false
	}
	return sessionID, session.StopPlayback(ref)
}

// SendDtmf generates a digit string towards one session's far end. It returns when injection is
// RUNNING, not when the last digit is on the wire. There is no index, unlike playbacks and
// recordings: a digit string has no reference and ends on its own.
func (m *Manager) SendDtmf(sessionID string, opts DtmfOptions) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	session, ok := m.sessions[sessionID]
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownSession, sessionID)
	}

	// Started OUTSIDE the lock: it spawns a goroutine and touches the socket.
	injection, err := session.SendDtmf(opts)
	if err != nil {
		return err
	}

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		<-injection.Done()
		if failure := injection.Err(); failure != nil {
			m.log.Warn("a DTMF string was cut short; the far end heard only part of it",
				"sessionId", sessionID, "digits", injection.Digits(),
				"sent", injection.Sent(), "error", failure)
		}
	}()
	return nil
}

// StartRecording writes one session's audio to a file, returning once the file exists and its
// header is written. The reference is indexed as a playback's is, and cleaned by the same watcher.
func (m *Manager) StartRecording(sessionID string, opts RecordingOptions) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	if _, taken := m.recordings[opts.Ref]; taken {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrAlreadyRecording, opts.Ref)
	}
	session, ok := m.sessions[sessionID]
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownSession, sessionID)
	}

	recording, err := session.StartRecording(opts)
	if err != nil {
		return err
	}

	m.mu.Lock()
	m.recordings[opts.Ref] = sessionID
	m.mu.Unlock()

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		<-recording.Done()
		// The teardown path may already have announced this one; announceRecording is idempotent.
		m.announceRecording(session.Summary(), recording)
	}()

	m.log.Info("recording started",
		"sessionId", sessionID, "recordingRef", opts.Ref,
		"direction", opts.Direction, "objectKey", opts.ObjectKey)
	return nil
}

// StopRecording finalises a recording by reference and reports the session it was on. A false for a
// reference nothing is recording is a success at the wire: it may already have finalised itself.
func (m *Manager) StopRecording(ref string) (string, bool) {
	m.mu.Lock()
	sessionID, ok := m.recordings[ref]
	var session *Session
	if ok {
		session = m.sessions[sessionID]
	}
	m.mu.Unlock()

	if session == nil {
		return sessionID, false
	}
	return sessionID, session.StopRecording(ref)
}

// RecordingSessionOf reports which session holds a recording reference, if any.
func (m *Manager) RecordingSessionOf(ref string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sessionID, ok := m.recordings[ref]
	return sessionID, ok
}

// TelephoneEventPayloadType reports the RFC 4733 type a live session answered with, and whether the
// session exists. Zero means the leg negotiated none, which is what `send-dtmf` refuses on.
func (m *Manager) TelephoneEventPayloadType(sessionID string) (uint8, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return 0, false
	}
	return session.TelephoneEventPayloadType(), true
}

// SessionTenancy reports the org and call a session was allocated for, as values rather than by
// handing the caller a live *Session.
func (m *Manager) SessionTenancy(sessionID string) (orgID, callID string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, found := m.sessions[sessionID]
	if !found {
		return "", "", false
	}
	return session.OrgID, session.CallID, true
}

// PlaybackSessionOf reports which session holds a playback reference, if any.
func (m *Manager) PlaybackSessionOf(ref string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sessionID, ok := m.playbacks[ref]
	return sessionID, ok
}

// BridgeOf reports which bridge a session is in, if any. Read by the session directory writer.
func (m *Manager) BridgeOf(sessionID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for bridgeID, pair := range m.bridges {
		if pair[0] == sessionID || pair[1] == sessionID {
			return bridgeID, true
		}
	}
	return "", false
}

// Get returns a live session by id.
func (m *Manager) Get(sessionID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[sessionID]
	return session, ok
}

// AudioPayloadType reports the audio payload type a live session answered with.
func (m *Manager) AudioPayloadType(sessionID string) (uint8, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return 0, false
	}
	return session.AudioPayloadType(), true
}

// Len is the number of live sessions.
func (m *Manager) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Capacity is how many sessions the port range can hold.
func (m *Manager) Capacity() int { return m.allocator.Capacity() }

// newTicker builds a pacing clock for anything this Manager owns that runs on one (the conference
// mixer), so a test can step a room frame by frame.
func (m *Manager) newTicker(interval time.Duration) (<-chan time.Time, func()) {
	if m.ticker != nil {
		return m.ticker(interval)
	}
	return systemTicker(interval)
}

func (m *Manager) describe(session *Session) Descriptor {
	return Descriptor{
		SessionID:                 session.ID,
		Address:                   m.public,
		RTPPort:                   session.LocalPort(),
		RTCPPort:                  session.LocalPort() + 1,
		SSRC:                      session.SSRC,
		Mode:                      session.Mode(),
		AudioPayloadType:          session.AudioPayloadType(),
		Format:                    session.Format(),
		TelephoneEventPayloadType: session.TelephoneEventPayloadType(),
	}
}

// ReapIdle closes sessions that have gone quiet and returns how many it closed.
//
// Two silences, reported as two reasons. A session that RECEIVED audio and then stopped is an RTP
// TIMEOUT: a media failure on a call the signalling plane still believes is up. A session that NEVER
// received a packet is a LEAK: nothing failed, the engine simply stopped knowing about it. One event
// for both would make every abandoned call setup count as a media failure.
func (m *Manager) ReapIdle() int {
	if m.idleAfter <= 0 && m.rtpTimeout <= 0 {
		return 0
	}
	now := m.now()

	type expiry struct {
		session   *Session
		reason    EndReason
		silentFor time.Duration
	}

	m.mu.Lock()
	var stale []expiry
	for id, session := range m.sessions {
		idle := session.Idle(now)
		heardSomething := session.lastPacket.Load() != 0
		// Held, muted and just-resumed sessions are EXPECTED to be silent, so they are exempt from
		// the RTP timeout — but only from that one. A leg that has never received a packet is a leak
		// whatever its direction, so the idle backstop below still applies to it.
		gatedSilence := session.held.Load() || session.mutedIn.Load() || session.mutedOut.Load() ||
			now.UnixMilli() < session.rtpGraceUntil.Load()

		switch {
		case heardSomething && !gatedSilence && m.rtpTimeout > 0 && idle > m.rtpTimeout:
			stale = append(stale, expiry{session, EndReasonRTPTimeout, idle})
		case !heardSomething && m.idleAfter > 0 && idle > m.idleAfter:
			stale = append(stale, expiry{session, EndReasonIdleReaped, idle})
		default:
			continue
		}
		delete(m.sessions, id)
		m.unbridgeSessionLocked(id)
		m.leaveConferenceLocked(id)
	}
	m.mu.Unlock()

	for _, entry := range stale {
		if entry.reason == EndReasonRTPTimeout {
			m.log.Warn("a session stopped receiving RTP; the call has lost audio",
				"sessionId", entry.session.ID, "callId", entry.session.CallID,
				"silentFor", entry.silentFor.String())
			if m.lifecycle != nil {
				m.lifecycle.RTPTimedOut(entry.session.Summary(), entry.silentFor)
			}
		} else {
			m.log.Warn("reaping an idle session; the engine never released it",
				"sessionId", entry.session.ID, "idle", entry.silentFor.String())
		}
		m.closeAndAnnounce(entry.session, entry.reason)
	}
	return len(stale)
}

// RunReaper drives ReapIdle on a ticker until the context is cancelled.
func (m *Manager) RunReaper(ctx context.Context) error {
	window := m.rtpTimeout
	if m.idleAfter > 0 && (window <= 0 || m.idleAfter < window) {
		window = m.idleAfter
	}
	if window <= 0 {
		<-ctx.Done()
		return ctx.Err()
	}
	// Several checks per window, driven by the SHORTER of the two, so a session is reaped near its
	// deadline rather than up to a whole window late.
	interval := window / 4
	if interval < time.Second {
		interval = time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if reaped := m.ReapIdle(); reaped > 0 {
				m.log.Warn("reaped idle sessions", "count", reaped, "live", m.Len())
			}
		}
	}
}

// Drain refuses new allocations, closes every live session and waits for the read loops to stop.
//
// Sessions are CLOSED rather than waited out: an RTP session ends when its call does, so waiting
// would block a deploy on the longest conversation on the box. Calls on this instance therefore lose
// audio at shutdown. What Drain guarantees is that the process does not exit with sockets still
// being read, so a restart finds its ports free.
func (m *Manager) Drain(ctx context.Context) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	live := make([]*Session, 0, len(m.sessions))
	for id, session := range m.sessions {
		live = append(live, session)
		delete(m.sessions, id)
	}
	m.bridges = make(map[string][2]string)
	rooms := make([]*Conference, 0, len(m.conferences))
	for id, conference := range m.conferences {
		rooms = append(rooms, conference)
		delete(m.conferences, id)
	}
	m.taps = make(map[string]tapRecord)
	m.mu.Unlock()

	// The mix loops stop BEFORE the sessions close, so no tick can find a member whose socket has
	// already gone.
	for _, conference := range rooms {
		conference.Stop()
	}

	if len(live) > 0 {
		m.log.Warn("draining live sessions; media on these calls stops now", "count", len(live))
	}
	m.closeAllAndAnnounce(ctx, live)

	stopped := make(chan struct{})
	go func() {
		m.running.Wait()
		close(stopped)
	}()

	select {
	case <-stopped:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("rtp: draining %d sessions: %w", len(live), ctx.Err())
	}
}

// drainCloseWorkers bounds how many sessions a drain closes at once. See closeAllAndAnnounce.
const drainCloseWorkers = 16

// closeAllAndAnnounce closes a drained instance's sessions, in parallel and under the drain's
// deadline. A bounded pool, because closeAndAnnounce waits up to recordingFinaliseTimeout per
// recorder and the work is a filesystem flush.
//
// When the deadline lands mid-drain the remaining sessions still get their sockets closed, without
// the announce: a port handed back late beats a port the exiting process never released.
func (m *Manager) closeAllAndAnnounce(ctx context.Context, live []*Session) {
	if len(live) == 0 {
		return
	}
	workers := min(drainCloseWorkers, len(live))

	work := make(chan *Session)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for session := range work {
				m.closeAndAnnounce(session, EndReasonDrained)
			}
		})
	}

	go func() {
		defer close(work)
		for index, session := range live {
			select {
			case work <- session:
			case <-ctx.Done():
				m.log.Warn("the drain deadline landed mid-close; closing the rest without announcing",
					"remaining", len(live)-index)
				for _, remaining := range live[index:] {
					if err := remaining.Close(); err != nil {
						m.log.Warn("closing a session", "sessionId", remaining.ID, "error", err)
					}
				}
				return
			}
		}
	}()

	closed := make(chan struct{})
	go func() {
		wg.Wait()
		close(closed)
	}()
	select {
	case <-closed:
	case <-ctx.Done():
	}
}
