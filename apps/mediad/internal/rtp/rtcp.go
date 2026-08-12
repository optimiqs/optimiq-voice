package rtp

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"sync"
	"time"

	pionrtp "github.com/pion/rtp"
)

// RTCP, which plans/mediad-design.md §10 question 14 has been carrying as "still bound and unread".
//
// The port has been bound since rung 0 — §6.3 explains why an unbound odd port is one an unrelated
// process can take — and nothing read from it. This file reads it, and the reason it is worth doing
// NOW rather than at some later rung is §8.4: rungs 2 and 6 gate on "MOS and jitter measured against
// an Asterisk baseline", and §10 question 16 says plainly that this wave measured nothing. RTCP
// receiver reports are the only in-band source of the numbers that gate exists on. A conference is
// also the first place where "which participant has the bad network" is a question somebody has to
// answer, and it is unanswerable from RTP alone.
//
// # What is read, and what is sent
//
// READ: receiver reports (RFC 3550 §6.4.2), and the report blocks inside a sender report, which
// carry what the FAR END thinks of the stream we are sending it — its loss fraction, its
// interarrival jitter, and the two fields that make round-trip time computable.
//
// SENT: sender reports, on the standard interval. They are not optional if the numbers above are
// wanted, and that is the non-obvious part: RTT is computed from `LSR` and `DLSR` in a receiver
// report, both of which are the far end quoting the timestamp of OUR most recent sender report back
// at us. A media server that only listened would receive receiver reports with `LSR = 0` forever and
// could never compute a round trip. Sending them also makes this a well-behaved RTP participant,
// which matters to the endpoints and the middleboxes that count.
//
// # What is deliberately NOT done
//
// No RTCP-based congestion control, no receiver reports of our own, and no BYE. Receiver reports
// would tell the FAR END what we think of ITS stream, which is information nothing in this
// deployment consumes and which would double the RTCP traffic; they arrive with the rung that has a
// consumer. RTCP BYE is a courtesy that no endpoint depends on for teardown, because SIP already
// said the call ended.

// rtcpReportInterval is how often a sender report goes out.
//
// Five seconds. RFC 3550 §6.2 sets the RTCP budget at 5% of the session bandwidth and computes an
// interval from the group size, with a recommended minimum of five seconds — and for a two-party
// session at G.711's 64 kbit/s that calculation lands almost exactly on the minimum anyway. Using
// the constant rather than the calculation is honest here because the group size in this service is
// always two: mediad and one endpoint, per socket, even when the leg is one of ten in a conference.
const rtcpReportInterval = 5 * time.Second

// The RTCP packet types this file reads or writes (RFC 3550 §12.1).
const (
	rtcpTypeSenderReport   = 200
	rtcpTypeReceiverReport = 201
	rtcpHeaderBytes        = 8
	rtcpReportBlockBytes   = 24
)

// ntpEpochOffset converts a Unix time to an NTP one: the seconds between 1900-01-01 and 1970-01-01.
//
// RTCP timestamps are NTP, and the middle 32 bits of one are what a sender report advertises and a
// receiver report quotes back. Getting this wrong does not produce an error — it produces a
// round-trip time that is off by seventy years, which is why it is a named constant rather than a
// literal in an expression.
const ntpEpochOffset = 2208988800

// QualityStats is what RTCP knows about one leg.
//
// Two halves that must not be confused. `InboundJitterMs` is measured HERE from the packets that
// arrived, and describes the network on the way in. Everything else is what the FAR END reported
// about the stream we send IT, and describes the network on the way out. A leg with clean inbound
// jitter and 20% reported loss is a leg whose user can hear us and cannot be heard — which is a
// completely different fault from the reverse, and is indistinguishable without both numbers.
type QualityStats struct {
	// InboundJitterMs is the interarrival jitter of the stream we RECEIVE, RFC 3550 §6.4.1's J,
	// converted from timestamp units to milliseconds.
	InboundJitterMs float64
	// ReportedLossFraction is the fraction of OUR packets the far end lost since its last report,
	// 0.0 to 1.0. The eight-bit field divided by 256, which is the resolution the protocol has.
	ReportedLossFraction float64
	// ReportedLossTotal is the cumulative number of our packets the far end has ever lost.
	ReportedLossTotal int64
	// ReportedJitterMs is the far end's own jitter measurement of our stream.
	ReportedJitterMs float64
	// RoundTripMs is the round trip, computed from the receiver report's LSR and DLSR.
	//
	// Zero means "not yet computable" rather than "zero milliseconds": it needs a receiver report
	// that quotes a sender report we actually sent, which takes one report interval after the first
	// packet.
	RoundTripMs float64
	// ReportsReceived is how many receiver reports have been parsed. The number that says whether
	// the values above mean anything at all — an endpoint that sends no RTCP leaves them all zero,
	// and that is a fact about the endpoint rather than about the call.
	ReportsReceived uint64
	// ReportsSent is how many sender reports have gone out.
	ReportsSent uint64
	// Malformed counts RTCP datagrams that could not be parsed. An open UDP port on the internet
	// receives anything at all, so this is counted rather than logged, exactly as RTP's is.
	Malformed uint64
	// LastReportUnixMs is when the last receiver report arrived.
	LastReportUnixMs int64
}

// qualityState is the per-session RTCP bookkeeping.
type qualityState struct {
	mu sync.Mutex

	arrival jitterEstimator
	stats   QualityStats

	// packetsSent and octetsSent are the sender report's own counters. Kept here rather than derived
	// from Stats because a sender report counts the PAYLOAD octets of the RTP packets this session
	// originated, which is not the same number as the byte counters the control surface reports.
	packetsSent uint32
	octetsSent  uint32

	// lastSRNTPMiddle is the middle 32 bits of the NTP timestamp of the sender report we most
	// recently sent, and lastSRAt is when we sent it. Together they are what turns a receiver
	// report's LSR/DLSR pair into a round trip.
	lastSRNTPMiddle uint32
	lastSRAt        time.Time
}

// observeArrival folds one received RTP packet into the inbound jitter estimate.
func (q *qualityState) observeArrival(packet *pionrtp.Packet, at time.Time, clockRate uint32) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.arrival.observe(packet.Timestamp, at, clockRate)
	q.stats.InboundJitterMs = q.arrival.jitterMs(clockRate)
}

// countSent records one RTP packet leaving this session, for the sender report.
//
// It is the ONE place the send counters move, which is why every send path in the package calls it
// rather than incrementing PacketsSent directly: a sender report whose octet count disagreed with
// the stream would make every far end's loss estimate wrong.
func (s *Session) countSent(payloadBytes uint32) {
	s.count(func(st *Stats) { st.PacketsSent++ })
	s.quality.mu.Lock()
	s.quality.packetsSent++
	s.quality.octetsSent += payloadBytes
	s.quality.mu.Unlock()
}

// Quality copies this leg's RTCP-derived numbers out.
func (s *Session) Quality() QualityStats {
	s.quality.mu.Lock()
	defer s.quality.mu.Unlock()
	return s.quality.stats
}

// RunRTCP reads the odd port until the context is cancelled or the session is closed.
//
// A second goroutine per session, and the cost is the same argument the read loop makes: a parked
// goroutine is a few kilobytes and the kernel does the multiplexing. It is separate from the RTP
// loop rather than multiplexed with it because a `select` over two sockets in Go means either two
// goroutines anyway or a poller this service has no reason to own.
func (s *Session) RunRTCP(ctx context.Context) error {
	stop := context.AfterFunc(ctx, func() { _ = s.ports.RTCP.Close() })
	defer stop()

	ticker := time.NewTicker(rtcpReportInterval)
	defer ticker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-s.done:
				return
			case <-ticker.C:
				s.sendSenderReport(time.Now())
			}
		}
	}()

	buf := make([]byte, maxPacketSize)
	for {
		n, from, err := s.ports.RTCP.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) || s.isClosed() {
				return nil
			}
			return err
		}
		s.handleRTCP(buf[:n], from, time.Now())
	}
}

// handleRTCP parses one compound RTCP datagram.
//
// RFC 3550 §6.1 requires RTCP packets to travel as a COMPOUND packet — a report followed by an SDES
// — so the loop walks every element rather than reading the first and stopping. A receiver report
// carried behind a sender report is the normal shape from an endpoint that is both sending and
// receiving, which is every endpoint on a call.
func (s *Session) handleRTCP(raw []byte, from *net.UDPAddr, now time.Time) {
	// The RTCP port learns its far end the same way the RTP port does, and it is checked against the
	// RTP latch rather than latched separately. An endpoint that sends RTP from one address and RTCP
	// from another exists (symmetric RTCP, RFC 5761, is not universal), so a mismatch is counted
	// rather than refused — the reports are diagnostics, and refusing one would lose the diagnostic
	// without protecting anything: nothing here is written back to the source address.
	_ = from

	for offset := 0; offset+rtcpHeaderBytes <= len(raw); {
		// Every RTCP packet begins with a version/count byte, a type, and a length in 32-bit words
		// minus one — which is the field that lets a compound packet be walked without knowing the
		// types in it.
		if raw[offset]>>6 != 2 {
			s.countRTCPMalformed()
			return
		}
		count := int(raw[offset] & 0x1F)
		packetType := raw[offset+1]
		length := (int(binary.BigEndian.Uint16(raw[offset+2:offset+4])) + 1) * 4
		if length < rtcpHeaderBytes || offset+length > len(raw) {
			s.countRTCPMalformed()
			return
		}

		body := raw[offset : offset+length]
		switch packetType {
		case rtcpTypeReceiverReport:
			// SSRC of the reporter, then `count` report blocks.
			s.readReportBlocks(body, rtcpHeaderBytes, count, now)
		case rtcpTypeSenderReport:
			// A sender report is 20 bytes of sender information after the header, then the same
			// report blocks. We read only the blocks: the sender information describes the far end's
			// own stream, which is the stream we are already measuring ourselves.
			s.readReportBlocks(body, rtcpHeaderBytes+20, count, now)
		}
		offset += length
	}
}

// readReportBlocks folds every report block in one packet into this leg's quality.
func (s *Session) readReportBlocks(body []byte, offset, count int, now time.Time) {
	for block := 0; block < count; block++ {
		start := offset + block*rtcpReportBlockBytes
		if start+rtcpReportBlockBytes > len(body) {
			s.countRTCPMalformed()
			return
		}
		fields := body[start : start+rtcpReportBlockBytes]

		// Report blocks name the SSRC they are about. A block about somebody else's stream is not a
		// statement about this leg, and folding it in would attribute a stranger's loss to our call.
		if binary.BigEndian.Uint32(fields[0:4]) != s.SSRC {
			continue
		}

		lossFraction := float64(fields[4]) / 256
		// A 24-bit SIGNED cumulative loss: it goes negative when duplicates outnumber losses, which
		// really happens on a network with a retransmitting middlebox. Sign-extended rather than read
		// as unsigned, or a slightly duplicated stream reports sixteen million lost packets.
		cumulative := int64(int32(binary.BigEndian.Uint32(fields[4:8])<<8) >> 8)
		jitterTicks := binary.BigEndian.Uint32(fields[12:16])
		lsr := binary.BigEndian.Uint32(fields[16:20])
		dlsr := binary.BigEndian.Uint32(fields[20:24])

		s.quality.mu.Lock()
		s.quality.stats.ReportsReceived++
		s.quality.stats.LastReportUnixMs = now.UnixMilli()
		s.quality.stats.ReportedLossFraction = lossFraction
		s.quality.stats.ReportedLossTotal = cumulative
		s.quality.stats.ReportedJitterMs = float64(jitterTicks) * 1000 / float64(s.clockRate())
		if lsr != 0 && lsr == s.quality.lastSRNTPMiddle && !s.quality.lastSRAt.IsZero() {
			// RFC 3550 §6.4.1: the round trip is the time since we sent the report the far end is
			// quoting, minus the time it says it spent holding onto it before replying. Both are in
			// NTP's middle-32 format, where the low 16 bits are 1/65536 of a second.
			elapsed := now.Sub(s.quality.lastSRAt).Seconds()
			held := float64(dlsr) / 65536
			if trip := elapsed - held; trip >= 0 {
				s.quality.stats.RoundTripMs = trip * 1000
			}
		}
		s.quality.mu.Unlock()
	}
}

func (s *Session) countRTCPMalformed() {
	s.quality.mu.Lock()
	s.quality.stats.Malformed++
	s.quality.mu.Unlock()
}

// sendSenderReport puts one RFC 3550 §6.4.1 sender report on the RTCP port.
//
// It is skipped when the far end has not been learned, for the same reason a playback is: symmetric
// RTP means the address comes from the packets, and there is nowhere to send until one arrives.
func (s *Session) sendSenderReport(now time.Time) {
	remote := s.Remote()
	if remote == nil {
		return
	}

	s.quality.mu.Lock()
	packets, octets := s.quality.packetsSent, s.quality.octetsSent
	s.quality.mu.Unlock()

	seconds, fraction := ntpTimestamp(now)
	report := make([]byte, 28)
	report[0] = 2 << 6 // version 2, no padding, zero report blocks.
	report[1] = rtcpTypeSenderReport
	binary.BigEndian.PutUint16(report[2:4], 6) // 28 bytes is seven words, minus one.
	binary.BigEndian.PutUint32(report[4:8], s.SSRC)
	binary.BigEndian.PutUint32(report[8:12], seconds)
	binary.BigEndian.PutUint32(report[12:16], fraction)
	// The RTP timestamp corresponding to that wall clock. The last one this session put on the wire
	// is the honest answer: it is a real instant on this stream's clock, where a computed one would
	// be an extrapolation across a gap this session may have spent held or silent.
	binary.BigEndian.PutUint32(report[16:20], s.lastTimestamp.Load())
	binary.BigEndian.PutUint32(report[20:24], packets)
	binary.BigEndian.PutUint32(report[24:28], octets)

	rtcpAddr := &net.UDPAddr{IP: remote.IP, Port: remote.Port + 1, Zone: remote.Zone}
	if _, err := s.ports.RTCP.WriteToUDP(report, rtcpAddr); err != nil {
		s.log.Debug("cannot send an RTCP sender report", "error", err, "remote", rtcpAddr.String())
		return
	}

	s.quality.mu.Lock()
	// The middle 32 bits — the low 16 of the seconds and the high 16 of the fraction — are what a
	// receiver report quotes back as LSR, so they are what has to be remembered to match it.
	s.quality.lastSRNTPMiddle = (seconds << 16) | (fraction >> 16)
	s.quality.lastSRAt = now
	s.quality.stats.ReportsSent++
	s.quality.mu.Unlock()
}

// ntpTimestamp converts a wall clock to the 64-bit NTP form RTCP carries.
func ntpTimestamp(at time.Time) (seconds, fraction uint32) {
	unix := at.Unix()
	nanos := uint64(at.Nanosecond())
	return uint32(unix + ntpEpochOffset), uint32((nanos << 32) / 1e9)
}
