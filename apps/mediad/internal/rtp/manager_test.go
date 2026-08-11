package rtp_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

var publicAddr = netipMustParseStatic("203.0.113.10")

func newManager(t *testing.T, low, high int, idleAfter time.Duration, now func() time.Time) *rtp.Manager {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		IdleAfter:  idleAfter,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:        now,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})
	return manager
}

func TestNewManagerValidatesItsOptions(t *testing.T) {
	allocator := newAllocator(t, 55000, 55009)

	if _, err := rtp.NewManager(rtp.ManagerOptions{PublicAddr: publicAddr}); err == nil {
		t.Error("NewManager accepted a nil allocator")
	}
	if _, err := rtp.NewManager(rtp.ManagerOptions{Allocator: allocator}); err == nil {
		t.Error("NewManager accepted an invalid public address")
	}
}

func TestAllocateDescribesTheSession(t *testing.T) {
	manager := newManager(t, 55100, 55119, 0, nil)

	descriptor, err := manager.Allocate("session-1", rtp.ModeEcho)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	if descriptor.SessionID != "session-1" {
		t.Errorf("SessionID = %q", descriptor.SessionID)
	}
	// The advertised address, not the bind address the sockets are actually on.
	if descriptor.Address != publicAddr {
		t.Errorf("Address = %s, want the configured public %s", descriptor.Address, publicAddr)
	}
	if descriptor.RTPPort%2 != 0 {
		t.Errorf("RTPPort %d is odd", descriptor.RTPPort)
	}
	if descriptor.RTCPPort != descriptor.RTPPort+1 {
		t.Errorf("RTCPPort = %d, want %d", descriptor.RTCPPort, descriptor.RTPPort+1)
	}
	if descriptor.SSRC == 0 {
		t.Error("SSRC is zero")
	}
	if descriptor.Mode != rtp.ModeEcho {
		t.Errorf("Mode = %q", descriptor.Mode)
	}
	if manager.Len() != 1 {
		t.Errorf("Len() = %d, want 1", manager.Len())
	}
}

// Idempotency is the whole reason the session id is caller-assigned. The control surface is NATS
// request-reply, so a retry after a timeout is indistinguishable here from a fresh request; without
// this, every timed-out allocate would leak a port.
func TestAllocateIsIdempotentBySessionID(t *testing.T) {
	manager := newManager(t, 55200, 55219, 0, nil)

	first, err := manager.Allocate("same-id", rtp.ModeEcho)
	if err != nil {
		t.Fatalf("first Allocate: %v", err)
	}
	second, err := manager.Allocate("same-id", rtp.ModeEcho)
	if err != nil {
		t.Fatalf("second Allocate: %v", err)
	}

	if second.RTPPort != first.RTPPort {
		t.Errorf("a retry got port %d, want the original %d — the first port leaked",
			second.RTPPort, first.RTPPort)
	}
	if second.SSRC != first.SSRC {
		t.Errorf("a retry got a different SSRC (%#x vs %#x)", second.SSRC, first.SSRC)
	}
	if manager.Len() != 1 {
		t.Errorf("Len() = %d after a retried allocate, want 1", manager.Len())
	}
}

// A retry must not mutate a live call. A genuine mode change is a separate operation.
func TestARepeatAllocateDoesNotChangeTheMode(t *testing.T) {
	manager := newManager(t, 55300, 55319, 0, nil)

	if _, err := manager.Allocate("s1", rtp.ModeEcho); err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	second, err := manager.Allocate("s1", rtp.ModeInactive)
	if err != nil {
		t.Fatalf("second Allocate: %v", err)
	}
	if second.Mode != rtp.ModeEcho {
		t.Errorf("Mode = %q, want the original %q; a retry must not mutate a live session",
			second.Mode, rtp.ModeEcho)
	}
}

func TestConcurrentAllocateForOneIDYieldsOneSession(t *testing.T) {
	manager := newManager(t, 55400, 55439, 0, nil)

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		ports = map[int]bool{}
	)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			descriptor, err := manager.Allocate("racing-id", rtp.ModeEcho)
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			ports[descriptor.RTPPort] = true
		}()
	}
	wg.Wait()

	if len(ports) != 1 {
		t.Errorf("eight concurrent allocates for one id produced %d distinct ports: %v", len(ports), ports)
	}
	if manager.Len() != 1 {
		t.Errorf("Len() = %d, want 1", manager.Len())
	}
	// The losers of the race must have returned their ports, not leaked them.
	if manager.Capacity()-1 < 0 {
		t.Fatal("unexpected capacity")
	}
}

func TestAllocateRequiresASessionID(t *testing.T) {
	manager := newManager(t, 55500, 55509, 0, nil)
	if _, err := manager.Allocate("", rtp.ModeEcho); err == nil {
		t.Error("Allocate accepted an empty session id")
	}
}

func TestAllocateSurfacesExhaustion(t *testing.T) {
	manager := newManager(t, 55600, 55603, 0, nil) // two pairs

	for i, id := range []string{"a", "b"} {
		if _, err := manager.Allocate(id, rtp.ModeEcho); err != nil {
			t.Fatalf("Allocate #%d: %v", i, err)
		}
	}
	if _, err := manager.Allocate("c", rtp.ModeEcho); !errors.Is(err, rtp.ErrPortsExhausted) {
		t.Errorf("error = %v, want ErrPortsExhausted", err)
	}
}

func TestReleaseFreesThePortAndReportsWhatHappened(t *testing.T) {
	manager := newManager(t, 55700, 55703, 0, nil) // two pairs

	descriptor, err := manager.Allocate("s1", rtp.ModeEcho)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	if !manager.Release("s1") {
		t.Error("Release reported nothing to release")
	}
	if manager.Len() != 0 {
		t.Errorf("Len() = %d after a release, want 0", manager.Len())
	}
	// Idempotent: a retried release is not an error.
	if manager.Release("s1") {
		t.Error("the second Release claimed to have released something")
	}
	if manager.Release("never-existed") {
		t.Error("releasing an unknown id claimed to have released something")
	}

	// The port must really be free — the socket is closed and bindable again.
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: loopback.AsSlice(), Port: descriptor.RTPPort})
	if err != nil {
		t.Fatalf("port %d is still held after a release: %v", descriptor.RTPPort, err)
	}
	_ = probe.Close()
}

func TestGetReturnsALiveSession(t *testing.T) {
	manager := newManager(t, 55800, 55819, 0, nil)

	if _, ok := manager.Get("s1"); ok {
		t.Error("Get found a session that was never allocated")
	}
	if _, err := manager.Allocate("s1", rtp.ModeEcho); err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	session, ok := manager.Get("s1")
	if !ok {
		t.Fatal("Get did not find a live session")
	}
	if session.ID != "s1" {
		t.Errorf("session.ID = %q", session.ID)
	}
	manager.Release("s1")
	if _, ok := manager.Get("s1"); ok {
		t.Error("Get found a released session")
	}
}

// The idle reaper is a port-leak backstop: it catches sessions the engine stopped knowing about —
// a crash mid-call, a release that was never sent, a leg that never sent a packet.
func TestReapIdleClosesSessionsWithNoTraffic(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	manager := newManager(t, 55900, 55919, 30*time.Second, clock)

	if _, err := manager.Allocate("stale", rtp.ModeEcho); err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	// Not yet past the deadline.
	now = now.Add(20 * time.Second)
	if reaped := manager.ReapIdle(); reaped != 0 {
		t.Errorf("reaped %d sessions before the idle deadline", reaped)
	}
	if manager.Len() != 1 {
		t.Fatalf("Len() = %d", manager.Len())
	}

	now = now.Add(20 * time.Second) // 40s total, past the 30s deadline
	if reaped := manager.ReapIdle(); reaped != 1 {
		t.Errorf("reaped %d sessions past the idle deadline, want 1", reaped)
	}
	if manager.Len() != 0 {
		t.Errorf("Len() = %d after reaping, want 0", manager.Len())
	}
}

func TestReapIdleIsDisabledByAZeroTimeout(t *testing.T) {
	now := time.Now()
	manager := newManager(t, 56000, 56019, 0, func() time.Time { return now })

	if _, err := manager.Allocate("forever", rtp.ModeEcho); err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	now = now.Add(24 * time.Hour)
	if reaped := manager.ReapIdle(); reaped != 0 {
		t.Errorf("reaped %d sessions with reaping disabled", reaped)
	}
	if manager.Len() != 1 {
		t.Errorf("Len() = %d, want the session to survive", manager.Len())
	}
}

// Traffic keeps a session alive: a two-hour call must not be reaped for being "idle".
func TestReapIdleSparesASessionThatIsReceivingTraffic(t *testing.T) {
	manager := newManager(t, 56100, 56119, 50*time.Millisecond, nil)

	descriptor, err := manager.Allocate("busy", rtp.ModeEcho)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	farEnd, err := net.DialUDP("udp", nil,
		&net.UDPAddr{IP: loopback.AsSlice(), Port: descriptor.RTPPort})
	if err != nil {
		t.Fatalf("dialling the session: %v", err)
	}
	t.Cleanup(func() { _ = farEnd.Close() })

	session, ok := manager.Get("busy")
	if !ok {
		t.Fatal("the session is not live")
	}
	if _, err := farEnd.Write(g711Packet(1, 160, 0x0a0b0c0d)); err != nil {
		t.Fatalf("sending RTP: %v", err)
	}
	waitFor(t, "the packet to be received", func() bool {
		return session.Stats().PacketsReceived == 1
	})

	if reaped := manager.ReapIdle(); reaped != 0 {
		t.Errorf("reaped %d sessions that had just received traffic", reaped)
	}
}

func TestRunReaperStopsWithItsContext(t *testing.T) {
	manager := newManager(t, 56200, 56219, 20*time.Millisecond, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- manager.RunReaper(ctx) }()

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("RunReaper returned %v, want context.Canceled", err)
		}
	case <-time.After(readTimeout):
		t.Fatal("RunReaper did not stop with its context")
	}
}

// Drain refuses new work and frees everything. The refusal is a DISTINCT error from exhaustion:
// "this instance is going away" and "this instance is full" are routed differently by the engine.
func TestDrainClosesEverythingAndRefusesNewAllocations(t *testing.T) {
	allocator, err := rtp.NewAllocator(loopback, 56300, 56319)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	for _, id := range []string{"a", "b", "c"} {
		if _, err := manager.Allocate(id, rtp.ModeEcho); err != nil {
			t.Fatalf("Allocate %q: %v", id, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	if err := manager.Drain(ctx); err != nil {
		t.Fatalf("Drain: %v", err)
	}

	if manager.Len() != 0 {
		t.Errorf("Len() = %d after a drain, want 0", manager.Len())
	}
	if allocator.InUse() != 0 {
		t.Errorf("InUse() = %d after a drain; ports leaked", allocator.InUse())
	}
	if _, err := manager.Allocate("d", rtp.ModeEcho); !errors.Is(err, rtp.ErrClosed) {
		t.Errorf("Allocate after a drain returned %v, want ErrClosed", err)
	}
	// Draining twice is a no-op, so a signal handler racing an explicit shutdown is harmless.
	if err := manager.Drain(ctx); err != nil {
		t.Errorf("the second Drain returned %v", err)
	}
}

func netipMustParseStatic(raw string) netip.Addr {
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		panic(err)
	}
	return addr
}
