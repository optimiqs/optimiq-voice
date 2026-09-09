package rtp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Generating RFC 4733 digits towards a leg's far end. Digits a party presses are forwarded by the
// relay as ordinary bytes; this file originates digits, where there is no inbound packet to forward.

// ErrNoTelephoneEvent is returned when a leg negotiated no RFC 4733 payload type.
//
// A refusal, never a fallback to an audible tone: sending under a payload type the far end never
// agreed to produces digits it drops, and there is no inband tone generator here.
var ErrNoTelephoneEvent = errors.New(
	"rtp: this leg negotiated no RFC 4733 telephone-event payload type, so a digit cannot be sent")

// ErrUnsendableDigit is returned for a character no telephone-event code exists for.
var ErrUnsendableDigit = errors.New("rtp: not a digit RFC 4733 can carry")

// RFC 4733 §3.2 event codes: 0-9 are themselves, then the keypad symbols, then A-D.
const (
	dtmfEventStar  = 10
	dtmfEventPound = 11
	dtmfEventA     = 12
)

// dtmfPayloadBytes is the fixed size of a telephone-event payload: event, flags+volume, duration.
const dtmfPayloadBytes = 4

// dtmfVolume is the tone power the packets claim, in -dBm0 (RFC 4733 §2.3.2). A receiver that
// regenerates the tone inband uses it, so a wrong value plays the digit at the wrong level.
const dtmfVolume = 10

// dtmfEndPacketCopies is how many times the final packet of a digit goes out. RFC 4733 §2.5.1.4:
// the END packet is the only one that tells the receiver the digit is over, and losing it leaves the
// far end holding the tone open. They go out back to back so the digit's wall-clock length matches
// the RTP-clock length it claims.
const dtmfEndPacketCopies = 3

// Default timings, matching ARI's `POST /channels/{id}/dtmf` (`duration` and `between`, both 100 ms).
const (
	DefaultDtmfToneDuration = 100 * time.Millisecond
	DefaultDtmfGap          = 100 * time.Millisecond
)

// DtmfOptions is one digit string to generate.
type DtmfOptions struct {
	// Digits are 0-9, A-D, * and #. Validated before anything is sent — see ValidateDigits.
	Digits string
	// ToneDuration is how long each tone lasts. Zero means DefaultDtmfToneDuration.
	ToneDuration time.Duration
	// Gap is the silence between digits. Zero means DefaultDtmfGap; use a negative value for none.
	Gap time.Duration
}

// resolve fills the defaults and returns the two durations actually used.
func (o DtmfOptions) resolve() (tone, gap time.Duration) {
	tone = o.ToneDuration
	if tone <= 0 {
		tone = DefaultDtmfToneDuration
	}
	gap = o.Gap
	switch {
	case gap < 0:
		gap = 0
	case gap == 0:
		gap = DefaultDtmfGap
	}
	return tone, gap
}

// QueuedDuration is how long the whole string takes to put on the wire, tone and gap included. The
// reply is sent when injection starts, so this is what tells the caller when the last digit lands.
func (o DtmfOptions) QueuedDuration() time.Duration {
	tone, gap := o.resolve()
	return time.Duration(len([]rune(o.Digits))) * (tone + gap)
}

// DtmfEventCode maps one character to its RFC 4733 §3.2 event code.
func DtmfEventCode(digit rune) (byte, error) {
	switch {
	case digit >= '0' && digit <= '9':
		return byte(digit - '0'), nil
	case digit == '*':
		return dtmfEventStar, nil
	case digit == '#':
		return dtmfEventPound, nil
	case digit >= 'A' && digit <= 'D':
		return byte(dtmfEventA + (digit - 'A')), nil
	case digit >= 'a' && digit <= 'd':
		return byte(dtmfEventA + (digit - 'a')), nil
	default:
		return 0, fmt.Errorf("%w: %q", ErrUnsendableDigit, string(digit))
	}
}

// ValidateDigits resolves a whole string to event codes, or fails naming the first bad character.
// The whole string is checked before a single packet goes out, so no prefix is ever sent.
func ValidateDigits(digits string) ([]byte, error) {
	if strings.TrimSpace(digits) == "" {
		return nil, errors.New("rtp: a digit string is required")
	}
	codes := make([]byte, 0, len(digits))
	for _, digit := range digits {
		code, err := DtmfEventCode(digit)
		if err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, nil
}

// DtmfInjection is one digit string in flight on one session.
//
// It owns the session's single outbound stream for its duration: a telephone-event digit occupies a
// span of the timestamp clock (every packet carries the digit's start timestamp and a growing
// duration), so a relayed frame let out mid-span would put a second clock inside the digit. Relayed
// and playback frames are therefore suppressed and counted for the length of the string, and the
// marker bit is forced onto the first frame after it.
type DtmfInjection struct {
	digits  string
	codes   []byte
	tone    time.Duration
	gap     time.Duration
	session *Session

	// sent counts digits whose END packet reached the socket.
	sent atomic.Int64

	done chan struct{}
	// failure is whatever stopped the injection early, or nil.
	failure atomic.Pointer[error]
}

// Digits is the string being generated.
func (d *DtmfInjection) Digits() string { return d.digits }

// Done is closed when every digit has been sent, or the injection has given up.
func (d *DtmfInjection) Done() <-chan struct{} { return d.done }

// Sent is how many digits have completed.
func (d *DtmfInjection) Sent() int { return int(d.sent.Load()) }

// Err is what stopped the injection early, or nil.
func (d *DtmfInjection) Err() error {
	if failure := d.failure.Load(); failure != nil {
		return *failure
	}
	return nil
}

// ActiveDtmf is the digit string currently being generated on this session, or nil.
func (s *Session) ActiveDtmf() *DtmfInjection { return s.dtmf.Load() }

// SendDtmf begins generating a digit string towards this session's far end.
//
// It returns as soon as injection is running, mirroring ARI's `POST /channels/{id}/dtmf`. Everything
// refusable is decided before the goroutine starts, so a successful return means the digits are
// going out. A second string queues behind the first rather than superseding it — unlike playback,
// because digits are a sequence: "12" then "34" must arrive as "1234".
func (s *Session) SendDtmf(opts DtmfOptions) (*DtmfInjection, error) {
	codes, err := ValidateDigits(opts.Digits)
	if err != nil {
		return nil, err
	}
	if s.TelephoneEventPayloadType() == 0 {
		return nil, ErrNoTelephoneEvent
	}
	if s.Remote() == nil {
		// Symmetric RTP learns the far end from its first packet, so a leg that has not sent has
		// taught us nowhere to send.
		return nil, ErrNoRemote
	}
	if s.isClosed() {
		return nil, ErrUnknownSession
	}

	tone, gap := opts.resolve()
	injection := &DtmfInjection{
		digits:  opts.Digits,
		codes:   codes,
		tone:    tone,
		gap:     gap,
		session: s,
		done:    make(chan struct{}),
	}

	go injection.run()
	return injection, nil
}

// run puts every digit on the wire, one 20 ms packet at a time.
func (d *DtmfInjection) run() {
	defer close(d.done)

	session := d.session

	// The lock makes two overlapping strings a queue rather than an interleave. It is taken inside
	// the goroutine so the command's reply is not held behind a string somebody else is sending.
	session.dtmfMu.Lock()
	defer session.dtmfMu.Unlock()

	// Published only once this injection actually owns the outbound stream, so the suppression the
	// packet path reads is never on behalf of a string that has not started.
	session.dtmf.Store(d)
	defer func() {
		session.dtmf.CompareAndSwap(d, nil)
		// The next relayed or played frame carries a marker: the stream is switching back from the
		// digit's clock to the peer's, and a receiver left to infer the discontinuity answers with
		// concealment noise.
		session.markNextForward.Store(true)
	}()

	ticks, stopTicker := session.newTicker(audio.FrameDurationMs * time.Millisecond)
	defer stopTicker()

	toneSamples := uint32(d.tone.Milliseconds()) * audio.SampleRate / 1000
	gapSamples := uint32(d.gap.Milliseconds()) * audio.SampleRate / 1000
	tonePackets := int((toneSamples + audio.FrameTimestampStep - 1) / audio.FrameTimestampStep)
	gapTicks := int((gapSamples + audio.FrameTimestampStep - 1) / audio.FrameTimestampStep)

	for _, code := range d.codes {
		// One digit reserves its own span of the outbound clock, continuing from whatever this
		// session last put on the wire: a timestamp going backwards is read by some endpoints as a
		// restart and answered by flushing the buffer.
		start := session.lastTimestamp.Add(audio.FrameTimestampStep)

		for packet := 1; packet <= tonePackets; packet++ {
			if !d.wait(ticks) {
				return
			}
			duration := min(uint32(packet)*audio.FrameTimestampStep, toneSamples)
			if err := session.sendDtmfPacket(code, false, duration, start, packet == 1); err != nil {
				d.fail(err)
				return
			}
		}

		// The END packets, back to back. See dtmfEndPacketCopies for why three and why not spaced.
		for range dtmfEndPacketCopies {
			if err := session.sendDtmfPacket(code, true, toneSamples, start, false); err != nil {
				d.fail(err)
				return
			}
		}
		d.sent.Add(1)

		// The gap is silence, not packets: RFC 4733 carries events, and an inter-digit interval is
		// the absence of one. The outbound clock still advances across it.
		for range gapTicks {
			if !d.wait(ticks) {
				return
			}
		}
		session.lastTimestamp.Store(start + toneSamples + gapSamples - audio.FrameTimestampStep)
	}
}

// wait blocks for the next frame slot, reporting false when the session went away underneath it.
func (d *DtmfInjection) wait(ticks <-chan time.Time) bool {
	select {
	case <-d.session.done:
		// The leg was released or reaped mid-string; `session.ended` carries the real story.
		return false
	case <-ticks:
		return true
	}
}

func (d *DtmfInjection) fail(err error) {
	d.failure.Store(&err)
	d.session.log.Warn("a DTMF digit could not be put on the wire; the far end heard part of a string",
		"digits", d.digits, "sent", d.Sent(), "error", err)
}

// sendDtmfPacket writes one RFC 4733 telephone-event packet out of this session's socket.
//
// It shares the session's SSRC and sequence counter with the relay and with playback: a digit is not
// a second stream. A separate SSRC would make the endpoint see a sender start and stop per keypress.
func (s *Session) sendDtmfPacket(event byte, end bool, duration, timestamp uint32, marker bool) error {
	to := s.Remote()
	if to == nil {
		return ErrNoRemote
	}

	payload := make([]byte, dtmfPayloadBytes)
	payload[0] = event
	payload[1] = dtmfVolume
	if end {
		payload[1] |= 0x80
	}
	// The duration field is 16 bits of timestamp units, so a tone longer than 8.19 s at 8 kHz would
	// wrap. The contract caps a tone at 1 s, which is two orders of magnitude inside that.
	duration = min(duration, 0xFFFF)
	binary.BigEndian.PutUint16(payload[2:], uint16(duration))

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    s.TelephoneEventPayloadType(),
			SequenceNumber: s.nextSequence(),
			Timestamp:      timestamp,
			SSRC:           s.SSRC,
			// The marker on the first packet of a digit is RFC 4733 §2.5.1.2's start-of-event flag,
			// which is what an IVR keys on.
			Marker: marker,
		},
		Payload: payload,
	}

	encoded, err := out.Marshal()
	if err != nil {
		return fmt.Errorf("rtp: marshalling a DTMF packet: %w", err)
	}
	if _, err := s.writeRTP(encoded, to); err != nil {
		// Unlike a relayed frame, a failed digit is not swallowed: nothing later makes up for a
		// digit that never reached the socket.
		return fmt.Errorf("rtp: sending a DTMF packet to %s: %w", to, err)
	}
	s.countSent(uint32(len(payload)))
	s.count(func(st *Stats) { st.DtmfPacketsSent++ })
	return nil
}

// dtmfActive reports whether a digit string currently owns this session's outbound stream.
func (s *Session) dtmfActive() bool { return s.dtmf.Load() != nil }
