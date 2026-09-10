package profile

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// The whole point of the arrivals table, proved through a real socket rather than a stub: two
// profiles on two UDP listeners, one source address that the trunk ACL allows, and the profile
// chosen by the listener the datagram landed on.
//
// Before the read filter this could not work — sipgo sets only the source on an inbound message —
// and the ACL claimed the internal listener's traffic too, which is a digest-free carrier context
// for an office's phones.
func TestArrivalsSelectTheProfileThroughARealSocket(t *testing.T) {
	internalPort, externalPort := freeUDPPort(t), freeUDPPort(t)
	internalAddr := fmt.Sprintf("127.0.0.1:%d", internalPort)
	externalAddr := fmt.Sprintf("127.0.0.1:%d", externalPort)

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

	chosen := make(chan string, 2)
	server.OnOptions(func(req *sip.Request, tx sip.ServerTransaction) {
		owner, err := set.For(req)
		if err != nil {
			chosen <- "error: " + err.Error()
		} else {
			chosen <- owner.Name
		}
		_ = tx.Respond(sip.NewResponseFromRequest(req, sip.StatusOK, "OK", nil))
	})

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	for _, addr := range []string{internalAddr, externalAddr} {
		go func() { _ = server.ListenAndServe(ctx, "udp", addr) }()
	}
	waitForUDP(t, internalAddr)
	waitForUDP(t, externalAddr)

	// One source, two listeners. The ACL allows the source on both.
	if got := probe(t, internalAddr, chosen); got != "internal" {
		t.Errorf("a datagram on the internal listener chose %q, want the internal profile", got)
	}
	if got := probe(t, externalAddr, chosen); got != "external" {
		t.Errorf("a datagram on the external listener chose %q, want the external profile", got)
	}
}

func probe(t *testing.T, target string, chosen <-chan string) string {
	t.Helper()
	conn, err := net.Dial("udp", target)
	if err != nil {
		t.Fatalf("dialling %s: %v", target, err)
	}
	defer conn.Close()

	local := conn.LocalAddr().String()
	message := "OPTIONS sip:probe@127.0.0.1 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP " + local + ";branch=z9hG4bK" + t.Name() + target + "\r\n" +
		"From: <sip:probe@127.0.0.1>;tag=probe\r\n" +
		"To: <sip:probe@127.0.0.1>\r\n" +
		"Call-ID: probe-" + target + "\r\n" +
		"CSeq: 1 OPTIONS\r\n" +
		"Max-Forwards: 70\r\n" +
		"Content-Length: 0\r\n\r\n"
	if _, err := conn.Write([]byte(message)); err != nil {
		t.Fatalf("writing to %s: %v", target, err)
	}

	select {
	case name := <-chosen:
		return name
	case <-time.After(5 * time.Second):
		t.Fatalf("no OPTIONS reached the handler on %s", target)
		return ""
	}
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("reserving a port: %v", err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

func waitForUDP(t *testing.T, addr string) {
	t.Helper()
	for range 100 {
		conn, err := net.ListenPacket("udp", addr)
		if err != nil {
			return // the server has the socket
		}
		_ = conn.Close()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the server never bound %s", addr)
}
