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

// Rung 3 of plans/mediad-design.md §2: GENERATING RFC 4733 digits towards a leg's far end.
//
// Digits a party PRESSES have crossed a mediad bridge since rung 2 — a telephone-event payload is
// just bytes to a relay, so the header rewrite forwards them and renumbers the payload type between
// two legs that negotiated differently. What that path cannot do is originate a digit, because
// there is no inbound packet to forward. An attended transfer punching an extension into a far-end
// IVR, and a confirmed transfer answering "press 1 to accept" on the caller's behalf, are both this
// file.

// ErrNoTelephoneEvent is returned when a leg negotiated no RFC 4733 payload type.
//
// A REFUSAL, and never a fallback to an audible tone. The leg's SDP answer said it does not expect
// telephone-event, and both alternatives are worse than saying so: sending under a payload type the
// far end never agreed to produces digits it drops — an IVR that "randomly" ignores keypresses —
// and synthesising an inband tone means writing a tone generator, which is the same deferral
// `tone://` carries at start-playback. The engine answers this by routing the leg to Asterisk,
// which has both.
var ErrNoTelephoneEvent = errors.New(
	"rtp: this leg negotiated no RFC 4733 telephone-event payload type, so a digit cannot be sent")

// ErrUnsendableDigit is returned for a character no telephone-event code exists for.
var ErrUnsendableDigit = errors.New("rtp: not a digit RFC 4733 can carry")

// The RFC 4733 §3.2 event codes. 0-9 are themselves, then the two keypad symbols, then the four
// military-precedence letters every DTMF keypad has and almost no telephone shows.
const (
	dtmfEventStar  = 10
	dtmfEventPound = 11
	dtmfEventA     = 12
)

// dtmfPayloadBytes is the fixed size of a telephone-event payload: event, flags+volume, duration.
const dtmfPayloadBytes = 4

// dtmfVolume is the tone power the packets CLAIM, in -dBm0 (RFC 4733 §2.3.2).
//
// 10 is what Asterisk, FreeSWITCH and every softphone send. It is a declaration rather than a
// measurement — there is no audio here to be loud — but a receiver that regenerates the tone
// inband uses it, so a wrong value is a digit the next hop plays at the wrong level.
const dtmfVolume = 10

// dtmfEndPacketCopies is how many times the final packet of a digit goes out.
//
// RFC 4733 §2.5.1.4: the packet carrying the END bit is the only one that tells the receiver the
// digit is over, and losing it leaves a far end holding a tone open until its own timeout — which
// an IVR reads as one very long keypress, or as two digits where the caller pressed one. Three
// copies is the RFC's own number, and they go out BACK TO BACK rather than a frame apart so that
// the digit's wall-clock length matches the RTP-clock length it claims.
const dtmfEndPacketCopies = 3

// Default timings, matching ARI's `POST /channels/{id}/dtmf` (`duration` and `between`, both 100
// ms) so the two drivers put the same thing on the wire for a request that names neither.
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

// QueuedDuration is how long the whole string takes to put on the wire, tone and gap included.
//
// It is on the reply because the reply is sent when injection STARTS, so this is the only number
// that tells the caller when the far end will have heard the last digit.
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
//
// The WHOLE string, before a single packet goes out. A validator that failed halfway would leave a
// far-end IVR having received a prefix of what was asked for, with a reply that said the request
// was accepted — and no way for the caller to know which digits landed.
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
// # Why it takes the outbound stream for its duration
//
// The same argument Playback makes, and it has to be the same argument because it is the same
// constraint: a session has ONE outbound RTP stream — one SSRC, one sequence space, one socket —
// and a telephone-event digit occupies a SPAN of that stream's timestamp clock rather than a
// point. Every packet of a digit carries the timestamp the digit STARTED at and a duration field
// that grows, which is how a receiver reconstructs one tone from several packets. Letting a relayed
// audio frame out in the middle of that span would put a second, unrelated clock inside the digit,
// and the receiver would either regenerate a tone of the wrong length or drop the digit entirely.
//
// So relayed audio and playback frames are suppressed for the length of the string, counted rather
// than silently dropped, and the marker bit is forced onto the first frame after it — RFC 3550's
// start-of-talkspurt flag doing exactly the job it does at the edges of a prompt.
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
// It returns as soon as injection is RUNNING, mirroring ARI's `POST /channels/{id}/dtmf`, which
// queues the frames and answers. That is not a convenience: the two drivers have to behave the same
// way at the seam above, and `MediaPort.sendDtmf` returns `void` — a caller handed nothing has been
// told nothing by a late reply that it was not told by an early one.
//
// Everything REFUSABLE is decided here, before the goroutine starts, so an `ok` reply means the
// digits are going out rather than that they were accepted for consideration.
//
// A second string on a session QUEUES behind the first rather than superseding it, which is the
// opposite of the playback rule and for the opposite reason: digits are a SEQUENCE. A caller that
// sent "12" and then "34" wants "1234" — superseding would deliver "34" and queueing a prompt would
// make a caller listen to a menu they have already answered.
func (s *Session) SendDtmf(opts DtmfOptions) (*DtmfInjection, error) {
	codes, err := ValidateDigits(opts.Digits)
	if err != nil {
		return nil, err
	}
	if s.telephoneEventPayloadType == 0 {
		return nil, ErrNoTelephoneEvent
	}
	if s.Remote() == nil {
		// Symmetric RTP learns the far end from its first packet, so a leg that has not sent has
		// taught us nowhere to send. Refused rather than started, exactly as playback is.
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

	// The lock is what makes two overlapping strings a QUEUE rather than an interleave. It is taken
	// inside the goroutine rather than in SendDtmf so that the command's reply is not held behind a
	// string somebody else is still sending.
	session.dtmfMu.Lock()
	defer session.dtmfMu.Unlock()

	// Published only once this injection actually owns the outbound stream, so the suppression the
	// packet path reads is never on behalf of a string that has not started.
	session.dtmf.Store(d)
	defer func() {
		session.dtmf.CompareAndSwap(d, nil)
		// The next relayed or played frame carries a marker: the outbound stream is switching back
		// from the digit's clock to the peer's, and a receiver told "new talkspurt" resumes cleanly
		// where one left to infer a discontinuity answers with concealment noise.
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
		// session last put on the wire rather than restarting — sending a stream's timestamp
		// BACKWARDS is read by some endpoints as a restart and answered by flushing the buffer.
		start := session.lastTimestamp.Add(audio.FrameTimestampStep)

		for packet := 1; packet <= tonePackets; packet++ {
			if !d.wait(ticks) {
				return
			}
			duration := uint32(packet) * audio.FrameTimestampStep
			if duration > toneSamples {
				duration = toneSamples
			}
			if err := session.sendDtmfPacket(code, false, duration, start, packet == 1); err != nil {
				d.fail(err)
				return
			}
		}

		// The END packets, back to back. See dtmfEndPacketCopies for why three and why not spaced.
		for copyIndex := 0; copyIndex < dtmfEndPacketCopies; copyIndex++ {
			if err := session.sendDtmfPacket(code, true, toneSamples, start, false); err != nil {
				d.fail(err)
				return
			}
		}
		d.sent.Add(1)

		// The gap is silence, not packets: RFC 4733 carries events, and an inter-digit interval is
		// the absence of one. The outbound clock still advances across it, so the next digit — or
		// the audio that resumes after the string — lands where the far end expects it.
		for tick := 0; tick < gapTicks; tick++ {
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
		// The leg was released or reaped mid-string. Not a failure of this injection: the
		// `session.ended` event carries the real story, and a digit sent into a closed socket would
		// be the noisier and less useful report.
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
// It shares the session's SSRC and sequence counter with the relay and with playback for the same
// reason those two share them: a digit is not a second stream, it is this leg's outbound audio
// carrying an event for a while. A separate SSRC would make the endpoint see a new sender start and
// stop around every keypress.
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
	if duration > 0xFFFF {
		duration = 0xFFFF
	}
	binary.BigEndian.PutUint16(payload[2:], uint16(duration))

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:     2,
			PayloadType: s.telephoneEventPayloadType,
			// The marker bit on the first packet of a digit is RFC 4733 §2.5.1.2's start-of-event
			// flag, and it is the one an IVR keys on: dropping it turns every keypress into one the
			// far end cannot detect, which is the same reason the relay preserves it.
			SequenceNumber: s.nextSequence(),
			Timestamp:      timestamp,
			SSRC:           s.SSRC,
			Marker:         marker,
		},
		Payload: payload,
	}

	encoded, err := out.Marshal()
	if err != nil {
		return fmt.Errorf("rtp: marshalling a DTMF packet: %w", err)
	}
	if _, err := s.ports.RTP.WriteToUDP(encoded, to); err != nil {
		// Unlike a relayed frame, a failed digit is NOT swallowed. A relay drops one frame of a
		// conversation that is still going; a digit that did not reach the socket is an IVR that
		// will not do what the caller asked, and there is nothing later to make up for it.
		return fmt.Errorf("rtp: sending a DTMF packet to %s: %w", to, err)
	}
	s.count(func(st *Stats) { st.PacketsSent++; st.DtmfPacketsSent++ })
	return nil
}

// dtmfActive reports whether a digit string currently owns this session's outbound stream.
func (s *Session) dtmfActive() bool { return s.dtmf.Load() != nil }
