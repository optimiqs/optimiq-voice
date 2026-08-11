package rtp_test

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// readTimeout bounds every socket read in this suite. Generous, because it only ever elapses on a
// genuine failure — on loopback a packet takes microseconds.
const readTimeout = 2 * time.Second

// newRunningSession allocates a pair, starts a session over it, and tears both down at test end.
func newRunningSession(t *testing.T, mode rtp.Mode) *rtp.Session {
	t.Helper()

	// A per-test range keeps parallel packages from fighting over ports; the allocator skips what
	// it cannot bind, so an overlap costs a retry rather than a failure.
	allocator, err := rtp.NewAllocator(loopback, 53000, 53099)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	session, err := rtp.NewSession(rtp.Options{
		ID:    "session-under-test",
		Ports: pair,
		Mode:  mode,
		// PCMU plus the de-facto RFC 4733 type: what a real answer to a real phone settles on, and
		// what the packets these tests send are stamped with.
		AudioPayloadType:          rtp.PayloadTypePCMU,
		TelephoneEventPayloadType: rtp.PayloadTypeTelephoneEvent,
	})
	if err != nil {
		_ = pair.Close()
		t.Fatalf("NewSession: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- session.Run(ctx) }()

	t.Cleanup(func() {
		cancel()
		_ = session.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run returned %v; a cancelled or closed session must return nil", err)
			}
		case <-time.After(readTimeout):
			t.Error("Run did not return after the session was closed")
		}
	})
	return session
}

// newFarEnd is a UDP socket standing in for a phone: it sends to the session and reads what comes
// back.
func newFarEnd(t *testing.T, session *rtp.Session) *net.UDPConn {
	t.Helper()
	conn, err := net.DialUDP("udp",
		&net.UDPAddr{IP: loopback.AsSlice(), Port: 0},
		&net.UDPAddr{IP: loopback.AsSlice(), Port: session.LocalPort()})
	if err != nil {
		t.Fatalf("dialling the session: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// g711Packet builds a PCMU frame: 160 bytes is exactly 20 ms at 8 kHz, the frame size every SIP
// endpoint sends by default.
func g711Packet(seq uint16, timestamp uint32, ssrc uint32) []byte {
	payload := make([]byte, 160)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	return packetWithPayload(rtp.PayloadTypePCMU, seq, timestamp, ssrc, payload)
}

func packetWithPayload(pt uint8, seq uint16, timestamp, ssrc uint32, payload []byte) []byte {
	packet := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    pt,
			SequenceNumber: seq,
			Timestamp:      timestamp,
			SSRC:           ssrc,
		},
		Payload: payload,
	}
	encoded, err := packet.Marshal()
	if err != nil {
		panic(err)
	}
	return encoded
}

func readPacket(t *testing.T, conn *net.UDPConn) (*pionrtp.Packet, bool) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, false
	}
	var packet pionrtp.Packet
	if err := packet.Unmarshal(buf[:n]); err != nil {
		t.Fatalf("the session sent something that is not RTP: %v", err)
	}
	return &packet, true
}

// expectNoPacket asserts nothing comes back, with a SHORT deadline.
//
// Short is correct here rather than merely fast: every caller first waits on the counter that
// proves the packet was processed, so an echo — if the session were going to send one — has
// already been written by the time this runs. Reusing readTimeout would add two seconds per
// negative assertion to prove something that is already decided.
func expectNoPacket(t *testing.T, conn *net.UDPConn, why string) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 1500)
	if _, err := conn.Read(buf); err == nil {
		t.Error(why)
	}
}

// waitFor polls until a condition holds, so an assertion about an asynchronously-updated counter
// does not race the read loop.
func waitFor(t *testing.T, what string, probe func() bool) {
	t.Helper()
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		if probe() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// The core proof of the packet path: RTP goes in, RTP comes back.
func TestSessionEchoesG711(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)
	farEnd := newFarEnd(t, session)

	const (
		seq       = uint16(1000)
		timestamp = uint32(160000)
		farSSRC   = uint32(0x11223344)
	)
	sent := g711Packet(seq, timestamp, farSSRC)
	if _, err := farEnd.Write(sent); err != nil {
		t.Fatalf("sending RTP: %v", err)
	}

	echoed, ok := readPacket(t, farEnd)
	if !ok {
		t.Fatal("no packet came back; the echo path is broken")
	}

	// The payload is passed through byte for byte — v1 is G.711 passthrough with no transcoding.
	original := sent[12:]
	if string(echoed.Payload) != string(original) {
		t.Errorf("the echoed payload differs from the one sent (%d vs %d bytes)",
			len(echoed.Payload), len(original))
	}
	if echoed.PayloadType != rtp.PayloadTypePCMU {
		t.Errorf("echoed payload type = %d, want %d", echoed.PayloadType, rtp.PayloadTypePCMU)
	}
	// Our own SSRC, not the sender's: a stream carrying the far end's own SSRC back to it is what
	// endpoint loop detection discards.
	if echoed.SSRC == farSSRC {
		t.Error("the echo reused the sender's SSRC; endpoints discard that as their own loop")
	}
	if echoed.SSRC != session.SSRC {
		t.Errorf("echoed SSRC = %#x, want the session's %#x", echoed.SSRC, session.SSRC)
	}
	// Our own sequence space, for the same reason.
	if echoed.SequenceNumber == seq {
		t.Error("the echo reused the sender's sequence number; two streams must not share one " +
			"sequence space or a jitter buffer cannot untangle them")
	}
	// The timestamp is the frame's sampling instant and genuinely is the one it arrived with.
	if echoed.Timestamp != timestamp {
		t.Errorf("echoed timestamp = %d, want the original %d", echoed.Timestamp, timestamp)
	}

	stats := session.Stats()
	if stats.PacketsReceived != 1 || stats.PacketsSent != 1 {
		t.Errorf("stats = %+v, want 1 received and 1 sent", stats)
	}
	if stats.BytesReceived != uint64(len(sent)) {
		t.Errorf("BytesReceived = %d, want %d", stats.BytesReceived, len(sent))
	}
}

// Sequence numbers must advance monotonically across a stream, not repeat the sender's.
func TestSessionUsesItsOwnMonotonicSequenceNumbers(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)
	farEnd := newFarEnd(t, session)

	var previous uint16
	for i := 0; i < 5; i++ {
		// The far end's own numbers deliberately jump around; ours must not follow.
		if _, err := farEnd.Write(g711Packet(uint16(9000-i*7), uint32(i*160), 0x55667788)); err != nil {
			t.Fatalf("sending RTP #%d: %v", i, err)
		}
		echoed, ok := readPacket(t, farEnd)
		if !ok {
			t.Fatalf("no echo for packet #%d", i)
		}
		if i > 0 && echoed.SequenceNumber != previous+1 {
			t.Errorf("sequence went %d -> %d, want a step of one", previous, echoed.SequenceNumber)
		}
		previous = echoed.SequenceNumber
	}
}

// RFC 4733 DTMF must survive with its marker bit, which is the start-of-digit flag: dropping it
// makes every keypress undetectable.
func TestSessionEchoesTelephoneEventsWithTheMarkerBit(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)
	farEnd := newFarEnd(t, session)

	packet := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    rtp.PayloadTypeTelephoneEvent,
			SequenceNumber: 40,
			Timestamp:      3200,
			SSRC:           0x99aabbcc,
			Marker:         true,
		},
		// RFC 4733 §2.3: event 1 ("1"), end=false, volume 10, duration 160.
		Payload: []byte{0x01, 0x0a, 0x00, 0xa0},
	}
	encoded, err := packet.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if _, err := farEnd.Write(encoded); err != nil {
		t.Fatalf("sending DTMF: %v", err)
	}

	echoed, ok := readPacket(t, farEnd)
	if !ok {
		t.Fatal("the telephone-event packet was not echoed")
	}
	if echoed.PayloadType != rtp.PayloadTypeTelephoneEvent {
		t.Errorf("payload type = %d, want %d", echoed.PayloadType, rtp.PayloadTypeTelephoneEvent)
	}
	if !echoed.Marker {
		t.Error("the marker bit was dropped; it is RFC 4733's start-of-digit flag")
	}
}

// v1 is G.711 passthrough. A payload type SDP should never have negotiated is counted and dropped,
// not reflected.
func TestSessionDropsUnsupportedPayloadTypes(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)
	farEnd := newFarEnd(t, session)

	// PT 9 is G.722 — a real codec, and one v1 deliberately does not handle.
	if _, err := farEnd.Write(packetWithPayload(9, 1, 160, 0xdeadbeef, make([]byte, 160))); err != nil {
		t.Fatalf("sending: %v", err)
	}

	waitFor(t, "the unsupported payload type to be counted", func() bool {
		return session.Stats().UnsupportedPT == 1
	})
	expectNoPacket(t, farEnd, "an unsupported payload type was echoed; it must be dropped")
	// It still counts as received: it arrived, it was parsed, and the session is not idle.
	if got := session.Stats().PacketsReceived; got != 1 {
		t.Errorf("PacketsReceived = %d, want 1", got)
	}
	if got := session.Stats().PacketsSent; got != 0 {
		t.Errorf("PacketsSent = %d, want 0", got)
	}
}

// A media port is an open UDP socket; anything at all can be sent to it. Garbage must be counted,
// never logged per packet and never crash the read loop.
func TestSessionCountsMalformedPacketsAndKeepsRunning(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)
	farEnd := newFarEnd(t, session)

	if _, err := farEnd.Write([]byte("this is not RTP")); err != nil {
		t.Fatalf("sending garbage: %v", err)
	}
	waitFor(t, "the malformed packet to be counted", func() bool {
		return session.Stats().Malformed == 1
	})

	// The loop must still be alive.
	if _, err := farEnd.Write(g711Packet(1, 160, 0x01020304)); err != nil {
		t.Fatalf("sending RTP after garbage: %v", err)
	}
	if _, ok := readPacket(t, farEnd); !ok {
		t.Error("the session stopped echoing after receiving a malformed packet")
	}
	if got := session.Stats().PacketsReceived; got != 1 {
		t.Errorf("PacketsReceived = %d; a malformed packet must not count as received", got)
	}
}

// Symmetric RTP (RFC 4961): the far end is LEARNED from the packets, because behind NAT the
// address that works is the one the NAT rewrote, not the one in the SDP.
func TestSessionLatchesToTheFirstSource(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)

	if session.Remote() != nil {
		t.Fatal("a session must have no remote before its first packet")
	}

	farEnd := newFarEnd(t, session)
	if _, err := farEnd.Write(g711Packet(1, 160, 0xaabbccdd)); err != nil {
		t.Fatalf("sending RTP: %v", err)
	}
	if _, ok := readPacket(t, farEnd); !ok {
		t.Fatal("no echo")
	}

	remote := session.Remote()
	if remote == nil {
		t.Fatal("the session did not latch to the sender")
	}
	expected := farEnd.LocalAddr().(*net.UDPAddr)
	if remote.Port != expected.Port {
		t.Errorf("latched to port %d, want the source port %d", remote.Port, expected.Port)
	}
}

// The latch is frozen after the first packet. Otherwise anyone who can guess a port takes over the
// call by spraying a single packet at it.
func TestSessionRefusesPacketsFromAnotherSourceOnceLatched(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)

	legitimate := newFarEnd(t, session)
	if _, err := legitimate.Write(g711Packet(1, 160, 0x11111111)); err != nil {
		t.Fatalf("sending from the legitimate far end: %v", err)
	}
	if _, ok := readPacket(t, legitimate); !ok {
		t.Fatal("the legitimate far end got no echo")
	}

	attacker := newFarEnd(t, session)
	if _, err := attacker.Write(g711Packet(2, 320, 0x22222222)); err != nil {
		t.Fatalf("sending from the attacker: %v", err)
	}

	waitFor(t, "the foreign source to be counted", func() bool {
		return session.Stats().ForeignSource == 1
	})
	expectNoPacket(t, attacker,
		"the session answered a second source; that is call hijacking by one UDP packet")
	// The latch must be unchanged and the legitimate stream unaffected.
	if session.Remote().Port != legitimate.LocalAddr().(*net.UDPAddr).Port {
		t.Error("the attacker's packet moved the latch")
	}
	if _, err := legitimate.Write(g711Packet(3, 480, 0x11111111)); err != nil {
		t.Fatalf("sending again from the legitimate far end: %v", err)
	}
	if _, ok := readPacket(t, legitimate); !ok {
		t.Error("the legitimate stream broke after a foreign packet arrived")
	}
}

// An inactive session receives and discards. It is what a ringing-but-unanswered leg should be in.
func TestInactiveSessionReceivesButNeverSends(t *testing.T) {
	session := newRunningSession(t, rtp.ModeInactive)
	farEnd := newFarEnd(t, session)

	if _, err := farEnd.Write(g711Packet(1, 160, 0x33333333)); err != nil {
		t.Fatalf("sending RTP: %v", err)
	}
	waitFor(t, "the packet to be received", func() bool {
		return session.Stats().PacketsReceived == 1
	})
	expectNoPacket(t, farEnd, "an inactive session sent audio")
	if got := session.Stats().PacketsSent; got != 0 {
		t.Errorf("PacketsSent = %d, want 0", got)
	}
}

// The wire no longer carries a mode at all.
//
// v0 let a caller ask for "echo" or "inactive" by name. v1 does not: the mode is DERIVED from the
// SDP direction the engine asked for and from whether the diagnostic flag is on, because a media
// mode is an outcome of negotiation rather than an input to it. This test pins the default so that
// a session created without one relays rather than doing something surprising.
func TestSessionDefaultsToRelay(t *testing.T) {
	allocator, err := rtp.NewAllocator(loopback, 54100, 54109)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	defer func() { _ = pair.Close() }()

	session, err := rtp.NewSession(rtp.Options{ID: "defaults", Ports: pair})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if session.Mode() != rtp.ModeRelay {
		t.Errorf("Mode = %q, want %q", session.Mode(), rtp.ModeRelay)
	}
	// A relay with no peer is silent, which is what a leg that has answered but is not yet talking
	// to anybody must be.
	if session.Peer() != nil {
		t.Error("a fresh session already has a peer")
	}
}

func TestNewSessionRequiresAnIDAndPorts(t *testing.T) {
	allocator, err := rtp.NewAllocator(loopback, 54000, 54009)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	t.Cleanup(func() { _ = pair.Close() })

	if _, err := rtp.NewSession(rtp.Options{Ports: pair}); err == nil {
		t.Error("NewSession accepted an empty session id")
	}
	if _, err := rtp.NewSession(rtp.Options{ID: "x"}); err == nil {
		t.Error("NewSession accepted a nil port pair")
	}
}

// The SSRC is drawn from crypto/rand: one an outsider can predict is the handle for injecting
// audio into a call.
func TestSessionsGetDistinctSSRCs(t *testing.T) {
	allocator, err := rtp.NewAllocator(loopback, 54100, 54139)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}

	seen := make(map[uint32]bool)
	for i := 0; i < 10; i++ {
		pair, err := allocator.Allocate()
		if err != nil {
			t.Fatalf("Allocate #%d: %v", i, err)
		}
		session, err := rtp.NewSession(rtp.Options{ID: "s", Ports: pair})
		if err != nil {
			t.Fatalf("NewSession #%d: %v", i, err)
		}
		if session.SSRC == 0 {
			t.Fatal("SSRC is zero")
		}
		if seen[session.SSRC] {
			t.Fatalf("SSRC %#x was drawn twice in ten sessions", session.SSRC)
		}
		seen[session.SSRC] = true
		_ = session.Close()
	}
}

// Closing a session returns its ports; a leaked port is capacity lost until restart.
func TestClosingASessionReleasesItsPorts(t *testing.T) {
	allocator, err := rtp.NewAllocator(loopback, 54200, 54203) // two pairs
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	session, err := rtp.NewSession(rtp.Options{ID: "closing", Ports: pair})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	if allocator.InUse() != 1 {
		t.Fatalf("InUse() = %d, want 1", allocator.InUse())
	}
	if err := session.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if allocator.InUse() != 0 {
		t.Errorf("InUse() = %d after Close, want 0", allocator.InUse())
	}
	// Idempotent, for the same reason PortPair.Close is.
	if err := session.Close(); err != nil {
		t.Errorf("second Close returned %v; it must be a no-op", err)
	}
	if allocator.InUse() != 0 {
		t.Errorf("InUse() = %d after a double Close; the port was released twice", allocator.InUse())
	}
}

// Idle is measured from creation before the first packet, so a session that never receives
// anything is still reaped.
func TestIdleIsMeasuredFromCreationUntilTheFirstPacket(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)

	future := time.Now().Add(time.Minute)
	if idle := session.Idle(future); idle < 59*time.Second {
		t.Errorf("Idle() = %s for a session that never received a packet, want about a minute", idle)
	}

	farEnd := newFarEnd(t, session)
	if _, err := farEnd.Write(g711Packet(1, 160, 0x44444444)); err != nil {
		t.Fatalf("sending RTP: %v", err)
	}
	if _, ok := readPacket(t, farEnd); !ok {
		t.Fatal("no echo")
	}
	if idle := session.Idle(time.Now()); idle > time.Second {
		t.Errorf("Idle() = %s straight after a packet, want ~0", idle)
	}
}

// Run must return nil when its context is cancelled — shutdown is not a failure.
func TestRunReturnsNilOnCancel(t *testing.T) {
	allocator, err := rtp.NewAllocator(loopback, 54300, 54309)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	session, err := rtp.NewSession(rtp.Options{ID: "cancelling", Ports: pair})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- session.Run(ctx) }()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run returned %v on cancel, want nil", err)
		}
	case <-time.After(readTimeout):
		t.Fatal("Run did not return after its context was cancelled")
	}
}

// LocalAddrPort pairs the session's own port with the CONFIGURED public address, because the socket
// may be bound to 0.0.0.0 or to a private address behind NAT.
func TestLocalAddrPortUsesThePublicAddress(t *testing.T) {
	session := newRunningSession(t, rtp.ModeEcho)

	public := netipMustParse(t, "203.0.113.10")
	got := session.LocalAddrPort(public)
	if got.Addr() != public {
		t.Errorf("address = %s, want the configured public %s", got.Addr(), public)
	}
	if int(got.Port()) != session.LocalPort() {
		t.Errorf("port = %d, want the session's %d", got.Port(), session.LocalPort())
	}
}

func netipMustParse(t *testing.T, raw string) netip.Addr {
	t.Helper()
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		t.Fatalf("parsing %q: %v", raw, err)
	}
	return addr
}
