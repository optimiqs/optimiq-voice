package rtp_test

import (
	"encoding/binary"
	"net"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// RTCP, which design doc §10 question 14 has been carrying as "still bound and unread".
//
// The suite drives real RTCP datagrams at the odd port, because a receiver report is a byte layout
// and the interesting failures are all in the layout: a cumulative loss field read as unsigned
// reports sixteen million lost packets on a slightly duplicated stream, and an NTP timestamp built
// without the epoch offset produces a round-trip time seventy years long.

// rtcpSocket is a far end's RTCP port: it sends receiver reports to a session and reads what the
// session sends back.
type rtcpSocket struct {
	conn    *net.UDPConn
	session *net.UDPAddr
}

func newRTCPSocket(t *testing.T, rtpPort int, from *phone) *rtcpSocket {
	t.Helper()
	// The far end's RTCP port is its RTP port plus one, which is the pairing RFC 3550 §11 defines and
	// the one this service sends its own reports to.
	local := from.conn.LocalAddr().(*net.UDPAddr)
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: local.Port + 1})
	if err != nil {
		t.Skipf("the far end's RTCP port %d is taken: %v", local.Port+1, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &rtcpSocket{
		conn:    conn,
		session: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: rtpPort + 1},
	}
}

// receiverReport builds one RFC 3550 §6.4.2 report block about a session's own SSRC.
func receiverReport(aboutSSRC uint32, lossFraction byte, cumulative int32, jitterTicks, lsr, dlsr uint32) []byte {
	packet := make([]byte, 8+24)
	packet[0] = 2<<6 | 1 // version 2, one report block
	packet[1] = 201      // receiver report
	binary.BigEndian.PutUint16(packet[2:4], uint16((len(packet)/4)-1))
	binary.BigEndian.PutUint32(packet[4:8], 0xdeadbeef) // the reporter's own SSRC

	block := packet[8:]
	binary.BigEndian.PutUint32(block[0:4], aboutSSRC)
	binary.BigEndian.PutUint32(block[4:8], uint32(cumulative)&0x00FFFFFF)
	block[4] = lossFraction
	binary.BigEndian.PutUint32(block[12:16], jitterTicks)
	binary.BigEndian.PutUint32(block[16:20], lsr)
	binary.BigEndian.PutUint32(block[20:24], dlsr)
	return packet
}

func TestArrivalJitterIsMeasuredFromTheRTPStream(t *testing.T) {
	// The one number that describes the network on the way IN, and it is measured here rather than
	// reported by anybody: RFC 3550 §6.4.1's J, a smoothed mean deviation between packet spacing at
	// the sender and at the receiver. A leg whose audio is suppressed still has a network under it,
	// so it is folded in for every accepted packet whether or not the leg is bridged.
	rig := newBridgeRig(t, 61000, 61019)

	session, _ := rig.manager.Get(rig.aID)
	// Packets whose sender spacing is 20 ms but whose arrival spacing is not: the definition of
	// jitter, produced deliberately.
	for sequence := 1; sequence <= 12; sequence++ {
		rig.aPhone.send(t, pionrtp.Packet{
			Header: pionrtp.Header{
				Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111,
				SequenceNumber: uint16(sequence),
				Timestamp:      uint32(sequence) * audio.FrameTimestampStep,
			},
			Payload: make([]byte, audio.FrameSamples),
		})
		time.Sleep(time.Duration(sequence%3) * 5 * time.Millisecond)
	}

	waitFor(t, "the session measured some arrival jitter", func() bool {
		return session.Quality().InboundJitterMs > 0
	})
}

func TestReceiverReportsAreFoldedIntoTheLegsQuality(t *testing.T) {
	// What the far end thinks of the stream we send IT, which is the other half of the picture and is
	// unobtainable from RTP alone. A leg with clean inbound jitter and 20% reported loss is a leg
	// whose user can hear us and cannot be heard — a completely different fault from the reverse, and
	// indistinguishable without both numbers.
	rig := newBridgeRig(t, 61040, 61059)
	rig.latch(t)

	session, _ := rig.manager.Get(rig.aID)
	socket := newRTCPSocket(t, rig.aPort, rig.aPhone)

	// 25% loss (64/256), 137 packets lost cumulatively, 160 ticks of jitter (20 ms at 8 kHz).
	report := receiverReport(session.SSRC, 64, 137, 160, 0, 0)
	if _, err := socket.conn.WriteToUDP(report, socket.session); err != nil {
		t.Fatalf("sending a receiver report: %v", err)
	}

	waitFor(t, "the receiver report was parsed", func() bool {
		return session.Quality().ReportsReceived > 0
	})

	quality := session.Quality()
	if quality.ReportedLossFraction < 0.24 || quality.ReportedLossFraction > 0.26 {
		t.Errorf("ReportedLossFraction = %.3f, want about 0.25", quality.ReportedLossFraction)
	}
	if quality.ReportedLossTotal != 137 {
		t.Errorf("ReportedLossTotal = %d, want 137", quality.ReportedLossTotal)
	}
	if quality.ReportedJitterMs < 19 || quality.ReportedJitterMs > 21 {
		t.Errorf("ReportedJitterMs = %.2f, want about 20", quality.ReportedJitterMs)
	}
}

func TestNegativeCumulativeLossIsSignExtended(t *testing.T) {
	// The cumulative loss field is 24-bit SIGNED, and it really does go negative on a network with a
	// retransmitting middlebox where duplicates outnumber losses. Read as unsigned it reports sixteen
	// million lost packets, which is the sort of number that gets a working call declared broken.
	rig := newBridgeRig(t, 61080, 61099)
	rig.latch(t)

	session, _ := rig.manager.Get(rig.aID)
	socket := newRTCPSocket(t, rig.aPort, rig.aPhone)

	if _, err := socket.conn.WriteToUDP(
		receiverReport(session.SSRC, 0, -3, 0, 0, 0), socket.session); err != nil {
		t.Fatalf("sending a receiver report: %v", err)
	}

	waitFor(t, "the receiver report was parsed", func() bool {
		return session.Quality().ReportsReceived > 0
	})
	if got := session.Quality().ReportedLossTotal; got != -3 {
		t.Errorf("ReportedLossTotal = %d, want -3", got)
	}
}

func TestReportBlocksAboutAnotherStreamAreIgnored(t *testing.T) {
	// A report block names the SSRC it is about. Folding in a block about somebody else's stream would
	// attribute a stranger's loss to this call — which really happens, because an RTCP port on the
	// internet receives whatever is sent to it.
	rig := newBridgeRig(t, 61120, 61139)
	rig.latch(t)

	session, _ := rig.manager.Get(rig.aID)
	socket := newRTCPSocket(t, rig.aPort, rig.aPhone)

	if _, err := socket.conn.WriteToUDP(
		receiverReport(session.SSRC^0xFFFF, 128, 9999, 8000, 0, 0), socket.session); err != nil {
		t.Fatalf("sending a receiver report: %v", err)
	}
	// Then one that IS about us, so the test has something to wait for that proves the first was seen
	// and discarded rather than merely not yet arrived.
	if _, err := socket.conn.WriteToUDP(
		receiverReport(session.SSRC, 0, 1, 0, 0, 0), socket.session); err != nil {
		t.Fatalf("sending a receiver report: %v", err)
	}

	waitFor(t, "our own report block was parsed", func() bool {
		return session.Quality().ReportsReceived > 0
	})
	if got := session.Quality().ReportedLossTotal; got != 1 {
		t.Errorf("ReportedLossTotal = %d, want 1: a block about another SSRC was folded in", got)
	}
}

func TestMalformedRTCPIsCountedRatherThanLogged(t *testing.T) {
	// An RTCP port is an open UDP socket on the internet and anything at all can be sent to it.
	// Logging per datagram would turn a trivial flood into a disk-fill, which is the same argument
	// the RTP path's `Malformed` counter makes.
	rig := newBridgeRig(t, 61160, 61179)
	rig.latch(t)

	session, _ := rig.manager.Get(rig.aID)
	socket := newRTCPSocket(t, rig.aPort, rig.aPhone)

	for _, junk := range [][]byte{
		{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, // version 0
		{0x81, 0xC9, 0xFF, 0xFF, 0x00},                   // a length past the end of the datagram
	} {
		if _, err := socket.conn.WriteToUDP(junk, socket.session); err != nil {
			t.Fatalf("sending junk: %v", err)
		}
	}

	waitFor(t, "the junk was counted", func() bool {
		return session.Quality().Malformed > 0
	})
	if session.Quality().ReportsReceived != 0 {
		t.Error("junk was parsed as a receiver report")
	}
}

func TestSendCountersMoveWithEveryOutboundPath(t *testing.T) {
	// A sender report's octet count has to agree with the stream, or every far end's loss estimate is
	// wrong. That is why one function owns the counters and every send path calls it — relay,
	// playback, digit generation and the mixer — rather than each incrementing a field.
	rig := newBridgeRig(t, 61200, 61219)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	before := mustSession(t, rig, rig.bID).Stats().PacketsSent
	rig.aPhone.send(t, pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111, SequenceNumber: 1, Timestamp: 160,
		},
		Payload: make([]byte, audio.FrameSamples),
	})
	if _, ok := rig.bPhone.receive(t); !ok {
		t.Fatal("the relayed frame did not arrive")
	}
	waitFor(t, "the send counter moved", func() bool {
		return mustSession(t, rig, rig.bID).Stats().PacketsSent > before
	})
}
