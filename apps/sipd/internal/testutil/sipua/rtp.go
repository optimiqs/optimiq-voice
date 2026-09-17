package sipua

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"net"
	"sync"
	"time"
)

// PayloadPCMU is G.711 µ-law, the codec every SIP endpoint is required to offer.
const PayloadPCMU = 0

// PayloadTelephoneEvent is the dynamic type this helper offers for RFC 4733 DTMF.
const PayloadTelephoneEvent = 101

// RTPStats is what a receiving endpoint observed.
type RTPStats struct {
	Packets int
	Bytes   int
	// ByPayloadType counts packets per RTP payload type, which is how a transcode shows up.
	ByPayloadType map[uint8]int
	// Energy is the mean absolute µ-law-decoded sample value: zero means silence reached us, a
	// non-zero value means audio did.
	Energy float64
	// SSRCs is every synchronisation source seen; a relay that re-originates changes it.
	SSRCs map[uint32]int
	// DTMFEvents lists the RFC 4733 event codes received, in order of first appearance.
	DTMFEvents []uint8
	// Lost is the number of gaps in the sequence numbers of the dominant SSRC.
	Lost int
	// Undecodable counts datagrams an inspector refused (failed SRTP authentication, say).
	Undecodable int
}

// RTPEndpoint is one UDP socket that both sends and receives RTP for a test call.
type RTPEndpoint struct {
	conn *net.UDPConn

	mu      sync.Mutex
	stats   RTPStats
	lastSeq map[uint32]uint16
	samples float64
	total   float64

	stop chan struct{}
	done chan struct{}

	// inspect, when set, is given every datagram as it arrives and returns the bytes to account
	// for — an SRTP receiver decrypts here. Returning nil drops the datagram from the statistics
	// while still counting it in Raw. Set it before any traffic arrives.
	inspect func([]byte) []byte
	// rawCap bounds Raw; zero keeps nothing.
	rawCap int
	raw    [][]byte
	// undecodable counts datagrams inspect refused, which is what a wrong key or a plaintext
	// downgrade looks like to a receiver that expects SRTP.
	undecodable int
}

// NewRTPEndpoint binds an ephemeral even port on the loopback and starts receiving.
func NewRTPEndpoint() (*RTPEndpoint, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	endpoint := &RTPEndpoint{
		conn:    conn,
		stats:   RTPStats{ByPayloadType: map[uint8]int{}, SSRCs: map[uint32]int{}},
		lastSeq: map[uint32]uint16{},
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	go endpoint.receive()
	return endpoint, nil
}

// Port is the port to advertise in an SDP `m=audio` line.
func (e *RTPEndpoint) Port() int { return e.conn.LocalAddr().(*net.UDPAddr).Port }

// Close stops the receiver and releases the socket.
func (e *RTPEndpoint) Close() error {
	select {
	case <-e.stop:
	default:
		close(e.stop)
	}
	err := e.conn.Close()
	<-e.done
	return err
}

// Stats returns a snapshot.
func (e *RTPEndpoint) Stats() RTPStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	snapshot := e.stats
	snapshot.ByPayloadType = make(map[uint8]int, len(e.stats.ByPayloadType))
	for key, value := range e.stats.ByPayloadType {
		snapshot.ByPayloadType[key] = value
	}
	snapshot.SSRCs = make(map[uint32]int, len(e.stats.SSRCs))
	for key, value := range e.stats.SSRCs {
		snapshot.SSRCs[key] = value
	}
	snapshot.DTMFEvents = append([]uint8(nil), e.stats.DTMFEvents...)
	snapshot.Undecodable = e.undecodable
	if e.samples > 0 {
		snapshot.Energy = e.total / e.samples
	}
	return snapshot
}

func (e *RTPEndpoint) receive() {
	defer close(e.done)
	buffer := make([]byte, 2048)
	for {
		select {
		case <-e.stop:
			return
		default:
		}
		_ = e.conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, _, err := e.conn.ReadFromUDP(buffer)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			return
		}
		e.deliver(buffer[:n])
	}
}

// SetInspector installs a transform run on every datagram before it is accounted for, and asks the
// endpoint to retain up to keepRaw datagrams verbatim for a hexdump. Call it before traffic starts.
func (e *RTPEndpoint) SetInspector(inspect func([]byte) []byte, keepRaw int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.inspect, e.rawCap = inspect, keepRaw
}

// Raw returns the datagrams retained by SetInspector, exactly as they arrived on the wire.
func (e *RTPEndpoint) Raw() [][]byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([][]byte(nil), e.raw...)
}

// deliver retains the datagram, runs the inspector, and accounts for whatever survives.
func (e *RTPEndpoint) deliver(packet []byte) {
	e.mu.Lock()
	inspect := e.inspect
	if len(e.raw) < e.rawCap {
		e.raw = append(e.raw, append([]byte(nil), packet...))
	}
	e.mu.Unlock()
	if inspect == nil {
		e.record(packet)
		return
	}
	plain := inspect(packet)
	if plain == nil {
		e.mu.Lock()
		e.undecodable++
		e.mu.Unlock()
		return
	}
	e.record(plain)
}

func (e *RTPEndpoint) record(packet []byte) {
	if len(packet) < 12 || packet[0]>>6 != 2 {
		return
	}
	payloadType := packet[1] & 0x7f
	sequence := binary.BigEndian.Uint16(packet[2:4])
	ssrc := binary.BigEndian.Uint32(packet[8:12])
	payload := packet[12:]

	e.mu.Lock()
	defer e.mu.Unlock()
	e.stats.Packets++
	e.stats.Bytes += len(packet)
	e.stats.ByPayloadType[payloadType]++
	e.stats.SSRCs[ssrc]++
	if previous, seen := e.lastSeq[ssrc]; seen {
		if gap := int(sequence) - int(previous) - 1; gap > 0 {
			e.stats.Lost += gap
		}
	}
	e.lastSeq[ssrc] = sequence

	switch payloadType {
	case PayloadPCMU:
		for _, sample := range payload {
			e.total += math.Abs(float64(ulawDecode(sample)))
			e.samples++
		}
	case PayloadTelephoneEvent:
		if len(payload) >= 4 {
			event := payload[0]
			if len(e.stats.DTMFEvents) == 0 || e.stats.DTMFEvents[len(e.stats.DTMFEvents)-1] != event {
				e.stats.DTMFEvents = append(e.stats.DTMFEvents, event)
			}
		}
	}
}

// RTPSender writes packets towards one remote address.
type RTPSender struct {
	endpoint *RTPEndpoint
	remote   *net.UDPAddr
	ssrc     uint32
	sequence uint16
	stamp    uint32

	// protect, when set, wraps every outgoing packet — this is the SRTP sender. Clearing it mid
	// call is how a plaintext downgrade is put on an SRTP port.
	protect func([]byte) ([]byte, error)
}

// SetProtector installs (or, with nil, removes) the transform applied to every outgoing packet.
func (s *RTPSender) SetProtector(protect func([]byte) ([]byte, error)) { s.protect = protect }

// SSRC is the synchronisation source this sender stamps, which an SRTP context is keyed against.
func (s *RTPSender) SSRC() uint32 { return s.ssrc }

// Sender returns a writer aimed at remote ("host:port").
func (e *RTPEndpoint) Sender(remote string) (*RTPSender, error) {
	address, err := net.ResolveUDPAddr("udp", remote)
	if err != nil {
		return nil, err
	}
	return &RTPSender{
		endpoint: e, remote: address,
		ssrc:     rand.Uint32(),
		sequence: uint16(rand.Uint32()),
		stamp:    rand.Uint32(),
	}, nil
}

// SendTone writes 20 ms G.711 frames of a sine wave for the given duration, paced in real time —
// what a phone with a handset off-hook puts on the wire.
func (s *RTPSender) SendTone(frequency float64, duration time.Duration) (int, error) {
	const frame = 160 // 20 ms at 8 kHz
	frames := int(duration / (20 * time.Millisecond))
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	phase := 0.0
	step := 2 * math.Pi * frequency / 8000
	sent := 0
	for range frames {
		payload := make([]byte, frame)
		for index := range payload {
			payload[index] = ulawEncode(int16(8000 * math.Sin(phase)))
			phase += step
		}
		if err := s.write(PayloadPCMU, payload, false); err != nil {
			return sent, err
		}
		s.stamp += frame
		sent++
		<-ticker.C
	}
	return sent, nil
}

// SendDTMF writes one RFC 4733 event: repeated packets for the duration, then three end packets.
func (s *RTPSender) SendDTMF(event uint8, duration time.Duration) error {
	const frame = 160
	packets := max(int(duration/(20*time.Millisecond)), 1)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	start := s.stamp
	for index := range packets {
		payload := []byte{event, 10, 0, 0}
		binary.BigEndian.PutUint16(payload[2:], uint16((index+1)*frame))
		// The first packet of an event carries the marker bit (RFC 4733 §2.5.1.2).
		if err := s.writeStamped(PayloadTelephoneEvent, payload, index == 0, start); err != nil {
			return err
		}
		<-ticker.C
	}
	for range 3 {
		payload := []byte{event, 0x80 | 10, 0, 0}
		binary.BigEndian.PutUint16(payload[2:], uint16(packets*frame))
		if err := s.writeStamped(PayloadTelephoneEvent, payload, false, start); err != nil {
			return err
		}
	}
	s.stamp = start + uint32(packets*frame)
	return nil
}

func (s *RTPSender) write(payloadType uint8, payload []byte, marker bool) error {
	return s.writeStamped(payloadType, payload, marker, s.stamp)
}

func (s *RTPSender) writeStamped(payloadType uint8, payload []byte, marker bool, stamp uint32) error {
	packet := make([]byte, 12+len(payload))
	packet[0] = 0x80
	packet[1] = payloadType
	if marker {
		packet[1] |= 0x80
	}
	binary.BigEndian.PutUint16(packet[2:4], s.sequence)
	binary.BigEndian.PutUint32(packet[4:8], stamp)
	binary.BigEndian.PutUint32(packet[8:12], s.ssrc)
	copy(packet[12:], payload)
	s.sequence++
	if s.protect != nil {
		protected, err := s.protect(packet)
		if err != nil {
			return err
		}
		packet = protected
	}
	_, err := s.endpoint.conn.WriteToUDP(packet, s.remote)
	return err
}

// OfferSDP is a single-audio-stream offer on the endpoint's port, PCMU plus RFC 4733 DTMF.
func (e *RTPEndpoint) OfferSDP(direction string) string {
	return fmt.Sprintf("v=0\r\no=- %d 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n"+
		"m=audio %d RTP/AVP %d %d\r\na=rtpmap:%d PCMU/8000\r\na=rtpmap:%d telephone-event/8000\r\n"+
		"a=fmtp:%d 0-16\r\na=%s\r\n",
		time.Now().Unix(), e.Port(), PayloadPCMU, PayloadTelephoneEvent,
		PayloadPCMU, PayloadTelephoneEvent, PayloadTelephoneEvent, direction)
}

// ulawEncode is the G.711 µ-law encoder (ITU-T G.711), written out rather than pulled in: the
// helper needs sixteen lines of it and no dependency.
func ulawEncode(sample int16) byte {
	const bias = 0x84
	const clip = 32635
	sign := byte(0)
	if sample < 0 {
		sample = -sample
		sign = 0x80
	}
	if sample > clip {
		sample = clip
	}
	value := int(sample) + bias
	exponent := 7
	for mask := 0x4000; exponent > 0 && value&mask == 0; mask >>= 1 {
		exponent--
	}
	mantissa := (value >> (exponent + 3)) & 0x0f
	return ^(sign | byte(exponent<<4) | byte(mantissa))
}

func ulawDecode(encoded byte) int16 {
	encoded = ^encoded
	sign := encoded & 0x80
	exponent := (encoded >> 4) & 0x07
	mantissa := encoded & 0x0f
	value := (int(mantissa) << 3) + 0x84
	value <<= exponent
	value -= 0x84
	if sign != 0 {
		return int16(-value)
	}
	return int16(value)
}

// SendTonePaced writes a sine wave as packets of the given DURATION each — the knob SendTone does
// not have. A 30 ms packet carries 240 G.711 samples, which is what a phone with ptime=30 puts on
// the wire and what a mixer that assumes 20 ms mishandles.
func (s *RTPSender) SendTonePaced(frequency float64, total, packet time.Duration) (int, error) {
	samples := int(packet.Seconds() * 8000)
	if samples <= 0 {
		return 0, fmt.Errorf("sipua: packet duration %s carries no samples", packet)
	}
	frames := int(total / packet)
	ticker := time.NewTicker(packet)
	defer ticker.Stop()
	phase := 0.0
	step := 2 * math.Pi * frequency / 8000
	sent := 0
	for range frames {
		payload := make([]byte, samples)
		for index := range payload {
			payload[index] = ulawEncode(int16(8000 * math.Sin(phase)))
			phase += step
		}
		if err := s.write(PayloadPCMU, payload, false); err != nil {
			return sent, err
		}
		s.stamp += uint32(samples)
		sent++
		<-ticker.C
	}
	return sent, nil
}
