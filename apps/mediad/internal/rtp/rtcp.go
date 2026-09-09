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

// This file reads receiver reports (RFC 3550 §6.4.2) and the report blocks inside sender reports,
// and sends sender reports of its own. Sending is not optional: round-trip time is computed from a
// receiver report's LSR/DLSR, which are the far end quoting OUR most recent sender report back at
// us, so a listen-only server could never compute one. No congestion control, no receiver reports of
// our own, and no RTCP BYE.

// rtcpReportInterval is how often a sender report goes out. RFC 3550 §6.2's recommended five-second
// minimum, which is also where its bandwidth calculation lands for a two-party G.711 session.
const rtcpReportInterval = 5 * time.Second

// The RTCP packet types this file reads or writes (RFC 3550 §12.1).
const (
	rtcpTypeSenderReport   = 200
	rtcpTypeReceiverReport = 201
	rtcpHeaderBytes        = 8
	rtcpReportBlockBytes   = 24
)

// ntpEpochOffset converts a Unix time to an NTP one: the seconds between 1900-01-01 and 1970-01-01.
const ntpEpochOffset = 2208988800

// QualityStats is what RTCP knows about one leg. InboundJitterMs is measured here and describes the
// inbound network; every other field is what the far end reported about the stream we send it.
type QualityStats struct {
	// InboundJitterMs is the interarrival jitter of the stream we RECEIVE, RFC 3550 §6.4.1's J,
	// converted from timestamp units to milliseconds.
	InboundJitterMs float64
	// ReportedLossFraction is the fraction of OUR packets the far end lost since its last report,
	// 0.0 to 1.0.
	ReportedLossFraction float64
	// ReportedLossTotal is the cumulative number of our packets the far end has ever lost.
	ReportedLossTotal int64
	// ReportedJitterMs is the far end's own jitter measurement of our stream.
	ReportedJitterMs float64
	// RoundTripMs is the round trip, computed from the receiver report's LSR and DLSR. Zero means
	// "not yet computable": it needs a receiver report quoting a sender report we actually sent.
	RoundTripMs float64
	// ReportsReceived is how many receiver reports have been parsed. Zero means the endpoint sends no
	// RTCP, so none of the reported fields above mean anything.
	ReportsReceived uint64
	// ReportsSent is how many sender reports have gone out.
	ReportsSent uint64
	// Malformed counts RTCP datagrams that could not be parsed.
	Malformed uint64
	// LastReportUnixMs is when the last receiver report arrived.
	LastReportUnixMs int64
}

// qualityState is the per-session RTCP bookkeeping.
type qualityState struct {
	mu sync.Mutex

	arrival jitterEstimator
	stats   QualityStats

	// packetsSent and octetsSent are the sender report's own counters: PAYLOAD octets of the RTP
	// packets this session originated, which is not the byte count the control surface reports.
	packetsSent uint32
	octetsSent  uint32

	// lastSRNTPMiddle is the middle 32 bits of the NTP timestamp of the sender report we most
	// recently sent, and lastSRAt is when we sent it; together they turn LSR/DLSR into a round trip.
	lastSRNTPMiddle uint32
	lastSRAt        time.Time

	// report is the sender report's wire buffer and rtcpRemote the address it goes to, both reused
	// across reports. Only the RTCP goroutine touches them, which is what makes that safe.
	report       [28]byte
	rtcpRemote   *net.UDPAddr
	rtcpRemoteOf *net.UDPAddr
}

// observeArrival folds one received RTP packet into the inbound jitter estimate.
func (q *qualityState) observeArrival(packet *pionrtp.Packet, at time.Time, clockRate uint32) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.arrival.observe(packet.Timestamp, at, clockRate)
	q.stats.InboundJitterMs = q.arrival.jitterMs(clockRate)
}

// countSent records one RTP packet leaving this session, for the sender report. Every send path in
// the package MUST call it rather than incrementing PacketsSent directly.
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

// RunRTCP reads the odd port until the context is cancelled or the session is closed. It also
// starts the sender-report ticker, which stops with the same context.
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
		n, from, err := s.readRTCP(buf)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) || s.isClosed() {
				return nil
			}
			return err
		}
		s.handleRTCP(buf[:n], from, time.Now())
	}
}

// handleRTCP parses one compound RTCP datagram. RFC 3550 §6.1 requires RTCP to travel compound, so
// the loop walks every element rather than reading the first and stopping.
func (s *Session) handleRTCP(raw []byte, from *net.UDPAddr, now time.Time) {
	// The source is deliberately not latched: symmetric RTCP (RFC 5761) is not universal, and these
	// reports are diagnostics that are never written back to the source address.
	_ = from

	for offset := 0; offset+rtcpHeaderBytes <= len(raw); {
		// Version/count byte, type, then a length in 32-bit words minus one — the field that lets a
		// compound packet be walked without knowing the types in it.
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
			s.readReportBlocks(body, rtcpHeaderBytes, count, now)
		case rtcpTypeSenderReport:
			// 20 bytes of sender information after the header, then the same report blocks. Only the
			// blocks are read; the sender information describes a stream we already measure ourselves.
			s.readReportBlocks(body, rtcpHeaderBytes+20, count, now)
		}
		offset += length
	}
}

// readReportBlocks folds every report block in one packet into this leg's quality.
func (s *Session) readReportBlocks(body []byte, offset, count int, now time.Time) {
	for block := range count {
		start := offset + block*rtcpReportBlockBytes
		if start+rtcpReportBlockBytes > len(body) {
			s.countRTCPMalformed()
			return
		}
		fields := body[start : start+rtcpReportBlockBytes]

		// A block about another SSRC is not a statement about this leg.
		if binary.BigEndian.Uint32(fields[0:4]) != s.SSRC {
			continue
		}

		lossFraction := float64(fields[4]) / 256
		// A 24-bit SIGNED cumulative loss: negative when duplicates outnumber losses, so it must be
		// sign-extended or a duplicated stream reports sixteen million lost packets.
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
			// RFC 3550 §6.4.1: time since the sender report the far end quotes, minus the delay it
			// reports holding it. DLSR's low 16 bits are 1/65536 of a second.
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

// sendSenderReport puts one RFC 3550 §6.4.1 sender report on the RTCP port. It is skipped until the
// far end has been learned, since symmetric RTP takes that address from an arriving packet.
func (s *Session) sendSenderReport(now time.Time) {
	remote := s.Remote()
	if remote == nil {
		return
	}

	s.quality.mu.Lock()
	packets, octets := s.quality.packetsSent, s.quality.octetsSent
	s.quality.mu.Unlock()

	seconds, fraction := ntpTimestamp(now)
	report := s.quality.report[:]
	report[0] = 2 << 6 // version 2, no padding, zero report blocks.
	report[1] = rtcpTypeSenderReport
	binary.BigEndian.PutUint16(report[2:4], 6) // 28 bytes is seven words, minus one.
	binary.BigEndian.PutUint32(report[4:8], s.SSRC)
	binary.BigEndian.PutUint32(report[8:12], seconds)
	binary.BigEndian.PutUint32(report[12:16], fraction)
	// The RTP timestamp for that wall clock: the last one actually sent, since a computed one would
	// extrapolate across any gap the session spent held or silent.
	binary.BigEndian.PutUint32(report[16:20], s.lastTimestamp.Load())
	binary.BigEndian.PutUint32(report[20:24], packets)
	binary.BigEndian.PutUint32(report[24:28], octets)

	rtcpAddr := s.rtcpAddrFor(remote)
	if _, err := s.writeRTCP(report, rtcpAddr); err != nil {
		s.log.Debug("cannot send an RTCP sender report", "error", err, "remote", rtcpAddr.String())
		return
	}

	s.quality.mu.Lock()
	// The middle 32 bits are what a receiver report quotes back as LSR.
	s.quality.lastSRNTPMiddle = (seconds << 16) | (fraction >> 16)
	s.quality.lastSRAt = now
	s.quality.stats.ReportsSent++
	s.quality.mu.Unlock()
}

// rtcpAddrFor is the RTP far end's odd companion, cached and rebuilt if the latch moves. Only the
// RTCP goroutine calls it, which is what makes the unsynchronised cache safe.
func (s *Session) rtcpAddrFor(remote *net.UDPAddr) *net.UDPAddr {
	if s.quality.rtcpRemoteOf == remote {
		return s.quality.rtcpRemote
	}
	s.quality.rtcpRemoteOf = remote
	s.quality.rtcpRemote = &net.UDPAddr{IP: remote.IP, Port: remote.Port + 1, Zone: remote.Zone}
	return s.quality.rtcpRemote
}

// ntpTimestamp converts a wall clock to the 64-bit NTP form RTCP carries.
func ntpTimestamp(at time.Time) (seconds, fraction uint32) {
	unix := at.Unix()
	nanos := uint64(at.Nanosecond())
	return uint32(unix + ntpEpochOffset), uint32((nanos << 32) / 1e9)
}
