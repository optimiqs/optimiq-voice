package profile

import (
	"net"
	"strings"
	"sync"

	"github.com/emiago/sipgo/sip"
)

// DefaultArrivalCapacity is how many peers an Arrivals table remembers per generation. Two
// generations are live, so the table holds between one and two times this before the older half is
// dropped whole.
const DefaultArrivalCapacity = 4096

// Arrivals records, per peer, the LOCAL listener address that peer's most recent message arrived on.
//
// It exists because sipgo does not stamp the destination on an inbound message: both the UDP and the
// TCP readers call only SetSource, so `Destination()` is empty for everything this process receives.
// Without the local address `Set.For` cannot tell which socket a request came in on and has to fall
// back to matching the SENDER's address against the trunk ACL — which lets one tenant's ACL entry
// reclassify another network's digest-authenticated phones as digest-free carrier peers on the
// transports both profiles share.
//
// The table is filled from sipgo's TransportReadFilter, which runs on the reading goroutine
// immediately before the bytes are parsed and the message is handed to the handler. The entry a
// handler reads back is therefore the one written for the message it is holding.
//
// Safe for concurrent use, and bounded: entries live in two generations and the older one is dropped
// whole once the newer fills, so a churn of one-shot peers cannot grow it without limit.
type Arrivals struct {
	capacity int

	mu       sync.RWMutex
	current  map[string]string
	previous map[string]string
}

// NewArrivals builds an empty table. A capacity of zero or less takes DefaultArrivalCapacity.
func NewArrivals(capacity int) *Arrivals {
	if capacity <= 0 {
		capacity = DefaultArrivalCapacity
	}
	return &Arrivals{capacity: capacity, current: make(map[string]string, capacity)}
}

// ReadFilter is the sipgo TransportReadFilter that fills the table. It never inspects or rewrites
// the bytes; it returns them untouched.
func (a *Arrivals) ReadFilter() sip.TransportReadFilter {
	return func(info sip.TransportReadProps, data []byte) ([]byte, error) {
		a.Observe(info.Transport, info.LocalAddr, info.RemoteAddr)
		return data, nil
	}
}

// Observe records that a message from remote arrived on local over transport.
func (a *Arrivals) Observe(transport string, local, remote net.Addr) {
	if a == nil || local == nil || remote == nil {
		return
	}
	key := arrivalKey(transport, remote.String())

	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.current) >= a.capacity {
		a.previous, a.current = a.current, make(map[string]string, a.capacity)
	}
	a.current[key] = local.String()
}

// LocalFor returns the listener address the peer's most recent message arrived on.
func (a *Arrivals) LocalFor(transport, remote string) (string, bool) {
	if a == nil {
		return "", false
	}
	key := arrivalKey(transport, remote)

	a.mu.RLock()
	defer a.mu.RUnlock()
	if local, found := a.current[key]; found {
		return local, true
	}
	local, found := a.previous[key]
	return local, found
}

func arrivalKey(transport, remote string) string {
	return strings.ToLower(transport) + "/" + strings.ToLower(remote)
}
