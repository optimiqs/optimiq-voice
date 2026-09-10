package profile

import (
	"bytes"
	"fmt"
	"net"
	"strings"
	"sync"

	"github.com/emiago/sipgo/sip"
)

// DefaultArrivalCapacity is how many peers an Arrivals table remembers per generation. Two
// generations are live, so the table holds between one and two times this before the older half is
// dropped whole.
const DefaultArrivalCapacity = 4096

// arrivalHeaderName carries the listener a datagram arrived on from the read filter to the handler.
// It is stamped on the way in and any copy the sender wrote is removed first, so a message reaching
// a handler carries exactly one and it is ours.
const arrivalHeaderName = "X-Optimiq-Arrival"

// Arrivals records the LOCAL listener address a peer's traffic arrives on.
//
// It exists because sipgo does not stamp the destination on an inbound message: both the UDP and the
// TCP readers call only SetSource, so `Destination()` is empty for everything this process receives.
// Without the local address `Set.For` cannot tell which socket a request came in on and has to fall
// back to matching the SENDER's address against the trunk ACL — which lets one tenant's ACL entry
// reclassify another network's digest-authenticated phones as digest-free carrier peers on the
// transports both profiles share.
//
// Provenance is per MESSAGE, not per peer. sipgo hands a parsed request to a background goroutine
// (sip/transaction_layer.go), so a second datagram from the same endpoint to another listener can
// reach this table before the first handler reads it. The read filter therefore stamps the listener
// onto the datagram itself, and `Set.For` reads it off the parsed message; this table is the
// fallback for the stream transports, where a chunk is not a message boundary and stamping bytes is
// unsafe — there a connection belongs to exactly one listener for its whole life, so per-peer IS
// per-message.
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

// ReadFilter is the sipgo TransportReadFilter that stamps datagrams and fills the table. It runs on
// the reading goroutine, before the bytes are parsed.
func (a *Arrivals) ReadFilter() sip.TransportReadFilter {
	return func(info sip.TransportReadProps, data []byte) ([]byte, error) {
		a.Observe(info.Transport, info.LocalAddr, info.RemoteAddr)
		return stampArrival(info.Transport, info.LocalAddr, data), nil
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

// isDatagram reports whether one read is one whole message, which is what makes stamping the bytes
// safe. A stream read is an arbitrary slice of a connection and may hold part of a message, several
// messages, or a keepalive.
func isDatagram(transport string) bool {
	switch strings.ToLower(transport) {
	case "udp", "udp4", "udp6":
		return true
	default:
		return false
	}
}

// stampArrival returns the datagram with arrivalHeaderName as its first header, naming the
// transport and listener it arrived on, and with any copy the sender wrote removed.
//
// The body is copied verbatim and no other header is touched, so Content-Length still describes it.
// A datagram whose header block does not end in a CRLF pair is returned unchanged and falls back to
// the table rather than being rewritten on a guess.
func stampArrival(transport string, local net.Addr, data []byte) []byte {
	if local == nil || !isDatagram(transport) {
		return data
	}
	headers, body, split := bytes.Cut(data, []byte("\r\n\r\n"))
	if !split {
		return data
	}
	startLine, rest, ok := bytes.Cut(headers, []byte("\r\n"))
	if !ok {
		return data
	}

	stamped := make([]byte, 0, len(data)+len(arrivalHeaderName)+len(transport)+32)
	stamped = append(stamped, startLine...)
	stamped = append(stamped, "\r\n"...)
	stamped = fmt.Appendf(stamped, "%s: %s/%s\r\n", arrivalHeaderName, strings.ToLower(transport), local.String())

	lines := bytes.Split(rest, []byte("\r\n"))
	for index := 0; index < len(lines); index++ {
		if !isArrivalHeaderLine(lines[index]) {
			stamped = append(stamped, lines[index]...)
			stamped = append(stamped, "\r\n"...)
			continue
		}
		// RFC 3261 §7.3.1 line folding: the header's value continues on every following line that
		// starts with whitespace, so dropping the name alone would leave an orphan value line.
		for index+1 < len(lines) && len(lines[index+1]) > 0 && (lines[index+1][0] == ' ' || lines[index+1][0] == '\t') {
			index++
		}
	}

	stamped = append(stamped, "\r\n"...)
	return append(stamped, body...)
}

func isArrivalHeaderLine(line []byte) bool {
	name, _, ok := bytes.Cut(line, []byte(":"))
	return ok && strings.EqualFold(string(bytes.TrimSpace(name)), arrivalHeaderName)
}

// arrivalStamp reads the listener the read filter stamped on this message.
//
// Only a datagram carries a stamp, so a header on anything else is the sender's own text and is
// ignored: trusting it would let a peer choose the trust boundary applied to it.
func arrivalStamp(req *sip.Request) (string, bool) {
	transport := strings.ToLower(req.Transport())
	if !isDatagram(transport) {
		return "", false
	}
	header := req.GetHeader(arrivalHeaderName)
	if header == nil {
		return "", false
	}
	stamped, local, ok := strings.Cut(header.Value(), "/")
	if !ok || !strings.EqualFold(strings.TrimSpace(stamped), transport) {
		return "", false
	}
	return strings.TrimSpace(local), true
}
