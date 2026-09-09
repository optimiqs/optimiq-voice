package rtp

import (
	"encoding/binary"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Decoding RFC 4733 digits out of what a leg sends us.
//
// One keypress is many packets and exactly one event: RFC 4733 spreads a digit over an update every
// 20 ms plus three back-to-back END copies (§2.5.1.4), so the de-duplication lives here and the
// published event is the DIGIT.
//
// A digit's identity is its timestamp, not its marker bit: every packet of one digit shares the
// timestamp it began at. Keying on the marker would lose a whole keypress to one lost datagram, or
// to a sender that never sets it, so the marker is not read at all.
//
// Detection is a tap: the packet is still relayed to the peer byte for byte, and the event fires
// whether or not the session is bridged.

// DefaultDtmfMaxDigitDuration bounds one detected digit, for a sender that begins a digit and never
// ends it. Five seconds is longer than any human keypress and inside the 8.19 s at which the 16-bit
// duration field wraps at 8 kHz, so a cut-off digit still carries a meaningful duration.
const DefaultDtmfMaxDigitDuration = 5 * time.Second

// DtmfEndedBy records what closed a detected digit. Diagnostic only; it does not travel on the wire.
type DtmfEndedBy string

const (
	// DtmfEndedByEndBit is the normal close: the packet carrying RFC 4733's E bit arrived.
	DtmfEndedByEndBit DtmfEndedBy = "end-bit"
	// DtmfEndedByNextDigit is a digit whose END never arrived, surfaced by the arrival of the next
	// digit — which is far sooner than the max-duration cutoff.
	DtmfEndedByNextDigit DtmfEndedBy = "next-digit"
	// DtmfEndedByMaxDuration is the cutoff. See DefaultDtmfMaxDigitDuration.
	DtmfEndedByMaxDuration DtmfEndedBy = "max-duration"
	// DtmfEndedBySessionEnded is a digit still open when the leg was released, reaped or drained.
	DtmfEndedBySessionEnded DtmfEndedBy = "session-ended"
)

// DtmfDigit is one detected keypress — the unit the wire contract carries.
type DtmfDigit struct {
	// Digit is the key: "0"-"9", "*", "#" or "A"-"D".
	Digit string
	// DurationMs is how long the tone lasted as the sender measured it, converted from the
	// telephone-event duration field at the 8 kHz RTP clock. Never a local wall clock: that would
	// fold in the jitter of whatever network the packets crossed.
	DurationMs int
	// EndedBy is how the digit was closed. Diagnostic; see DtmfEndedBy.
	EndedBy DtmfEndedBy
}

// dtmfEventFlash is RFC 4733 §3.2's hook-flash event, the first code above the keypad. Codes 0-15
// are the sixteen DTMF keys; 16 and above are dropped rather than given an invented character.
const dtmfEventFlash = 16

// DtmfDigitForEvent maps an RFC 4733 §3.2 event code back to its keypad character.
//
// The inverse of DtmfEventCode, and deliberately narrower: it emits upper case only, because the
// value is compared against dialplan digits and two spellings of one key is a bug.
func DtmfDigitForEvent(code byte) (string, bool) {
	switch {
	case code <= 9:
		return string(rune('0' + code)), true
	case code == dtmfEventStar:
		return "*", true
	case code == dtmfEventPound:
		return "#", true
	case code < dtmfEventFlash:
		return string(rune('A' + (code - dtmfEventA))), true
	default:
		return "", false
	}
}

// telephoneEventPayload is one RFC 4733 payload, unpacked.
type telephoneEventPayload struct {
	event    byte
	end      bool
	duration uint32
}

// parseTelephoneEvent unpacks a telephone-event payload, reporting whether it is one at all.
//
// Length is checked rather than assumed: this socket is open to the internet, and a short payload is
// a malformed packet. Longer than four bytes is accepted — RFC 4733 §2.5.2.2 allows several events
// in one packet and some senders pad — and only the first event is read.
func parseTelephoneEvent(payload []byte) (telephoneEventPayload, bool) {
	if len(payload) < dtmfPayloadBytes {
		return telephoneEventPayload{}, false
	}
	return telephoneEventPayload{
		event:    payload[0],
		end:      payload[1]&0x80 != 0,
		duration: uint32(binary.BigEndian.Uint16(payload[2:4])),
	}, true
}

// inflightDigit is the digit whose packets are currently arriving, or the one just surfaced.
type inflightDigit struct {
	digit     string
	timestamp uint32
	// duration is the largest duration field seen for this digit, not the latest: RTP reorders, and
	// the field only ever grows at the sender.
	duration  uint32
	startedAt time.Time
	surfaced  bool
}

// dtmfDetector is one session's receive-side digit state machine.
//
// It remembers two timestamps — the digit currently arriving and the one before it — which fixes the
// reordering tolerance: a packet reordered anywhere inside its own digit, or arriving after the next
// digit started, is recognised and dropped. One delayed past two digit boundaries (150-200 ms, far
// beyond real-world RTP reordering) would be read as a third digit.
type dtmfDetector struct {
	maxDuration time.Duration

	// open is a lock-free gate for the packet path: every received packet asks "is a digit open?",
	// and that must not take a mutex 50 times a second per call to answer "no".
	open atomic.Bool

	mu sync.Mutex
	// current is the digit whose packets are arriving. It stays here after being surfaced, which
	// makes the second and third END copies recognisable rather than a new digit.
	current    inflightDigit
	hasCurrent bool
	// previous is the timestamp of the digit before `current`. See the type doc.
	previous    uint32
	hasPrevious bool
}

func newDtmfDetector(maxDuration time.Duration) *dtmfDetector {
	if maxDuration <= 0 {
		maxDuration = DefaultDtmfMaxDigitDuration
	}
	return &dtmfDetector{maxDuration: maxDuration}
}

// observe feeds one telephone-event packet in and returns the digits it completed. Up to two: a
// packet that both starts a new digit and carries the END bit closes the previous digit (whose own
// END was lost) and itself in one call.
func (d *dtmfDetector) observe(payload []byte, timestamp uint32, now time.Time) ([2]DtmfDigit, int) {
	var out [2]DtmfDigit
	count := 0

	event, ok := parseTelephoneEvent(payload)
	if !ok {
		return out, 0
	}
	digit, ok := DtmfDigitForEvent(event.event)
	if !ok {
		return out, 0
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	if d.hasPrevious && timestamp == d.previous {
		// A straggler from the digit before this one, already surfaced; admitting it would publish
		// a keypress twice.
		return out, 0
	}

	if d.hasCurrent && timestamp == d.current.timestamp {
		if d.current.surfaced {
			// The de-duplication: the second and third END copies land here, as does any update
			// packet reordered behind the END. One keypress, one event.
			return out, 0
		}
		d.current.duration = max(d.current.duration, event.duration)
		switch {
		case event.end:
			out[count] = d.closeLocked(DtmfEndedByEndBit)
			count++
		case d.expiredLocked(now):
			// A sender still holding the tone open past the cutoff. Surfaced now; every further
			// packet of it lands on the `surfaced` branch above and is dropped.
			out[count] = d.closeLocked(DtmfEndedByMaxDuration)
			count++
		}
		return out, count
	}

	// A new timestamp is a new digit, which is the interdigit boundary: this is how "11" is two
	// presses rather than one long one, and it needs no marker bit to see it.
	if d.hasCurrent && !d.current.surfaced {
		// The previous digit's END never arrived. Surfacing it here rather than at the cutoff is
		// what makes a PIN typed at human speed arrive as digits instead of stalling for seconds.
		out[count] = d.closeLocked(DtmfEndedByNextDigit)
		count++
	}
	d.rotateLocked()
	d.current = inflightDigit{
		digit:     digit,
		timestamp: timestamp,
		duration:  event.duration,
		startedAt: now,
	}
	d.hasCurrent = true
	d.open.Store(true)

	if event.end {
		// The END arrived before the updates it belongs to. Surfaced immediately, so the updates
		// that follow share this timestamp, find it surfaced, and are dropped.
		out[count] = d.closeLocked(DtmfEndedByEndBit)
		count++
	}
	return out, count
}

// expire surfaces an open digit that has run past the cutoff, and is what a non-telephone-event
// packet asks on its way through.
//
// Driven by arriving packets rather than a timer: while the leg is still sending anything the cutoff
// is evaluated within one frame of the deadline, and a leg that stopped sending entirely is torn
// down by the RTP timeout, which surfaces the digit through Flush.
func (d *dtmfDetector) expire(now time.Time) (DtmfDigit, bool) {
	if !d.open.Load() {
		return DtmfDigit{}, false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.hasCurrent || d.current.surfaced || !d.expiredLocked(now) {
		return DtmfDigit{}, false
	}
	return d.closeLocked(DtmfEndedByMaxDuration), true
}

// Flush surfaces a digit that was still open when the session went away. Idempotent, because the
// digit is marked surfaced by the same gate every other path uses.
func (d *dtmfDetector) Flush() (DtmfDigit, bool) {
	if !d.open.Load() {
		return DtmfDigit{}, false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.hasCurrent || d.current.surfaced {
		return DtmfDigit{}, false
	}
	return d.closeLocked(DtmfEndedBySessionEnded), true
}

func (d *dtmfDetector) expiredLocked(now time.Time) bool {
	return now.Sub(d.current.startedAt) >= d.maxDuration
}

// closeLocked marks the current digit surfaced and renders it. Every path that publishes a digit
// goes through here, which is what makes "exactly once" a property of one place.
func (d *dtmfDetector) closeLocked(endedBy DtmfEndedBy) DtmfDigit {
	d.current.surfaced = true
	d.open.Store(false)
	return DtmfDigit{
		Digit:      d.current.digit,
		DurationMs: int(d.current.duration * 1000 / audio.SampleRate),
		EndedBy:    endedBy,
	}
}

// tapDtmf feeds one received packet to the detector and announces whatever it completed. Called on
// the session's read goroutine for every accepted packet, which is why the non-event branch is a
// lock-free atomic read.
func (s *Session) tapDtmf(packet *pionrtp.Packet, now time.Time) {
	if tePT := s.TelephoneEventPayloadType(); tePT == 0 || packet.PayloadType != tePT {
		// Audio does not close a digit by itself — some endpoints send both — but its arrival is
		// what lets the max-duration cutoff be evaluated. See dtmfDetector.expire.
		if digit, ok := s.dtmfIn.expire(now); ok {
			s.announceDigit(digit)
		}
		return
	}

	s.count(func(st *Stats) { st.DtmfPacketsReceived++ })
	digits, n := s.dtmfIn.observe(packet.Payload, packet.Timestamp, now)
	for i := range n {
		s.announceDigit(digits[i])
	}
}

// FlushDtmf surfaces a digit that was still open when the session went away, exactly once.
//
// Called by the Manager on the teardown path, before the session-ended announcement, so a consumer
// reacting to the leg ending has already heard about the keypress in flight when it happened.
func (s *Session) FlushDtmf() {
	if digit, ok := s.dtmfIn.Flush(); ok {
		s.announceDigit(digit)
	}
}

// announceDigit counts a completed keypress and hands it to the observer.
//
// Synchronous, on whichever goroutine detected the digit; safe because the observer's publish is
// itself asynchronous. A broker round trip on the packet path would add latency to a live call.
func (s *Session) announceDigit(digit DtmfDigit) {
	s.count(func(st *Stats) { st.DtmfDigitsReceived++ })
	if digit.EndedBy != DtmfEndedByEndBit {
		// A close that is not the END bit means packets were lost or a sender misbehaved.
		s.log.Debug("a DTMF digit was closed without its END packet",
			"digit", digit.Digit, "durationMs", digit.DurationMs, "endedBy", string(digit.EndedBy))
	}

	// The recorder's terminator, checked here because this is the one place a keypress exists as a
	// keypress — the recorder's tick loop only sees decoded audio. It runs before the announcement
	// so the file is closing before the engine is told which key closed it.
	if recorder := s.recording.Load(); recorder != nil && recorder.terminateOn(digit.Digit) {
		s.log.Debug("a recording was terminated by a digit",
			"digit", digit.Digit, "recordingRef", recorder.Ref())
	}

	if s.onDtmf != nil {
		s.onDtmf(s, digit)
	}
}

// rotateLocked moves the current digit's timestamp into the one-deep history.
func (d *dtmfDetector) rotateLocked() {
	if d.hasCurrent {
		d.previous = d.current.timestamp
		d.hasPrevious = true
	}
}
