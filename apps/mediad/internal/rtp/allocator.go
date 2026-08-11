package rtp

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
)

// ErrPortsExhausted is returned when every pair in the range is in use.
//
// It is a distinct error because it is the one allocation failure that is a CAPACITY signal rather
// than a fault: the control handler turns it into a refusal the engine can route around (try
// another mediad, or fail the call with "congestion"), which is a different answer from "this
// media server is broken".
var ErrPortsExhausted = errors.New("rtp: every port pair in the configured range is in use")

// PortPair is a bound RTP socket and its RTCP companion, held together because they are allocated,
// released and leaked as a unit.
//
// RFC 3550 §11: RTP on an even port, RTCP on the odd port above it. mediad does not speak RTCP yet
// (v0 receives and discards), but the port is bound anyway rather than left free — an unbound RTCP
// port is one an unrelated process can take, and the day RTCP is implemented the pairing would be
// broken on exactly the hosts that had been running longest.
type PortPair struct {
	// Port is the even RTP port. RTCP is Port+1.
	Port int
	// RTP and RTCP are the bound sockets. RTCP is bound but not read from in v0.
	RTP  *net.UDPConn
	RTCP *net.UDPConn

	closeOnce sync.Once
	release   func()
}

// Close shuts both sockets and returns the pair to its allocator. It is idempotent: a session that
// is closed by its own idle reaper and then again by an explicit release must not hand the same
// port to two callers, and "released twice" is the normal shape of that race rather than a bug.
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
// It binds rather than merely bookkeeping. A range is a promise about what mediad may use, not
// about what is free: a host running Asterisk during the cutover, a stray process, or a previous
// mediad whose sockets are still in TIME_WAIT can all hold a port inside the range. An allocator
// that only counted would hand out a port that cannot be bound, and the failure would surface one
// layer up as a call that never gets audio. Binding at allocation time turns that into a skip.
type Allocator struct {
	bindIP netip.Addr
	low    int
	high   int

	mu    sync.Mutex
	inUse map[int]struct{}
	// cursor is the round-robin position, NOT a lowest-free scan. See Allocate.
	cursor int
}

// NewAllocator builds an allocator over [low, high]. low must be even and the range must hold at
// least one pair; config.Load already enforces both, and this repeats the check because an
// allocator constructed with a bad range would fail per-call instead of at boot.
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

// Allocate binds and returns the next free pair.
//
// # Why round-robin and not lowest-free
//
// Lowest-free is the obvious allocator and the wrong one for RTP. A call that has just ended
// leaves the far end still sending for a few hundred milliseconds — retransmits, a last few frames
// queued behind a jitter buffer, or an endpoint that simply has not processed the BYE yet. Handing
// the port it just freed to the very next call means those packets arrive on a live session's
// socket, and the symptom is a fragment of a stranger's audio. Cycling the whole range first makes
// the reuse interval the range's own length in calls rather than zero, which on the default
// 500-pair range is minutes of traffic rather than microseconds.
//
// Sessions also latch to one source address (see Session), so a stray packet is dropped rather
// than mixed; the cursor makes it not arrive in the first place. Two independent defences, because
// this is the failure mode that is impossible to reproduce from a bug report.
//
// A port that cannot be bound — held by Asterisk during the cutover, or by anything else on the
// host — is skipped, not fatal. Only a full pass over the range with nothing bindable is
// ErrPortsExhausted.
func (a *Allocator) Allocate() (*PortPair, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	for attempt := 0; attempt < a.Capacity(); attempt++ {
		port := a.cursor
		a.advanceLocked()

		if _, taken := a.inUse[port]; taken {
			continue
		}

		rtpConn, rtcpConn, err := a.bindPair(port)
		if err != nil {
			// Someone outside this process holds the port. Skipping is the whole reason Allocate
			// binds rather than counts.
			continue
		}

		a.inUse[port] = struct{}{}
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
	return nil, fmt.Errorf("%w: %d/%d pairs allocated from %d-%d",
		ErrPortsExhausted, len(a.inUse), a.Capacity(), a.low, a.high)
}

// advanceLocked steps the cursor to the next even port, wrapping at the top of the range.
func (a *Allocator) advanceLocked() {
	a.cursor += 2
	// The last usable RTP port is the highest even port whose odd companion is still in range.
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
	return rtpConn, rtcpConn, nil
}
