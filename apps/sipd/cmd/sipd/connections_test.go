package main

import (
	"errors"
	"net"
	"testing"

	"github.com/emiago/sipgo/sip"
)

// TestAHardClosedConnectionKeepsGoingNegative pins the sipgo behaviour behind the 71 `WS ref went
// negative` warnings in the E2E log, so a library bump that changes it is a failing test rather than
// a silent change under the reachability sweep.
//
// It is sipgo's, not ours. connectionPool.CloseAndDelete releases one reference and then calls
// Connection.Close, and WSConnection.Close ZEROES the count rather than decrementing it — so every
// reference still outstanding when a socket dies (one per in-flight transaction) is released against
// a count that already reached zero, and each of those releases logs and drives the count further
// negative. It is noisy and it is safe: TryClose reports 0 and does not close a second time.
//
// sipd holds no reference of its own and never calls Close, so nothing here is a double release on
// our side. What it does mean is that a torn-down connection can sit in the pool at a NEGATIVE
// count, which is why transportProbe reads the count instead of trusting that a pool hit is a live
// socket.
func TestAHardClosedConnectionKeepsGoingNegative(t *testing.T) {
	client, server := net.Pipe()
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})

	// A server-side WebSocket connection is pooled at 1 + TransportIdleConnection, plus one
	// reference per transaction using it.
	connection := &sip.WSConnection{Conn: server}
	connection.Ref(1 + sip.TransportIdleConnection)
	connection.Ref(1)

	// The read loop ends: one release, then the hard close the pool performs.
	if _, err := connection.TryClose(); err != nil {
		t.Fatalf("TryClose: %v", err)
	}
	if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Close: %v", err)
	}

	// The transaction that was still holding a reference terminates and releases it. The count is
	// already zero, so it goes negative — and stays safe.
	for want := range 3 {
		ref, err := connection.TryClose()
		if err != nil {
			t.Fatalf("TryClose after the hard close: %v", err)
		}
		if ref != 0 {
			t.Fatalf("TryClose reported %d after release %d, want a clamped 0", ref, want+1)
		}
	}
	if count := connection.Ref(0); count >= 0 {
		t.Fatalf("the reference count is %d; sipgo no longer drives it negative after a hard close, "+
			"so transportProbe's reason for reading the count may have changed", count)
	}
}

// fakeConnection is a Connection whose reference count is all the probe looks at.
type fakeConnection struct {
	sip.Connection
	refcount int
}

func (c *fakeConnection) Ref(i int) int {
	c.refcount += i
	return c.refcount
}

// fakeSource hands out one connection per address.
type fakeSource struct {
	connections map[string]*fakeConnection
}

func (s *fakeSource) GetConnection(network, addr string) (sip.Connection, error) {
	connection, found := s.connections[network+"/"+addr]
	if !found {
		return nil, errors.New("connection does not exist")
	}
	connection.Ref(1)
	return connection, nil
}

func TestTheProbeReadsAConnectionRatherThanTrustingAPoolHit(t *testing.T) {
	live := &fakeConnection{refcount: 1 + sip.TransportIdleConnection}
	closed := &fakeConnection{refcount: 0}
	negative := &fakeConnection{refcount: -4}
	probe := &transportProbe{source: &fakeSource{connections: map[string]*fakeConnection{
		"ws/203.0.113.9:51234": live,
		"ws/203.0.113.9:51235": closed,
		"ws/203.0.113.9:51236": negative,
	}}}

	for _, testCase := range []struct {
		name      string
		address   string
		connected bool
	}{
		{"a pooled connection somebody holds", "203.0.113.9:51234", true},
		{"a connection the pool hard-closed", "203.0.113.9:51235", false},
		{"a connection whose count already went negative", "203.0.113.9:51236", false},
		{"an address the pool does not know", "203.0.113.9:51237", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := probe.Connected("ws", testCase.address); got != testCase.connected {
				t.Fatalf("Connected = %v, want %v", got, testCase.connected)
			}
		})
	}

	// Every reference the probe took is given back, and none of the counts moved: a probe that
	// leaked one would pin every socket a device ever had, and one that released twice would be the
	// double release this file exists to rule out.
	if live.refcount != 1+sip.TransportIdleConnection {
		t.Errorf("a live connection is at %d, want %d", live.refcount, 1+sip.TransportIdleConnection)
	}
	if closed.refcount != 0 {
		t.Errorf("a closed connection is at %d, want 0", closed.refcount)
	}
	if negative.refcount != -4 {
		t.Errorf("a negative connection is at %d, want -4", negative.refcount)
	}
}

func TestAProbeWithNoTransportLayerAdmitsEverything(t *testing.T) {
	// Nothing to ask means nothing can be proven gone, and a sweep that removed bindings on that
	// basis would de-register a fleet.
	if !newTransportProbe(nil).Connected("ws", "203.0.113.9:51234") {
		t.Fatal("a probe with no transport layer reported a binding unreachable")
	}
}
