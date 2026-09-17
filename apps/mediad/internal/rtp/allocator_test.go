package rtp_test

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// loopback keeps every test's sockets on 127.0.0.1, so a test run never binds a routable address
// and never collides with a real media server on the host.
var loopback = netip.MustParseAddr("127.0.0.1")

// testRange sits below the macOS ephemeral range (49152+) so no stray process can take the ports.
const (
	testLow  = 39000
	testHigh = 39009 // five pairs
)

func newAllocator(t *testing.T, low, high int) *rtp.Allocator {
	t.Helper()
	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator(%d, %d): %v", low, high, err)
	}
	return allocator
}

func TestNewAllocatorRejectsBadRanges(t *testing.T) {
	cases := []struct {
		name      string
		bind      netip.Addr
		low, high int
		want      string
	}{
		{"odd start", loopback, 39001, 39010, "even port"},
		{"inverted", loopback, 39010, 39000, "empty"},
		{"no room for a pair", loopback, 39000, 39000, "no RTP/RTCP pair"},
		{"no bind address", netip.Addr{}, 39000, 39009, "bind address is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := rtp.NewAllocator(tc.bind, tc.low, tc.high); err == nil {
				t.Fatal("NewAllocator accepted a bad range")
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestCapacityIsPairsNotPorts(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)
	if got := allocator.Capacity(); got != 5 {
		t.Errorf("Capacity() = %d, want 5 (10 ports = 5 pairs)", got)
	}
}

// A pair is an even RTP port with the odd RTCP port above it, and both are really bound.
func TestAllocateBindsAnEvenPairInRange(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	if pair.Port%2 != 0 {
		t.Errorf("RTP port %d is odd; RFC 3550 §11 puts RTP on the even port", pair.Port)
	}
	if pair.Port < testLow || pair.Port+1 > testHigh {
		t.Errorf("pair %d/%d is outside the range %d-%d", pair.Port, pair.Port+1, testLow, testHigh)
	}
	if pair.RTP == nil || pair.RTCP == nil {
		t.Fatal("both sockets must be bound; RTCP is bound in v0 even though it is not read")
	}
	if got := pair.RTP.LocalAddr().(*net.UDPAddr).Port; got != pair.Port {
		t.Errorf("RTP socket is on %d but the pair says %d", got, pair.Port)
	}
	if got := pair.RTCP.LocalAddr().(*net.UDPAddr).Port; got != pair.Port+1 {
		t.Errorf("RTCP socket is on %d, want %d", got, pair.Port+1)
	}
}

func TestAllocateNeverHandsOutTheSamePortTwice(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	seen := make(map[int]bool)
	for i := range allocator.Capacity() {
		pair, err := allocator.Allocate()
		if err != nil {
			t.Fatalf("Allocate #%d: %v", i, err)
		}
		t.Cleanup(func() { _ = pair.Close() })
		if seen[pair.Port] {
			t.Fatalf("port %d was handed out twice", pair.Port)
		}
		seen[pair.Port] = true
	}
	if allocator.InUse() != allocator.Capacity() {
		t.Errorf("InUse() = %d, want %d", allocator.InUse(), allocator.Capacity())
	}
}

func TestAllocateReportsExhaustion(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	for i := range allocator.Capacity() {
		pair, err := allocator.Allocate()
		if err != nil {
			t.Fatalf("Allocate #%d: %v", i, err)
		}
		t.Cleanup(func() { _ = pair.Close() })
	}

	_, err := allocator.Allocate()
	if err == nil {
		t.Fatal("Allocate succeeded past the range's capacity")
	}
	// The control surface branches on this to answer `capacity` rather than `internal`.
	if !errors.Is(err, rtp.ErrPortsExhausted) {
		t.Errorf("error = %v, want it to wrap ErrPortsExhausted", err)
	}
}

func TestClosedPortsAreReusable(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	// Fill the range, then free one and prove the freed pair can be taken again.
	pairs := make([]*rtp.PortPair, 0, allocator.Capacity())
	for i := range allocator.Capacity() {
		pair, err := allocator.Allocate()
		if err != nil {
			t.Fatalf("Allocate #%d: %v", i, err)
		}
		pairs = append(pairs, pair)
	}
	t.Cleanup(func() {
		for _, pair := range pairs {
			_ = pair.Close()
		}
	})

	freed := pairs[2].Port
	if err := pairs[2].Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if allocator.InUse() != allocator.Capacity()-1 {
		t.Fatalf("InUse() = %d after a close, want %d", allocator.InUse(), allocator.Capacity()-1)
	}

	reused, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate after a release: %v", err)
	}
	t.Cleanup(func() { _ = reused.Close() })
	if reused.Port != freed {
		t.Errorf("reused port = %d, want the freed %d (it is the only one available)", reused.Port, freed)
	}
}

// Round-robin, not lowest-free: the far end of the call that just ended keeps sending for a few
// hundred milliseconds, and those packets would land on the next call's socket.
func TestAllocateCyclesTheRangeBeforeReusingAPort(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	first, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	firstPort := first.Port
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate after a release: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	if second.Port == firstPort {
		t.Errorf("the just-freed port %d was handed straight back out; late RTP from the previous "+
			"call would land on the new session's socket", firstPort)
	}
}

// Idempotent close: a session reaped and then released explicitly is the normal shape of that race,
// and releasing the port twice would hand one port to two callers.
func TestCloseIsIdempotent(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if err := pair.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := pair.Close(); err != nil {
		t.Errorf("second Close returned %v; it must be a no-op", err)
	}
	if allocator.InUse() != 0 {
		t.Errorf("InUse() = %d after a double close, want 0 — the port was released twice",
			allocator.InUse())
	}
}

// A port held by another process in the range is skipped rather than fatal.
func TestAllocateSkipsPortsHeldOutsideTheProcess(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	// Squat on the first pair's RTP port, exactly as a foreign process would.
	squatter, err := net.ListenUDP("udp", &net.UDPAddr{IP: loopback.AsSlice(), Port: testLow})
	if err != nil {
		t.Skipf("cannot squat on port %d: %v", testLow, err)
	}
	t.Cleanup(func() { _ = squatter.Close() })

	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	if pair.Port == testLow {
		t.Errorf("allocated port %d, which is held by another process", testLow)
	}
}

// A pair whose RTCP half cannot be bound must not leak its RTP half.
func TestAllocateSkipsAPairWhoseRTCPHalfIsHeld(t *testing.T) {
	allocator := newAllocator(t, testLow, testHigh)

	squatter, err := net.ListenUDP("udp", &net.UDPAddr{IP: loopback.AsSlice(), Port: testLow + 1})
	if err != nil {
		t.Skipf("cannot squat on port %d: %v", testLow+1, err)
	}
	t.Cleanup(func() { _ = squatter.Close() })

	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	if pair.Port == testLow {
		t.Errorf("allocated pair %d/%d but the RTCP half is held", pair.Port, pair.Port+1)
	}
	// A half-bound pair that leaked its descriptor would still hold testLow.
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: loopback.AsSlice(), Port: testLow})
	if err != nil {
		t.Fatalf("port %d is still held; the skipped pair leaked its RTP socket: %v", testLow, err)
	}
	_ = probe.Close()
}

// Concurrent allocation must never double-issue a port; many goroutines is the normal condition.
func TestConcurrentAllocateIssuesDistinctPorts(t *testing.T) {
	const low, high = 39100, 39139 // 20 pairs, below the ephemeral range like testLow/testHigh
	allocator := newAllocator(t, low, high)

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		ports = make(map[int]int)
		pairs []*rtp.PortPair
	)
	for range allocator.Capacity() {
		wg.Go(func() {
			pair, err := allocator.Allocate()
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			ports[pair.Port]++
			pairs = append(pairs, pair)
		})
	}
	wg.Wait()
	t.Cleanup(func() {
		for _, pair := range pairs {
			_ = pair.Close()
		}
	})

	for port, count := range ports {
		if count != 1 {
			t.Errorf("port %d was issued %d times", port, count)
		}
	}
	if len(pairs) != allocator.Capacity() {
		t.Errorf("allocated %d pairs concurrently, want the full capacity %d",
			len(pairs), allocator.Capacity())
	}
}
