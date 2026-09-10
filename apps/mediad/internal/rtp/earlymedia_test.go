package rtp_test

import (
	"net"
	"net/netip"
	"testing"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// Early media sends to a leg that has not spoken. Symmetric-RTP learning alone cannot serve it —
// the caller stays silent until the 200 — so the negotiated `c=`/`m=` seeds the far end, over real
// sockets, and the announcement reaches the caller anyway.
func TestASeededLegHearsItsPeerBeforeItHasSpoken(t *testing.T) {
	rig := newBridgeRig(t, 56400, 56419)

	// Only the announcing side latches: the caller's leg is seeded from its offer instead.
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0xff},
	})
	waitFor(t, "the announcing leg latched", func() bool {
		b, ok := rig.manager.Get(rig.bID)
		return ok && b.Remote() != nil
	})

	seedFrom(t, rig, rig.aID, rig.aPhone)
	if err := rig.manager.Bridge("bridge-early", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0x0a, 0x0b},
	})
	got, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the caller heard nothing: a seeded far end did not receive the announcement")
	}
	if string(got.Payload) != string([]byte{0x0a, 0x0b}) {
		t.Errorf("payload = %v, want the announcement's bytes", got.Payload)
	}

	// The watchdog still counts the seeded leg as never having received a packet: seeding is an
	// address, not audio, and an early-media leg is not "silent" while the far end plays.
	a, _ := rig.manager.Get(rig.aID)
	if stats := a.Stats(); stats.PacketsReceived != 0 || stats.LastPacketUnixMs != 0 {
		t.Errorf("stats = %+v, want a leg that has received nothing", stats)
	}
}

// The seed is advisory. Behind NAT the advertised address is private and unreachable, so the first
// packet that actually arrives must latch over the seed rather than be refused by it.
func TestSymmetricRTPLatchingOverridesASeededAddress(t *testing.T) {
	rig := newBridgeRig(t, 56420, 56439)

	// A private address no packet can come from — exactly what a phone behind NAT advertises.
	if err := rig.manager.SeedRemote(rig.aID, netip.MustParseAddrPort("10.255.255.1:40000")); err != nil {
		t.Fatalf("SeedRemote: %v", err)
	}
	rig.latch(t)

	a, _ := rig.manager.Get(rig.aID)
	remote := a.Remote()
	if remote == nil || remote.String() == "10.255.255.1:40000" {
		t.Fatalf("Remote() = %v, want the address the packet actually came from", remote)
	}
	if remote.String() != rig.aPhone.conn.LocalAddr().String() {
		t.Errorf("Remote() = %v, want %v", remote, rig.aPhone.conn.LocalAddr())
	}

	// And it latches for good: a second seed after learning is ignored.
	if err := rig.manager.SeedRemote(rig.aID, netip.MustParseAddrPort("10.255.255.2:40000")); err != nil {
		t.Fatalf("SeedRemote: %v", err)
	}
	if again := a.Remote(); again.String() != remote.String() {
		t.Errorf("Remote() = %v after a second seed, want the latched %v", again, remote)
	}
}

// An unknown session is refused rather than silently ignored, so a handler seeding a released leg
// gets the same ErrUnknownSession every other session operation returns.
func TestSeedRemoteRefusesAnUnknownSession(t *testing.T) {
	rig := newBridgeRig(t, 56440, 56459)

	if err := rig.manager.SeedRemote("no-such-leg", netip.MustParseAddrPort("192.0.2.1:5004")); err == nil {
		t.Fatal("seeding an unknown session succeeded")
	}
}

// seedFrom seeds a session with the address a phone is really listening on, standing in for the
// `c=`/`m=` its SDP advertised.
func seedFrom(t *testing.T, rig *bridgeRig, sessionID string, p *phone) {
	t.Helper()
	local := p.conn.LocalAddr().(*net.UDPAddr)
	addr, ok := netip.AddrFromSlice(local.IP)
	if !ok {
		t.Fatalf("the far end's address is not an IP: %v", local)
	}
	if err := rig.manager.SeedRemote(sessionID, netip.AddrPortFrom(addr.Unmap(), uint16(local.Port))); err != nil {
		t.Fatalf("SeedRemote: %v", err)
	}
}
