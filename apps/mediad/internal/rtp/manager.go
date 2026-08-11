package rtp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"sync"
	"time"
)

// ErrClosed is returned by Allocate after the manager has begun draining.
//
// Distinct from ErrPortsExhausted: exhaustion means "try again later or try another instance",
// shutting down means "this instance is going away, do not retry here". The engine routes those
// two refusals differently.
var ErrClosed = errors.New("rtp: the session manager is shutting down")

// Descriptor is what a caller needs to tell a far end where to send its media. It is the reply
// body of an allocate, expressed in the packet path's own vocabulary so the control package can
// translate it to the wire without reaching into a Session.
type Descriptor struct {
	SessionID    string
	Address      netip.Addr
	RTPPort      int
	RTCPPort     int
	SSRC         uint32
	Mode         Mode
	PayloadTypes []uint8
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

	mu       sync.Mutex
	sessions map[string]*Session
	closed   bool

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
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// Now is the clock, for tests.
	Now func() time.Time
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
		allocator: opts.Allocator,
		public:    opts.PublicAddr.Unmap(),
		log:       opts.Logger,
		idleAfter: opts.IdleAfter,
		now:       opts.Now,
		sessions:  make(map[string]*Session),
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
func (m *Manager) Allocate(sessionID string, mode Mode) (Descriptor, error) {
	if sessionID == "" {
		return Descriptor{}, errors.New("rtp: a session id is required")
	}

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
		ID:     sessionID,
		Ports:  ports,
		Mode:   mode,
		Logger: m.log,
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

	m.log.Info("session allocated",
		"sessionId", sessionID,
		"rtpPort", session.LocalPort(),
		"mode", session.Mode(),
		"live", m.Len())
	return m.describe(session), nil
}

// Release tears a session down. It reports whether there was one to tear down, so the caller can
// tell "released" from "already gone" — the engine retries a release, and a retry answering
// "released: false" is the honest answer rather than an error.
func (m *Manager) Release(sessionID string) bool {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if !ok {
		return false
	}
	if err := session.Close(); err != nil {
		m.log.Warn("closing a session", "sessionId", sessionID, "error", err)
	}
	m.log.Info("session released", "sessionId", sessionID, "live", m.Len())
	return true
}

// Get returns a live session by id.
func (m *Manager) Get(sessionID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[sessionID]
	return session, ok
}

// Len is the number of live sessions.
func (m *Manager) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// Capacity is how many sessions the port range can hold.
func (m *Manager) Capacity() int { return m.allocator.Capacity() }

func (m *Manager) describe(session *Session) Descriptor {
	return Descriptor{
		SessionID:    session.ID,
		Address:      m.public,
		RTPPort:      session.LocalPort(),
		RTCPPort:     session.LocalPort() + 1,
		SSRC:         session.SSRC,
		Mode:         session.Mode(),
		PayloadTypes: SupportedPayloadTypes(),
	}
}

// ReapIdle closes sessions with no traffic for longer than IdleAfter and returns how many it
// closed. Zero IdleAfter disables it entirely.
//
// A backstop, not a teardown policy — see config.SessionIdleTimeout. It is exported so a test can
// run it without waiting for a ticker.
func (m *Manager) ReapIdle() int {
	if m.idleAfter <= 0 {
		return 0
	}
	now := m.now()

	m.mu.Lock()
	var stale []*Session
	for id, session := range m.sessions {
		if session.Idle(now) > m.idleAfter {
			stale = append(stale, session)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()

	for _, session := range stale {
		m.log.Warn("reaping an idle session; the engine never released it",
			"sessionId", session.ID, "idle", session.Idle(now).String())
		if err := session.Close(); err != nil {
			m.log.Warn("closing an idle session", "sessionId", session.ID, "error", err)
		}
	}
	return len(stale)
}

// RunReaper drives ReapIdle on a ticker until the context is cancelled.
func (m *Manager) RunReaper(ctx context.Context) error {
	if m.idleAfter <= 0 {
		<-ctx.Done()
		return ctx.Err()
	}
	// Check several times per idle window, so a session is reaped near its deadline rather than up
	// to a whole window late.
	interval := m.idleAfter / 4
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
	m.mu.Unlock()

	if len(live) > 0 {
		m.log.Warn("draining live sessions; media on these calls stops now", "count", len(live))
	}
	for _, session := range live {
		if err := session.Close(); err != nil {
			m.log.Warn("closing a session during drain", "sessionId", session.ID, "error", err)
		}
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
