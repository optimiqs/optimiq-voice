package rtp

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/netbuf"
)

// ErrPortsExhausted is returned when every pair in the range is in use. It is distinct because it
// is a capacity signal, not a fault: callers turn it into a routable refusal.
var ErrPortsExhausted = errors.New("rtp: every port pair in the configured range is in use")

// PortPair is a bound RTP socket and its RTCP companion, allocated and released as a unit.
//
// RFC 3550 §11: RTP on an even port, RTCP on the odd port above it. The RTCP port is bound even
// when unused, so no unrelated process can take it and break the pairing.
type PortPair struct {
	// Port is the even RTP port. RTCP is Port+1.
	Port int
	// RTP and RTCP are the bound sockets.
	RTP  *net.UDPConn
	RTCP *net.UDPConn

	closeOnce sync.Once
	release   func()
}

// Close shuts both sockets and returns the pair to its allocator. Idempotent: a double release
// (idle reaper plus explicit close) must not hand the same port to two callers.
func (p *PortPair) Close() error {
	var err error
	p.closeOnce.Do(func() {
		err = errors.Join(p.RTP.Close(), p.RTCP.Close())
		if p.release != nil {
			p.release()
		}
	})
	return err
}

// Allocator hands out RTP/RTCP port pairs from a fixed range on a fixed bind address.
//
// It binds rather than merely bookkeeping: another process may hold a port inside the range, and a
// counting-only allocator would hand out an unbindable port as a call with no audio.
type Allocator struct {
	// SocketBufferBytes is the SO_RCVBUF/SO_SNDBUF every allocated socket asks for. Zero leaves the
	// kernel default. Set it before the first Allocate; it is read without synchronisation.
	// The default buffer holds only a few hundred G.711 frames, so a descheduled read loop loses
	// the overflow silently inside the kernel.
	SocketBufferBytes int

	bindIP netip.Addr
	low    int
	high   int

	mu    sync.Mutex
	inUse map[int]struct{}
	// cursor is the round-robin position, NOT a lowest-free scan. See Allocate.
	cursor int
}

// NewAllocator builds an allocator over [low, high]. low must be even and the range must hold at
// least one pair, so a bad range fails at boot rather than per call.
func NewAllocator(bindIP netip.Addr, low, high int) (*Allocator, error) {
	switch {
	case low%2 != 0:
		return nil, fmt.Errorf("rtp: the port range must start on an even port, got %d", low)
	case low > high:
		return nil, fmt.Errorf("rtp: the port range %d-%d is empty", low, high)
	case (high-low+1)/2 == 0:
		return nil, fmt.Errorf("rtp: the port range %d-%d holds no RTP/RTCP pair", low, high)
	case !bindIP.IsValid():
		return nil, errors.New("rtp: a bind address is required")
	}
	return &Allocator{
		bindIP: bindIP,
		low:    low,
		high:   high,
		inUse:  make(map[int]struct{}),
		cursor: low,
	}, nil
}

// Capacity is how many pairs the range holds.
func (a *Allocator) Capacity() int { return (a.high - a.low + 1) / 2 }

// InUse is how many pairs are currently allocated.
func (a *Allocator) InUse() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.inUse)
}

// Allocate binds and returns the next free pair, or ErrPortsExhausted if a full pass finds none.
//
// Round-robin, not lowest-free: a just-ended call's far end keeps sending for a few hundred
// milliseconds, and immediate reuse would deliver those packets onto a live session's socket.
// Cycling the whole range makes the reuse interval the range length in calls rather than zero.
//
// The bind happens outside the mutex — only the reservation needs it — so a near-full range does
// not serialise every other call setup behind up to Capacity()x2 failing syscalls. The port is
// marked in-use before the bind and unmarked on failure, so a lost bind skips rather than leaks.
func (a *Allocator) Allocate() (*PortPair, error) {
	capacity := a.Capacity()
	for range capacity {
		a.mu.Lock()
		if len(a.inUse) == a.Capacity() {
			err := fmt.Errorf("%w: %d/%d pairs allocated from %d-%d",
				ErrPortsExhausted, len(a.inUse), a.Capacity(), a.low, a.high)
			a.mu.Unlock()
			return nil, err
		}
		port := a.cursor
		a.advanceLocked()
		_, taken := a.inUse[port]
		if !taken {
			a.inUse[port] = struct{}{}
		}
		a.mu.Unlock()
		if taken {
			continue
		}

		rtpConn, rtcpConn, err := a.bindPair(port)
		if err != nil {
			// Someone outside this process holds the port; skip it.
			a.mu.Lock()
			delete(a.inUse, port)
			a.mu.Unlock()
			continue
		}

		return &PortPair{
			Port: port,
			RTP:  rtpConn,
			RTCP: rtcpConn,
			release: func() {
				a.mu.Lock()
				defer a.mu.Unlock()
				delete(a.inUse, port)
			},
		}, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return nil, fmt.Errorf("%w: %d/%d pairs allocated from %d-%d",
		ErrPortsExhausted, len(a.inUse), a.Capacity(), a.low, a.high)
}

// advanceLocked steps the cursor to the next even port, wrapping at the top of the range.
func (a *Allocator) advanceLocked() {
	a.cursor += 2
	if a.cursor+1 > a.high {
		a.cursor = a.low
	}
}

// bindPair binds both sockets, closing the first if the second fails so a half-bound pair never
// leaks a descriptor.
func (a *Allocator) bindPair(port int) (*net.UDPConn, *net.UDPConn, error) {
	rtpConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: a.bindIP.AsSlice(), Port: port})
	if err != nil {
		return nil, nil, err
	}
	rtcpConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: a.bindIP.AsSlice(), Port: port + 1})
	if err != nil {
		_ = rtpConn.Close()
		return nil, nil, err
	}
	if a.SocketBufferBytes > 0 {
		// A refusal is not fatal: the socket still works at the kernel default.
		_, _ = netbuf.Tune(rtpConn, a.SocketBufferBytes, a.SocketBufferBytes)
		_, _ = netbuf.Tune(rtcpConn, a.SocketBufferBytes, a.SocketBufferBytes)
	}
	return rtpConn, rtcpConn, nil
}
