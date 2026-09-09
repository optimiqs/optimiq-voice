package netbuf_test

import (
	"net"
	"testing"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/netbuf"
)

func TestTuneGrantsAtLeastTheDefault(t *testing.T) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("ListenUDP: %v", err)
	}
	defer conn.Close()

	sizes, err := netbuf.Tune(conn, 1<<19, 1<<19)
	if err != nil {
		t.Fatalf("Tune: %v", err)
	}
	if sizes.Receive <= 0 || sizes.Send <= 0 {
		t.Fatalf("the kernel reported no buffer sizes: %+v", sizes)
	}
}

func TestTuneRefusesANilConnection(t *testing.T) {
	if _, err := netbuf.Tune(nil, 1, 1); err == nil {
		t.Error("Tune accepted a nil connection")
	}
}

func TestTuneLeavesADirectionAloneWhenNotAsked(t *testing.T) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("ListenUDP: %v", err)
	}
	defer conn.Close()

	if _, err := netbuf.Tune(conn, 0, 0); err != nil {
		t.Fatalf("Tune: %v", err)
	}
}
