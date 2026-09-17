package rtp_test

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"testing"
	"time"

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

// The idle backstop must not reap a leg that is carrying early media.
//
// A caller listening to a carrier's announcement has RECEIVED nothing — they send nothing until
// they answer — so the "never heard anything" branch of the reaper is the one that judges them, and
// it counted from allocation. On a deployment whose idle window is shorter than the announcement,
// that reaps the caller's session out from under the audio it is relaying.
func TestTheIdleReaperLeavesALegThatIsRelayingEarlyMedia(t *testing.T) {
	const idleAfter = 150 * time.Millisecond

	allocator, err := rtp.NewAllocator(loopback, 56460, 56479)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		IdleAfter:  idleAfter,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})

	a, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "caller", OrgID: testOrg, CallID: testCall, AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		t.Fatalf("allocating the caller: %v", err)
	}
	b, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "carrier", OrgID: testOrg, CallID: testCall, AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		t.Fatalf("allocating the carrier: %v", err)
	}
	// The leg nobody is talking to, allocated at the same instant: the control that proves the
	// backstop is still working while the early-media leg survives it.
	if _, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "abandoned", OrgID: testOrg, CallID: testCall, AudioPayloadType: rtp.PayloadTypePCMU,
	}); err != nil {
		t.Fatalf("allocating the abandoned leg: %v", err)
	}

	callerPhone := newPhone(t, a.RTPPort)
	carrierPhone := newPhone(t, b.RTPPort)

	// Only the carrier latches. The caller is seeded from its own offer and stays silent throughout,
	// which is exactly what a pre-answer leg does.
	carrierPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0xff},
	})
	waitFor(t, "the carrier's leg latched", func() bool {
		session, ok := manager.Get("carrier")
		return ok && session.Remote() != nil
	})
	local := callerPhone.conn.LocalAddr().(*net.UDPAddr)
	addr, _ := netip.AddrFromSlice(local.IP)
	if err := manager.SeedRemote("caller", netip.AddrPortFrom(addr.Unmap(), uint16(local.Port))); err != nil {
		t.Fatalf("SeedRemote: %v", err)
	}
	if err := manager.Bridge("bridge-early", "caller", "carrier"); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	// The announcement, for longer than the idle window.
	deadline := time.Now().Add(3 * idleAfter)
	heard := 0
	for time.Now().Before(deadline) {
		carrierPhone.send(t, pionrtp.Packet{
			Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
			Payload: []byte{0x0a},
		})
		if _, ok := callerPhone.receive(t); ok {
			heard++
		}
		if reaped := manager.ReapIdle(); reaped > 0 {
			// The abandoned leg is expected to go; the caller is not.
			if _, ok := manager.Get("caller"); !ok {
				t.Fatal("the caller's leg was reaped while it was relaying early media")
			}
		}
	}
	if heard == 0 {
		t.Fatal("the caller heard nothing: the relay never carried the announcement")
	}
	if _, ok := manager.Get("caller"); !ok {
		t.Fatal("the caller's leg was reaped while it was relaying early media")
	}

	// And the backstop is still a backstop: the leg nothing was ever sent to is gone.
	manager.ReapIdle()
	if _, ok := manager.Get("abandoned"); ok {
		t.Error("a leg that received nothing and sent nothing survived the idle backstop")
	}
}

// The 200 re-bridges the same pair under the walk's own bridge id, and the relay becomes two-way.
//
// Nothing promotes an early relay: `Manager.Bridge` detaches both sessions from whatever they were
// in first, so the early bridge is replaced rather than left behind pointing at the same peers.
func TestTheEarlyRelayBecomesTwoWayAtTheAnswer(t *testing.T) {
	rig := newBridgeRig(t, 56480, 56499)

	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0xff},
	})
	waitFor(t, "the announcing leg latched", func() bool {
		b, ok := rig.manager.Get(rig.bID)
		return ok && b.Remote() != nil
	})
	seedFrom(t, rig, rig.aID, rig.aPhone)
	if err := rig.manager.Bridge("early-leg-a", rig.aID, rig.bID); err != nil {
		t.Fatalf("bridging for early media: %v", err)
	}
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0x0a},
	})
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the caller heard nothing before the answer")
	}

	// The 200: the walk builds its own bridge over the same two sessions.
	if err := rig.manager.Bridge("bridge-answered", rig.aID, rig.bID); err != nil {
		t.Fatalf("re-bridging at the answer: %v", err)
	}
	if _, ok := rig.manager.Unbridge("early-leg-a"); ok {
		t.Error("the early bridge survived the re-bridge")
	}

	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0x0c},
	})
	got, ok := rig.bPhone.receive(t)
	if !ok {
		t.Fatal("the callee heard nothing after the answer: the relay never became two-way")
	}
	if string(got.Payload) != string([]byte{0x0c}) {
		t.Errorf("payload = %v, want the caller's bytes", got.Payload)
	}
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0x0d},
	})
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the caller stopped hearing the callee after the answer")
	}
}
