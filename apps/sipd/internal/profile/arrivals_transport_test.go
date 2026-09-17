package profile

import (
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// The point of the arrivals stamp, proved through a real socket rather than a stub: two profiles on
// two UDP listeners, one source address the trunk ACL allows on both, and the profile chosen by the
// listener the datagram landed on — even when the first handler is still running while the second
// datagram is read, which is the R07 interleaving.
//
// The test owns the sockets and hands them to sipgo with ServeUDP rather than calling
// ListenAndServe. That is not only for readiness: sipgo 1.4.3's ListenAndServe races its own
// context-cancellation goroutine against the `connCloser` variable and the listening connection
// (server.go:102 reads what server.go:123-128 writes), so a -race run of a test that used it failed
// on the dependency rather than on anything here. Binding first makes the socket ready before any
// goroutine starts and keeps the close on this test's own cleanup path.
func TestArrivalsSelectTheProfileThroughARealSocket(t *testing.T) {
	internal := listenUDP(t)
	external := listenUDP(t)
	internalAddr := internal.LocalAddr().String()
	externalAddr := external.LocalAddr().String()

	acl := NewACL([]Entry{mustEntry(t, "127.0.0.1/32", ActionAllow, 0, "trunk-loopback")})
	set, err := NewSet(
		Internal("internal", Listener{Network: "udp", Addr: internalAddr}),
		External("external", acl, Listener{Network: "udp", Addr: externalAddr}),
	)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	userAgent, err := sipgo.NewUA(
		sipgo.WithUserAgentTransportLayerOptions(sip.WithTransportLayerReadFilter(arrivals.ReadFilter())),
	)
	if err != nil {
		t.Fatalf("NewUA: %v", err)
	}
	t.Cleanup(func() { _ = userAgent.Close() })

	server, err := sipgo.NewServer(userAgent)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })

	// The handler for the first datagram blocks until the second has been read, parsed and recorded.
	// A per-peer table answers the first handler with the second datagram's listener.
	held := make(chan struct{})
	chosen := make(chan string, 2)
	server.OnOptions(func(req *sip.Request, tx sip.ServerTransaction) {
		callID := req.CallID().Value()
		if callID == "probe-first" {
			<-held
		}
		owner, err := set.For(req)
		name := owner.Name
		if err != nil {
			name = "error: " + err.Error()
		}
		chosen <- callID + "=" + name
		_ = tx.Respond(sip.NewResponseFromRequest(req, sip.StatusOK, "OK", nil))
	})

	serving := make(chan error, 2)
	for _, conn := range []*net.UDPConn{internal, external} {
		go func() { serving <- server.ServeUDP(conn) }()
	}

	// ONE source socket, both listeners: the peer key is identical for the two datagrams.
	source := listenUDP(t)
	send(t, source, internalAddr, "first")
	send(t, source, externalAddr, "second")

	results := make(map[string]string, 2)
	for range 2 {
		select {
		case answer := <-chosen:
			callID, name, _ := strings.Cut(answer, "=")
			results[callID] = name
			if len(results) == 1 {
				close(held)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("only %d of 2 OPTIONS reached the handler", len(results))
		}
	}
	if results["probe-first"] != "internal" {
		t.Errorf("the datagram on the internal listener chose %q, want the internal profile", results["probe-first"])
	}
	if results["probe-second"] != "external" {
		t.Errorf("the datagram on the external listener chose %q, want the external profile", results["probe-second"])
	}

	// Closing the sockets is the only reason ServeUDP may return; anything else is a real failure.
	internal.Close()
	external.Close()
	for range 2 {
		select {
		case err := <-serving:
			if err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("ServeUDP: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("ServeUDP did not return after its socket was closed")
		}
	}
}

// listenUDP binds a loopback socket on a kernel-chosen port. The socket is the readiness signal:
// nothing has to poll for a bind that another process may have taken in the meantime.
func listenUDP(t *testing.T) *net.UDPConn {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("binding a loopback UDP socket: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func send(t *testing.T, conn *net.UDPConn, target, tag string) {
	t.Helper()
	remote, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		t.Fatalf("resolving %s: %v", target, err)
	}
	local := conn.LocalAddr().String()
	message := "OPTIONS sip:probe@127.0.0.1 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP " + local + ";branch=z9hG4bK" + t.Name() + tag + "\r\n" +
		"From: <sip:probe@127.0.0.1>;tag=probe\r\n" +
		"To: <sip:probe@127.0.0.1>\r\n" +
		"Call-ID: probe-" + tag + "\r\n" +
		"CSeq: 1 OPTIONS\r\n" +
		"Max-Forwards: 70\r\n" +
		"Content-Length: 0\r\n\r\n"
	if _, err := conn.WriteTo([]byte(message), remote); err != nil {
		t.Fatalf("writing to %s: %v", target, err)
	}
}
