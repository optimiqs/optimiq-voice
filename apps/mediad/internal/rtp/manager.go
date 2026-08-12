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

// ErrClosed is returned by Allocate after the manager has begun draining.
//
// Distinct from ErrPortsExhausted: exhaustion means "try again later or try another instance",
// shutting down means "this instance is going away, do not retry here". The engine routes those
// two refusals differently.
var ErrClosed = errors.New("rtp: the session manager is shutting down")

// ErrUnknownSession is returned by the commands that address an existing session.
//
// Distinct from every other failure because the engine's recovery is different: exhaustion means
// "retry", shutting down means "retry elsewhere", and this one means "your picture of this call is
// wrong". The control surface turns it into `unknown_session`, and the session directory is what
// lets the engine tell that from "the session is on my neighbour".
var ErrUnknownSession = errors.New("rtp: no such session on this instance")

// ErrCodecMismatch WAS returned when two sessions could not be bridged because their answers settled
// on different G.711 variants. Rung 7 removed the refusal it named.
//
// Kept as a name with a comment rather than deleted silently, because it is the clearest possible
// record of what changed: design doc §7 said "a codec mismatch is resolved in SDP negotiation by
// refusing the offer, not in the media path by resampling", and that was the right trade for as long
// as there was no decode path in the service. Rung 6 built one. A mismatch is now TRANSLATED, and
// the only bridge still refused is one whose codec this build cannot decode at all — see
// ErrCannotTranscode in transcode.go.
//
// Deprecated: rung 7 transcodes. Branch on ErrCannotTranscode.
var ErrCodecMismatch = ErrCannotTranscode

// Descriptor is what a caller needs to tell a far end where to send its media. It is the reply
// body of an allocate, expressed in the packet path's own vocabulary so the control package can
// translate it to the wire without reaching into a Session.
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
//
// A struct rather than a parameter list because it has grown past the point where a reader at a
// call site can tell which string is which, and because the next rung adds fields to it rather than
// arguments to every caller.
type AllocateOptions struct {
	// SessionID is caller-assigned and required. See the note on Allocate.
	SessionID string
	// OrgID, CallID and LegID travel to the session directory and the lifecycle events. mediad
	// does not route on any of them.
	OrgID  string
	CallID string
	LegID  string
	// AudioPayloadType is the audio payload type the SDP answer settled on.
	AudioPayloadType uint8
	// Format is the codec that payload type carries. Rung 7 made these two different questions: G.722
	// is static type 9, Opus is dynamic, and a number alone stopped naming a codec.
	Format audio.Format
	// TelephoneEventPayloadType is the RFC 4733 type the answer settled on, or 0 for none.
	TelephoneEventPayloadType uint8
	// Inactive puts the session in ModeInactive — a leg that is ringing but not yet talking.
	Inactive bool
	// MuteIn and MuteOut are the media-plane half of a non-sendrecv answer direction. Rung 5.
	//
	// They arrive on the ALLOCATE rather than as a separate command because that is where the
	// direction is decided: a re-INVITE carrying `a=sendonly` is answered by this service, and a leg
	// whose answer said `recvonly` must not be sending. Setting them here means the gate is up before
	// the first packet after the renegotiation, rather than one round trip later.
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

// Lifecycle is how the packet path tells the outside world a session changed state.
//
// An interface, and one the Manager calls SYNCHRONOUSLY but from a goroutine it owns, so that the
// packet path never blocks on a NATS publish or a KV write. The control package supplies the real
// implementation; tests supply a recorder; a Manager with none is a Manager that just does not
// announce anything, which is what every packet-path unit test wants.
type Lifecycle interface {
	// SessionEnded is called exactly once per session, after its sockets are closed.
	SessionEnded(session SessionSummary, reason EndReason)
	// RTPTimedOut is called before the SessionEnded that follows it, and only for that reason.
	RTPTimedOut(session SessionSummary, silentFor time.Duration)
	// PlaybackFinished is called exactly once per started playback, however it ended.
	//
	// Including when the SESSION ended under it, which is why the summary is passed rather than
	// looked up: by the time this runs the session may already be closed and out of the map. On
	// that path the ordering against SessionEnded is not guaranteed and does not need to be — both
	// carry the session id, and a consumer asking "did the prompt play" is reading `playedMs`, not
	// inferring it from arrival order.
	PlaybackFinished(session SessionSummary, playback PlaybackSummary)
	// DtmfReceived is called once per detected KEYPRESS, never once per RFC 4733 packet.
	//
	// It fires whether or not the session is bridged — a leg collecting a PIN has no peer — and it
	// does not stop the packet being relayed to one that does. Called from the session's read
	// goroutine, so an implementation must not block on anything slower than a channel send.
	DtmfReceived(session SessionSummary, digit DtmfDigit)
	// RecordingFinished is called exactly once per started recording, after the file is on disk.
	//
	// Unlike PlaybackFinished, the ordering here IS guaranteed: when a session ends under a live
	// recording this runs BEFORE the SessionEnded that follows it, because the engine tears the leg
	// down on `session.ended` and a consumer that had already moved on would never learn the file
	// existed. It is also announced only after the WAV has been finalised and renamed, since the
	// whole point of the event is that the bytes are safe to read.
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
	// time as the far end reported them.
	//
	// It is on the SUMMARY and NOT on the wire, and that is a contract gap rather than a decision:
	// `media.evt.v1.….session.ended` has no field for any of it, so a `mediad` that measures call
	// quality has nowhere to say so. Carrying it here means the computation is done, tested and
	// available the moment `packages/events` grows the fields — see this wave's report.
	Quality QualityStats
}

// Manager owns every live session: it allocates ports, runs each session's read loop, reaps idle
// ones, and drains them all on shutdown.
//
// It is the only thing in mediad that knows how many calls are up, which makes it the natural
// place for the capacity refusal and for the shutdown barrier.
type Manager struct {
	allocator *Allocator
	public    netip.Addr
	log       *slog.Logger
	idleAfter time.Duration
	// now is swapped in tests so idle reaping is asserted without sleeping.
	now func() time.Time

	// rtpTimeout is the "audio stopped" window. Distinct from idleAfter — see ReapIdle.
	rtpTimeout time.Duration
	// echoDiagnostic makes a freshly allocated session echo instead of relay. Off in production;
	// design doc open question 5.
	echoDiagnostic bool
	lifecycle      Lifecycle
	// ticker is handed to every session it creates. See ManagerOptions.Ticker.
	ticker func(time.Duration) (<-chan time.Time, func())
	// dtmfMaxDigit bounds one detected digit on every session it creates.
	dtmfMaxDigit time.Duration

	mu       sync.Mutex
	sessions map[string]*Session
	// bridges maps a caller-assigned bridge id to the two sessions relaying under it.
	//
	// Held HERE rather than on the sessions, even though each session already points at its peer,
	// because unbridge addresses a bridge by id and a session pair cannot be looked up from one. The
	// peer pointers are the packet path's view; this is the control surface's.
	bridges map[string][2]string
	// playbacks maps a playback reference to the session playing it.
	//
	// Held HERE and not only on the session because `rpc.media.v1.stop-playback` carries a
	// reference and NOTHING ELSE — `MediaPort.stopPlayback(playbackRef)` has no channel id to give
	// — so without this index a stop would have to scan every live session on the instance.
	playbacks map[string]string
	// recordings maps a recording reference to the session being recorded, for the same reason
	// `playbacks` exists: `rpc.media.v1.stop-recording` carries a reference and nothing else.
	recordings map[string]string
	// conferences maps a room id to the mix running under it. Rung 6.
	//
	// A separate index from `bridges` rather than a generalisation of it, and that is the decision:
	// a bridge and a conference are different objects on the wire (`bridge-sessions` takes exactly
	// two session ids and refuses three), they have different costs, and a two-party call must keep
	// being a relay unless something asks for a mix. Collapsing them would put a jitter buffer and a
	// codec round trip on every call in the deployment to serve the conferences.
	conferences map[string]*Conference
	// taps maps a tap id to the room it joined, because `untap-session` carries a tap id and nothing
	// else — the same reason the playback and recording indexes exist.
	taps   map[string]tapRecord
	closed bool

	// running tracks each session's read goroutine so Drain can wait for the packet path to stop
	// before the process exits, rather than exiting with sockets still being read.
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
// # Idempotent by session id
//
// An allocate for an id that already has a session returns THAT session, and does not open a
// second port. This is not a convenience: the control surface is NATS request-reply over an
// unreliable transport, so the engine's retry after a timeout is indistinguishable at this layer
// from a fresh request. Without idempotency every timed-out allocate would leak a port and the
// engine would hold a descriptor pointing at the wrong one. With it, a retry is free and the reply
// the engine finally receives is the truth.
//
// The mode of an existing session is NOT changed by a repeat allocate: a retry must not mutate a
// live call. A genuine mode change is a separate operation, and arrives with the capability that
// needs it.
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
		return m.describe(existing), nil
	}
	m.mu.Unlock()

	// Bind OUTSIDE the lock: net.ListenUDP is a syscall, and holding the map's mutex across it
	// would serialise every call setup in the process behind the slowest bind.
	ports, err := m.allocator.Allocate()
	if err != nil {
		return Descriptor{}, err
	}

	session, err := NewSession(Options{
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
	// Re-check both invariants: between the unlock above and here, a concurrent allocate for the
	// same id may have won, and Drain may have started. Losing either race must release the port
	// just taken rather than leak it.
	if m.closed {
		m.mu.Unlock()
		_ = session.Close()
		return Descriptor{}, ErrClosed
	}
	if existing, ok := m.sessions[sessionID]; ok {
		m.mu.Unlock()
		_ = session.Close()
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

	// The RTCP loop, which reads the odd port design doc §6.3 has had bound and unread since rung 0.
	// A second goroutine per session and the same argument as the first: parked on a read, costing a
	// few kilobytes, and it is what makes per-leg loss and round-trip time knowable at all.
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

// ApplyDirection re-points a live session's suppression gates after a renegotiation. Rung 5.
//
// Idempotent by construction, because it SETS both flags rather than toggling them: a retried
// allocate carries the same direction and writes the same two values, and only a genuinely changed
// direction changes anything. That is what lets `allocate-session` stay "a retry must not mutate a
// live call" while still being the subject a re-INVITE arrives on.
//
// It does NOT touch the HOLD flag, which is a different state with a different owner: hold is
// mediad's own bookkeeping for a leg taken out of a conversation with music, and a renegotiation
// that happened to answer `sendrecv` must not quietly take a held caller off hold.
func (m *Manager) ApplyDirection(sessionID string, muteIn, muteOut bool) error {
	session, err := m.liveSession(sessionID)
	if err != nil {
		return err
	}
	session.mutedIn.Store(muteIn)
	if session.mutedOut.Swap(muteOut) && !muteOut {
		// The leg is about to start hearing the conversation again from a clock it has not been
		// following. Same flag, same reason, as the end of a prompt.
		session.markNextForward.Store(true)
	}
	return nil
}

// Release tears a session down. It reports whether there was one to tear down, so the caller can
// tell "released" from "already gone" — the engine retries a release, and a retry answering
// "released: false" is the honest answer rather than an error.
func (m *Manager) Release(sessionID string) bool {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	var leftConference string
	if ok {
		delete(m.sessions, sessionID)
		// Releasing one half of a bridge tears the whole relay down. The other leg stays ALIVE and
		// simply stops having a peer, which is the correct shape of "one party hung up": the
		// survivor is still allocated, and the engine decides whether it hears a prompt, gets
		// re-bridged somewhere else, or is released in turn.
		m.unbridgeSessionLocked(sessionID)
		// A participant leaving a conference is the same shape one leg further out: the ROOM survives
		// and the others keep talking. What must not survive is a seat pointing at a closed socket,
		// because the mixer would go on encoding a frame for it fifty times a second.
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
// The summary is taken BEFORE the close so the counters and the latched far end are the session's
// final state rather than a zeroed struct, and the announcement happens after so a consumer that
// reacts by asking about the session gets the truth.
//
// A live RECORDING is finalised in between, and the order is a contract rather than tidiness: the
// engine tears the leg down on `session.ended`, so a `recording.finished` published after it would
// arrive to a consumer that has already written the CDR and moved on — and the file, which exists
// and is perfectly good, would never be archived. Waiting is bounded by a flush and a rename.
func (m *Manager) closeAndAnnounce(session *Session, reason EndReason) {
	// A digit still open when the leg went away, surfaced before anything else is said about the
	// session. It is the backstop for a far end that began a tone and stopped sending entirely: the
	// arrival-driven cutoff never fires because nothing arrives, and the engine tears the leg down on
	// `session.ended`, so a keypress announced after it would reach a consumer that had already
	// finished with the call.
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

// awaitRecording waits for a recorder to finalise its file, then announces it.
//
// Bounded, because a drain that hung on a stuck filesystem would turn one lost recording into a
// process that never exits. The deadline is generous next to what finalising costs — a buffer
// flush, a header patch, an fsync and a rename — so hitting it means the disk is gone, which is
// worth a WARN and is not worth blocking a shutdown for.
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

// announceDtmf hands one detected keypress to the Lifecycle.
//
// Deliberately trivial, and deliberately not indexed by anything: unlike a playback or a recording,
// a digit has no reference and nothing can be done to it after the fact. It is a fact about a leg,
// so it needs the leg's summary and nothing else.
func (m *Manager) announceDtmf(session *Session, digit DtmfDigit) {
	if m.lifecycle == nil {
		return
	}
	m.lifecycle.DtmfReceived(session.Summary(), digit)
}

// announceRecording cleans the reference index and tells the Lifecycle, exactly once.
//
// Two paths reach a finished recording — the watcher goroutine StartRecording spawns, and a session
// teardown that had to wait for it — and a `recording.finished` published twice would file two rows
// for one file. The Once on the recording itself is what makes them idempotent with respect to each
// other without either having to know the other exists.
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

// Bridge starts a bidirectional relay between two sessions.
//
// # What a bridge IS here
//
// Two pointers. Each session forwards what it receives out of the OTHER's socket, to the other's
// latched far end — no decode, no mix, no jitter buffer, and therefore no added latency and no
// audio-quality argument to have against Asterisk. RFC 4733 DTMF rides through it for free, because
// a telephone-event payload is just bytes to a relay.
//
// # Idempotent, and re-pointable
//
// Bridging the same id to the same pair again is a no-op that answers success, for the same reason
// allocate is idempotent: the engine's retry after a timeout is indistinguishable from a fresh
// request at this layer. Bridging a session that is ALREADY in another bridge moves it — that is an
// attended transfer, and refusing it would mean the engine had to unbridge first and the caller
// would hear a gap in between.
func (m *Manager) Bridge(bridgeID string, first, second string) error {
	switch {
	case bridgeID == "":
		return errors.New("rtp: a bridge id is required")
	case first == "" || second == "":
		return errors.New("rtp: a bridge needs two session ids")
	case first == second:
		// A session relaying to itself is an echo with extra steps, and the only way to ask for one
		// is a bug in the caller — most likely the same leg added to a bridge twice.
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

	// RUNG 7 CHANGED THIS LINE. Until now a bridge between two legs that answered different codecs
	// was refused — design doc §7's "a codec mismatch is resolved in SDP negotiation by refusing the
	// offer, not in the media path by resampling", which was the right trade while there was no
	// decode path anywhere in the service. Rung 6 built one, so the premise is gone: the two legs are
	// bridged and a translation is installed on each direction. What survives is the FAST PATH — two
	// legs that agreed still relay byte for byte, with no codec touched — and the refusal, now
	// narrowed to a codec this build genuinely cannot decode. See transcode.go.
	transcoders, err := prepareTranscoders(a, b)
	if err != nil {
		return err
	}

	// Detach both from whatever they were in, so a re-bridge cannot leave a stale pointer behind
	// pushing audio at a party that is no longer in the conversation.
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

// Unbridge stops a relay and leaves both sessions alive.
//
// Reports whether there was a relay to stop, so the caller can tell "unbridged" from "already
// gone" — the engine retries an unbridge, and a retry answering false is the honest answer rather
// than an error.
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
			// The translation goes with the bridge it belonged to. Leaving it installed would mean a
			// leg re-bridged to a peer that DOES agree with it still paying for a decode and an
			// encode, and — worse — a leg that ended up with no peer holding codec state that a later
			// bridge would resume mid-stream.
			clearTranscoders(session)
		}
	}
	delete(m.bridges, bridgeID)
}

// StartPlayback plays a decoded clip towards one session's far end.
//
// It returns when the prompt is RUNNING, not when it has finished — see Session.StartPlayback for
// why, and Playback for what replacing the peer's audio does and does not interrupt.
//
// The reference is indexed here so a later `stop-playback`, which carries nothing but the
// reference, can find the session without scanning. The index is cleaned by the watcher below,
// however the playback ended, so a completed prompt does not leave a reference behind that a late
// stop would match against a session that has since started a different one.
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

	// Started OUTSIDE the lock: it spawns a goroutine and touches the socket, and holding the map's
	// mutex across that would serialise every prompt on the instance behind the slowest one.
	playback, err := session.StartPlayback(opts)
	if err != nil {
		return err
	}

	m.mu.Lock()
	m.playbacks[opts.Ref] = sessionID
	m.mu.Unlock()

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		<-playback.Done()

		m.mu.Lock()
		// Only if it is still OURS: a superseding playback with the same reference would otherwise
		// have its index entry deleted by the one it replaced.
		if owner, ok := m.playbacks[opts.Ref]; ok && owner == sessionID &&
			session.ActivePlayback() == nil {
			delete(m.playbacks, opts.Ref)
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

	m.log.Info("playback started",
		"sessionId", sessionID, "playbackRef", opts.Ref, "frames", len(opts.Frames))
	return nil
}

// StopPlayback interrupts a playback by reference and reports the session it was on.
//
// Answering `false` for a reference nothing is playing is a SUCCESS at the wire, not an error: a
// caller who lets a menu run to the end and then presses a digit produces exactly this on every
// call, because `gather` stops its prompt whatever ended the collection.
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

// SendDtmf generates a digit string towards one session's far end. Rung 3.
//
// It returns when injection is RUNNING, not when the last digit is on the wire — see
// Session.SendDtmf for why that mirrors ARI, and DtmfInjection for what taking the outbound stream
// does and does not interrupt.
//
// There is no index here, unlike playbacks and recordings, because there is nothing to look a digit
// string up BY: `MediaPort.sendDtmf` hands back no reference and there is no `stop-dtmf` to key on.
// A string is bounded by construction and ends on its own.
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

	// Started OUTSIDE the lock: it spawns a goroutine and touches the socket, and holding the map's
	// mutex across that would serialise every digit on the instance behind the slowest one.
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

// StartRecording writes one session's audio to a file. Rung 4.
//
// It returns once the file exists and its header is written. The reference is indexed here so a
// later `stop-recording`, which carries nothing but the reference, can find the session without
// scanning — the same reason the playback index exists, and cleaned by the same shape of watcher.
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
		// The teardown path may already have announced this one, having waited for exactly the
		// channel above. announceRecording is idempotent for that reason.
		m.announceRecording(session.Summary(), recording)
	}()

	m.log.Info("recording started",
		"sessionId", sessionID, "recordingRef", opts.Ref,
		"direction", opts.Direction, "objectKey", opts.ObjectKey)
	return nil
}

// StopRecording finalises a recording by reference and reports the session it was on.
//
// Answering `false` for a reference nothing is recording is a SUCCESS at the wire, not an error: a
// recording that hit its duration limit, or whose leg hung up, has already finalised itself by the
// time the engine's teardown gets around to stopping it.
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

// SessionTenancy reports the org and call a session was allocated for.
//
// The control surface's one other question about a leg, answered as VALUES for the same reason
// AudioPayloadType is: a recording's path is derived from the tenant and the call, both of which
// arrived on the allocate and live on the session, and handing the handler a live *Session so it
// could read two strings would put the packet path's internals inside a NATS callback.
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

// AudioPayloadType reports the G.711 type a live session answered with.
//
// The control surface's one question about a leg, answered as a value rather than by handing it the
// session — see the note on control.Sessions.
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

// newTicker builds a pacing clock for anything this Manager owns that runs on one — today the
// conference mixer. It is the Manager's ticker rather than time.NewTicker so a test can step a
// conference frame by frame, exactly as it steps a playback.
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
// # Two different silences, and why they are not one check
//
// A session that RECEIVED audio and then stopped is an RTP TIMEOUT: a call that is still up as far
// as the signalling plane is concerned, and whose two parties can no longer hear each other. A NAT
// binding expired, a network dropped, an endpoint crashed without sending BYE. It is a media
// failure, the engine wants to know about it while the call is notionally live, and it is
// announced as `session.rtp-timeout` followed by a `session.ended` carrying that reason.
//
// A session that NEVER received a packet and simply aged out is a LEAK: the engine allocated it and
// then stopped knowing about it — it crashed mid-call, or a release was never sent, or the far end
// never answered the INVITE. Nothing failed in the media path, because nothing ever happened in it.
// It is announced as `idle-reaped`, and it exists to stop a leaked port from being permanent
// capacity loss until a restart.
//
// Reporting them as one event would mean a consumer counting media failures counted every abandoned
// call setup as one.
//
// Exported so a test can run it without waiting for a ticker.
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
		heardSomething := session.Stats().LastPacketUnixMs != 0

		switch {
		case heardSomething && m.rtpTimeout > 0 && idle > m.rtpTimeout:
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
	// Check several times per window, so a session is reaped near its deadline rather than up to a
	// whole window late. Driven by the SHORTER of the two windows, because a tick sized for the
	// longer one would make the shorter deadline meaningless.
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
// # Why sessions are closed rather than waited out
//
// A media server cannot drain the way an HTTP server does. There is no "last request" to finish:
// an RTP session ends when a call ends, and a call can last hours. Waiting would mean a deploy
// blocks on the longest conversation on the box.
//
// So v0 closes them, and the honest description of that is "calls on this instance lose audio at
// shutdown". Making it graceful is a real requirement and a real design problem — it means moving
// sessions to another instance, which needs a session directory in NATS KV and a signalling
// re-INVITE — and it is called out as open question 3 in plans/mediad-design.md §10 rather than
// pretended away here. What Drain does guarantee is that the process does not exit with sockets
// still being read, so a restart finds its ports free.
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
	// already gone. They are goroutines this Manager started, so they are also what `running` is
	// waiting on below.
	for _, conference := range rooms {
		conference.Stop()
	}

	if len(live) > 0 {
		m.log.Warn("draining live sessions; media on these calls stops now", "count", len(live))
	}
	for _, session := range live {
		m.closeAndAnnounce(session, EndReasonDrained)
	}

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
