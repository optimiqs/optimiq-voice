package rtp

import (
	"encoding/binary"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Rung 3's RECEIVE half of plans/mediad-design.md §2: decoding RFC 4733 digits out of what a leg
// SENDS us, so that an IVR, a voicemail PIN and a feature code work on this media plane.
//
// # A digit is many packets and exactly one event
//
// This is the whole difficulty, and it is the shape decision generation did not have. RFC 4733
// spreads ONE keypress over a stream of packets: an update every 20 ms while the tone lasts, each
// carrying the timestamp the digit STARTED at and a duration field that grows, and then a final
// packet with the END bit which §2.5.1.4 requires the sender to transmit THREE TIMES back to back.
// A detector that raised an event per packet would turn a 100 ms keypress into eight of them, and a
// `gather` collecting a four-digit PIN would fill on the first press. So the de-duplication lives
// here, below the wire contract, and `media.evt.v1.….dtmf.received` is the DIGIT.
//
// # The identity of a digit is its timestamp, not its marker bit
//
// Every packet of one digit shares the timestamp the digit began at; the next digit gets a new one.
// That makes the timestamp a per-digit identity that survives everything the network does to the
// packets, and it is why this detector never requires the marker bit to see a digit start. The
// marker is one bit on ONE packet — the first — so a detector keyed on it loses an entire keypress
// to a single lost datagram, and loses every keypress from a sender that forgets to set it (which
// is a real and common bug). The marker is therefore read for nothing at all here; the timestamp
// does the work.
//
// # Detection is a TAP
//
// The packet is still relayed to the peer, byte for byte, with the same header rewrite rung 2 built.
// A digit crossing a bridge is rung 2's DTMF-is-free property and it must survive this file: the far
// end of an attended transfer is entitled to hear the key the caller pressed. Detection ADDS an
// event; it consumes nothing. The event also fires whether or not the session is bridged, exactly as
// ARI's `ChannelDtmfReceived` fires on a channel that is in no bridge at all.

// DefaultDtmfMaxDigitDuration bounds one detected digit.
//
// It exists for the degenerate case: a sender that begins a digit and never ends it, because all
// three END copies were lost, or because it stopped sending altogether mid-tone. Without a bound
// that digit would sit in the detector forever and the keypress would never surface — the silent
// failure this design keeps rejecting.
//
// Five seconds is chosen from two constraints. It is far longer than any keypress a person makes
// (Asterisk's own inband detector calls anything past ~3 s a stuck tone), so a legitimate digit is
// never truncated by it; and it is comfortably inside the 8.19 s at which the 16-bit duration field
// wraps at 8 kHz, so a cut-off digit still carries a duration that means what it says.
const DefaultDtmfMaxDigitDuration = 5 * time.Second

// DtmfEndedBy records what closed a detected digit. It is diagnostic and does NOT travel on the
// wire: the contract carries the digit and its duration, which is what a consumer branches on, and
// adding a vocabulary the engine ignores would be two media planes agreeing on a shape for no
// reason. It is on the Go type because it is exactly what a log line and a test need.
type DtmfEndedBy string

const (
	// DtmfEndedByEndBit is the normal close: the packet carrying RFC 4733's E bit arrived.
	DtmfEndedByEndBit DtmfEndedBy = "end-bit"
	// DtmfEndedByNextDigit is a digit whose END never arrived, surfaced by the arrival of the NEXT
	// digit. This is the important recovery: a caller typing a PIN presses the next key within a few
	// hundred milliseconds, so the lost digit surfaces then rather than at the max-duration cutoff.
	DtmfEndedByNextDigit DtmfEndedBy = "next-digit"
	// DtmfEndedByMaxDuration is the cutoff. See DefaultDtmfMaxDigitDuration.
	DtmfEndedByMaxDuration DtmfEndedBy = "max-duration"
	// DtmfEndedBySessionEnded is a digit still open when the leg was released, reaped or drained.
	// The backstop for a far end that went silent mid-tone and never spoke again.
	DtmfEndedBySessionEnded DtmfEndedBy = "session-ended"
)

// DtmfDigit is one detected keypress — the unit the wire contract carries.
type DtmfDigit struct {
	// Digit is the key: "0"-"9", "*", "#" or "A"-"D".
	Digit string
	// DurationMs is how long the tone lasted as the SENDER measured it, converted from the
	// telephone-event duration field at the 8 kHz RTP clock.
	//
	// The sender's number and never a wall clock here, for the same reason the relay keeps the
	// timestamp it was handed: the duration is a property of somebody's finger on a key, and timing
	// it at this end would fold in the jitter of whatever network the packets crossed.
	DurationMs int
	// EndedBy is how the digit was closed. Diagnostic; see DtmfEndedBy.
	EndedBy DtmfEndedBy
}

// dtmfEventFlash is RFC 4733 §3.2's hook-flash event, and the first code above the keypad.
//
// Codes 0-15 are the sixteen DTMF keys; 16 is flash, and everything above it belongs to the tone
// tables in §4 which are a different vocabulary altogether. mediad drops them rather than inventing
// a character for them — a `gather` matching on the string would otherwise be handed something no
// dialplan can contain.
const dtmfEventFlash = 16

// DtmfDigitForEvent maps an RFC 4733 §3.2 event code back to its keypad character.
//
// The inverse of DtmfEventCode, and deliberately narrower: generation accepts lower-case a-d for a
// caller's convenience, detection emits upper case only, because the emitted value is compared
// against dialplan digits and two spellings of one key is a bug waiting for a lower-case phone.
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
// Length is checked rather than assumed: the payload type says what a packet CLAIMS to be, and this
// socket is open to the internet. A short payload is a malformed packet, not a digit.
//
// Longer than four bytes is accepted, because RFC 4733 §2.5.2.2 allows several events in one packet
// and some senders pad; only the first event is read, which is the one a DTMF keypad ever sends.
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
	// duration is the LARGEST duration field seen for this digit, not the latest.
	//
	// Largest, because RTP reorders: an update packet that overtakes another would otherwise make a
	// digit's reported length go backwards, and the duration field only ever grows at the sender.
	duration  uint32
	startedAt time.Time
	surfaced  bool
}

// dtmfDetector is one session's receive-side digit state machine.
//
// # What it remembers, and the reordering tolerance that buys
//
// Two timestamps: the digit currently arriving, and the one before it. That is the whole state, and
// it fixes the tolerance precisely — a packet reordered ANYWHERE inside its own digit is recognised
// and dropped, and so is one that arrives after the next digit has already started. A packet
// delayed past TWO digit boundaries is not, and would be read as a third digit.
//
// That is the right place to stop. Two digits apart is at minimum a tone plus an interdigit gap,
// which is on the order of 150-200 ms even from a fast typist, and no path that a call is still
// usable on reorders by that much — RTP reordering in the wild is a handful of packets, tens of
// milliseconds. Remembering more would mean a history whose size is a guess, to defend against a
// network on which the audio has already failed.
type dtmfDetector struct {
	maxDuration time.Duration

	// open is a lock-free gate for the packet path. Every received packet asks "is a digit open?"
	// so that the max-duration cutoff can be evaluated, and taking a mutex 50 times a second per
	// call to answer "no" for the whole life of most calls is the one cost worth avoiding here.
	open atomic.Bool

	mu sync.Mutex
	// current is the digit whose packets are arriving. It STAYS here after being surfaced, which is
	// what makes the second and third END copies recognisable rather than a new digit.
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

// observe feeds one telephone-event packet in and returns the digits it completed.
//
// Up to TWO, and the pair is real rather than defensive: a packet that both starts a new digit and
// carries the END bit closes the previous digit (whose own END was lost) and itself in one call.
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
		// A straggler from the digit before this one, delayed past a whole digit boundary. Its digit
		// has already been surfaced, so admitting it would publish a keypress twice.
		return out, 0
	}

	if d.hasCurrent && timestamp == d.current.timestamp {
		if d.current.surfaced {
			// THE DE-DUPLICATION. The second and third copies of the END packet land here, and so
			// does any update packet that was reordered behind the END. One keypress, one event.
			return out, 0
		}
		if event.duration > d.current.duration {
			d.current.duration = event.duration
		}
		switch {
		case event.end:
			out[count] = d.closeLocked(DtmfEndedByEndBit)
			count++
		case d.expiredLocked(now):
			// A sender still holding the tone open past the cutoff — a stuck key, or an endpoint
			// that has lost track of its own state machine. Surfaced now; every further packet of
			// it lands on the `surfaced` branch above and is dropped.
			out[count] = d.closeLocked(DtmfEndedByMaxDuration)
			count++
		}
		return out, count
	}

	// A new timestamp is a new digit, which is the interdigit boundary: this is how "11" is two
	// presses rather than one long one, and it needs no marker bit to see it.
	if d.hasCurrent && !d.current.surfaced {
		// The previous digit's END never arrived. Surfacing it HERE — rather than leaving it for the
		// cutoff — is what makes a PIN typed at human speed arrive as digits instead of pausing for
		// seconds on whichever one lost its END.
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
		// The END arrived before the updates it belongs to — reordering, or a sender whose whole
		// digit was one packet. Surfaced immediately, so the updates that follow it share this
		// timestamp, find it surfaced, and are dropped.
		out[count] = d.closeLocked(DtmfEndedByEndBit)
		count++
	}
	return out, count
}

// expire surfaces an open digit that has run past the cutoff, and is what a non-telephone-event
// packet asks on its way through.
//
// Driven by ARRIVING packets rather than by a timer, deliberately. A timer per digit is a goroutine
// and a clock to inject for a case that resolves itself: while the leg is still sending anything at
// all — the audio that resumes the moment a tone ends is the common case — the cutoff is evaluated
// within one frame of the deadline. A leg that has stopped sending ENTIRELY has bigger problems than
// an unreported digit, is torn down by the RTP timeout, and surfaces the digit on that path through
// Flush. Neither case needs a timer, and a timer in the packet path would be a real cost on every
// call to serve a case that only happens on a call already failing.
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

// closeLocked marks the current digit surfaced and renders it. Everything that publishes a digit
// goes through here, which is what makes "exactly once" a property of one line rather than of four
// call sites agreeing.
func (d *dtmfDetector) closeLocked(endedBy DtmfEndedBy) DtmfDigit {
	d.current.surfaced = true
	d.open.Store(false)
	return DtmfDigit{
		Digit:      d.current.digit,
		DurationMs: int(d.current.duration * 1000 / audio.SampleRate),
		EndedBy:    endedBy,
	}
}

// tapDtmf feeds one received packet to the detector and announces whatever it completed.
//
// Called on the session's own read goroutine, for every packet the session accepted, which is why
// the non-event branch is a lock-free atomic read: most packets on most calls are audio, and asking
// "is a digit open" must cost nothing when the answer has been no for the last four minutes.
func (s *Session) tapDtmf(packet *pionrtp.Packet, now time.Time) {
	if s.telephoneEventPayloadType == 0 || packet.PayloadType != s.telephoneEventPayloadType {
		// Audio, which is also the signal that a tone is over: the far end went back to sending
		// speech. It does not close the digit by itself — some endpoints do send both — but it is the
		// arrival that lets the max-duration cutoff be evaluated. See dtmfDetector.expire.
		if digit, ok := s.dtmfIn.expire(now); ok {
			s.announceDigit(digit)
		}
		return
	}

	s.count(func(st *Stats) { st.DtmfPacketsReceived++ })
	digits, n := s.dtmfIn.observe(packet.Payload, packet.Timestamp, now)
	for i := 0; i < n; i++ {
		s.announceDigit(digits[i])
	}
}

// FlushDtmf surfaces a digit that was still open when the session went away, exactly once.
//
// Called by the Manager on the teardown path, BEFORE the session-ended announcement, so a consumer
// that reacts to the leg ending has already been told about the keypress that was in flight when it
// did. A digit already surfaced by any other path is not re-announced — `closeLocked` is the single
// gate all four paths share.
func (s *Session) FlushDtmf() {
	if digit, ok := s.dtmfIn.Flush(); ok {
		s.announceDigit(digit)
	}
}

// announceDigit counts a completed keypress and hands it to the observer.
//
// Synchronous, on whichever goroutine detected the digit — the read loop, or a teardown. That is
// safe because the observer is an announcement whose publish is asynchronous, exactly as
// `session.ended` is: a JetStream round trip on the packet path would let a sick broker add latency
// to a live call, and a digit is the one media event with a person waiting on the other end of it.
func (s *Session) announceDigit(digit DtmfDigit) {
	s.count(func(st *Stats) { st.DtmfDigitsReceived++ })
	if digit.EndedBy != DtmfEndedByEndBit {
		// Every close that is not the END bit means packets were lost or a sender misbehaved, and
		// the digit still surfaced. Worth a line, because it is the only evidence that an IVR's
		// occasional slow response is the network rather than the IVR.
		s.log.Debug("a DTMF digit was closed without its END packet",
			"digit", digit.Digit, "durationMs", digit.DurationMs, "endedBy", string(digit.EndedBy))
	}

	// The recorder's terminator, checked HERE rather than in the recorder's own tick loop because
	// this is the one place a keypress exists as a keypress: the tick loop sees decoded audio frames,
	// and a `#` is not in them. It runs before the announcement so that a voicemail whose `#` both
	// ends the recording and reaches the orchestrator does those two things in the order a consumer
	// expects — the file is closing before the engine is told the caller pressed the key that closed
	// it.
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
