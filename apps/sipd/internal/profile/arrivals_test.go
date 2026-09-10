package profile

import (
	"net"
	"testing"

	"github.com/emiago/sipgo/sip"
)

func addr(value string) net.Addr {
	resolved, err := net.ResolveUDPAddr("udp", value)
	if err != nil {
		panic(err)
	}
	return resolved
}

func TestArrivalsRecordsTheListenerAPeerArrivedOn(t *testing.T) {
	arrivals := NewArrivals(0)
	if arrivals.capacity != DefaultArrivalCapacity {
		t.Fatalf("capacity = %d, want the default", arrivals.capacity)
	}

	arrivals.Observe("UDP", addr("127.0.0.1:5160"), addr("127.0.0.1:40000"))
	local, found := arrivals.LocalFor("udp", "127.0.0.1:40000")
	if !found || local != "127.0.0.1:5160" {
		t.Fatalf("LocalFor = %q / %v, want the listener", local, found)
	}
	if _, found := arrivals.LocalFor("tcp", "127.0.0.1:40000"); found {
		t.Error("the transport is part of the key")
	}
	if _, found := arrivals.LocalFor("udp", "127.0.0.1:40001"); found {
		t.Error("an unseen peer has no listener")
	}
}

func TestArrivalsIsBounded(t *testing.T) {
	arrivals := NewArrivals(4)
	for port := 40000; port < 40100; port++ {
		arrivals.Observe("udp", addr("127.0.0.1:5160"), addr(net.JoinHostPort("127.0.0.1", itoa(port))))
	}
	if held := len(arrivals.current) + len(arrivals.previous); held > 2*arrivals.capacity {
		t.Fatalf("held %d entries, want at most two generations of %d", held, arrivals.capacity)
	}
	// The most recent peer survives: the generation it is in is the one being filled.
	if _, found := arrivals.LocalFor("udp", "127.0.0.1:40099"); !found {
		t.Error("the newest arrival must still be there")
	}
}

func TestArrivalsReadFilterPassesTheBytesThrough(t *testing.T) {
	arrivals := NewArrivals(4)
	filter := arrivals.ReadFilter()

	payload := []byte("OPTIONS sip:x SIP/2.0\r\n\r\n")
	out, err := filter(sip.TransportReadProps{
		Transport:  "udp",
		LocalAddr:  addr("127.0.0.1:5160"),
		RemoteAddr: addr("127.0.0.1:40000"),
	}, payload)
	if err != nil {
		t.Fatalf("the filter must never fail a read: %v", err)
	}
	if string(out) != string(payload) {
		t.Error("the filter must not rewrite the bytes")
	}
	if local, _ := arrivals.LocalFor("udp", "127.0.0.1:40000"); local != "127.0.0.1:5160" {
		t.Errorf("local = %q, want the listener the read came from", local)
	}
}

func TestNilArrivalsAreInert(t *testing.T) {
	var arrivals *Arrivals
	arrivals.Observe("udp", addr("127.0.0.1:5160"), addr("127.0.0.1:40000"))
	if _, found := arrivals.LocalFor("udp", "127.0.0.1:40000"); found {
		t.Error("a nil table knows nothing")
	}
}

func itoa(value int) string {
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
