package rtp_test

import (
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The DTMF DETECTION suite drives real sockets, like every other packet-path suite here, because
// the thing under test is a property of the bytes: RFC 4733 spreads one keypress over many packets
// and the whole job is to answer with exactly one digit. A test against a mocked decoder would
// assert that a method was called, which is precisely the assertion that stays green when a
// retransmitted END packet publishes a second keypress.

// detectRig is one session with a far end, plus the lifecycle the packet path announces into.
type detectRig struct {
	manager   *rtp.Manager
	lifecycle *recordingLifecycle
	phone     *phone
	sessionID string
}

const (
	// The payload type this suite's far end sends digits under. Distinct from the de-facto 101 in
	// the relay test below, so a renumbering bug cannot pass by coincidence.
	detectTelephonePT = uint8(96)
	// detectSSRC is the far end's own synchronisation source. mediad never reflects it.
	detectSSRC = uint32(0x0BADCAFE)
)

func newDetectRig(t *testing.T, low, high int, maxDigit time.Duration) *detectRig {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	lifecycle := &recordingLifecycle{}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:            allocator,
		PublicAddr:           publicAddr,
		Lifecycle:            lifecycle,
		Logger:               slog.New(slog.NewTextHandler(io.Discard, nil)),
		DtmfMaxDigitDuration: maxDigit,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})

	const sessionID = "leg-detect"
	descriptor, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: sessionID, OrgID: testOrg, CallID: testCall,
		AudioPayloadType:          rtp.PayloadTypePCMU,
		TelephoneEventPayloadType: detectTelephonePT,
	})
	if err != nil {
		t.Fatalf("allocating the leg: %v", err)
	}

	return &detectRig{
		manager:   manager,
		lifecycle: lifecycle,
		phone:     newPhone(t, descriptor.RTPPort),
		sessionID: sessionID,
	}
}

// bridgedDetectRig is two bridged legs that negotiated DIFFERENT telephone-event types, plus the
// lifecycle both announce into. The type difference is deliberate: 96 and 101 are both common, and
// the relay's renumbering is the reason a digit survives a bridge between two phones that chose
// differently — which detection must not disturb.
type bridgedDetectRig struct {
	manager   *rtp.Manager
	lifecycle *recordingLifecycle
	aPhone    *phone
	bPhone    *phone
	aID       string
	bID       string
}

func newBridgedDetectRig(t *testing.T, low, high int) *bridgedDetectRig {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	lifecycle := &recordingLifecycle{}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Lifecycle:  lifecycle,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})

	const aID, bID = "leg-a", "leg-b"
	a, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: aID, OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU, TelephoneEventPayloadType: 96,
	})
	if err != nil {
		t.Fatalf("allocating leg A: %v", err)
	}
	b, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: bID, OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU, TelephoneEventPayloadType: 101,
	})
	if err != nil {
		t.Fatalf("allocating leg B: %v", err)
	}

	rig := &bridgedDetectRig{
		manager:   manager,
		lifecycle: lifecycle,
		aPhone:    newPhone(t, a.RTPPort),
		bPhone:    newPhone(t, b.RTPPort),
		aID:       aID,
		bID:       bID,
	}

	// Both legs must latch before there is anywhere to relay to. These packets arrive before the
	// bridge exists, so neither is forwarded and nothing is left in flight for the digit assertions.
	rig.aPhone.send(t, audioPacket(1000, 1))
	rig.bPhone.send(t, audioPacket(2000, 1))
	waitFor(t, "both legs to latch onto their far ends", func() bool {
		aSession, aok := manager.Get(aID)
		bSession, bok := manager.Get(bID)
		return aok && bok && aSession.Remote() != nil && bSession.Remote() != nil
	})
	if err := manager.Bridge("bridge-detect", aID, bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	return rig
}

// telephoneEventPacket builds one RFC 4733 packet the way a phone sends it.
func telephoneEventPacket(
	payloadType uint8,
	event byte,
	end bool,
	duration uint16,
	timestamp uint32,
	sequence uint16,
	marker bool,
) pionrtp.Packet {
	payload := make([]byte, 4)
	payload[0] = event
	payload[1] = 10
	if end {
		payload[1] |= 0x80
	}
	binary.BigEndian.PutUint16(payload[2:], duration)
	return pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    payloadType,
			SequenceNumber: sequence,
			Timestamp:      timestamp,
			SSRC:           detectSSRC,
			Marker:         marker,
		},
		Payload: payload,
	}
}

// audioPacket is a G.711 frame, the thing a leg sends when nobody is pressing anything.
func audioPacket(timestamp uint32, sequence uint16) pionrtp.Packet {
	return pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    rtp.PayloadTypePCMU,
			SequenceNumber: sequence,
			Timestamp:      timestamp,
			SSRC:           detectSSRC,
		},
		Payload: make([]byte, 160),
	}
}

// pressDigit sends one whole keypress as RFC 4733 specifies it: a marked first packet, an update
// every 20 ms while the tone lasts, then the END packet three times back to back.
func pressDigit(t *testing.T, p *phone, event byte, timestamp uint32, sequence uint16, frames int) {
	t.Helper()
	for frame := 1; frame <= frames; frame++ {
		p.send(t, telephoneEventPacket(detectTelephonePT, event, false,
			uint16(frame*160), timestamp, sequence+uint16(frame)-1, frame == 1))
	}
	for copyIndex := 0; copyIndex < 3; copyIndex++ {
		p.send(t, telephoneEventPacket(detectTelephonePT, event, true,
			uint16(frames*160), timestamp, sequence+uint16(frames+copyIndex), false))
	}
}

func waitForDigits(t *testing.T, rig *detectRig, want int) []rtp.DtmfDigit {
	t.Helper()
	waitFor(t, "the packet path to surface a digit", func() bool {
		return len(rig.lifecycle.detectedDigits()) >= want
	})
	// A moment past the last expected digit, so a suite asserting "exactly one" fails on a
	// duplicate rather than racing it.
	time.Sleep(50 * time.Millisecond)
	return rig.lifecycle.detectedDigits()
}

// The de-duplication, and the reason this rung has a shape decision attached at all.
//
// RFC 4733 §2.5.1.4 makes the sender transmit the END packet THREE times back to back, because
// losing the only packet that says a digit is over leaves the far end holding a tone open until its
// own timeout. A detector that published per packet would turn this single keypress into eight
// events, and a `gather` collecting a four-digit PIN would fill on the first press.
func TestDtmfDetectionSurfacesOneDigitUnderEndRetransmission(t *testing.T) {
	rig := newDetectRig(t, 58000, 58019, 0)

	pressDigit(t, rig.phone, 5, 160_000, 100, 3)

	digits := waitForDigits(t, rig, 1)
	if len(digits) != 1 {
		t.Fatalf("one keypress produced %d events: %+v", len(digits), digits)
	}
	if digits[0].Digit != "5" {
		t.Errorf("digit = %q, want 5", digits[0].Digit)
	}
	// Three 20 ms frames, as the sender's own duration field claimed. Never a wall clock at this
	// end, which would fold the network's jitter into a number describing somebody's finger.
	if digits[0].DurationMs != 60 {
		t.Errorf("durationMs = %d, want 60", digits[0].DurationMs)
	}
	if digits[0].EndedBy != rtp.DtmfEndedByEndBit {
		t.Errorf("endedBy = %q, want end-bit", digits[0].EndedBy)
	}

	// The ratio is the diagnostic: six packets in, one keypress out. Equal numbers would mean the
	// de-duplication is not running, which is otherwise only visible as an IVR that answers a menu
	// before the caller has finished pressing.
	session, ok := rig.manager.Get(rig.sessionID)
	if !ok {
		t.Fatal("the session went away")
	}
	stats := session.Stats()
	if stats.DtmfPacketsReceived != 6 || stats.DtmfDigitsReceived != 1 {
		t.Errorf("packets/digits = %d/%d, want 6/1",
			stats.DtmfPacketsReceived, stats.DtmfDigitsReceived)
	}
}

// Two presses of the SAME key, which is the case a detector keyed on anything but the timestamp
// gets wrong: "11" is two digits, and the only thing on the wire that says so is that the second
// press carries a new start timestamp.
func TestDtmfDetectionSeparatesTwoDigitsByTimestamp(t *testing.T) {
	rig := newDetectRig(t, 58020, 58039, 0)

	pressDigit(t, rig.phone, 1, 160_000, 100, 3)
	pressDigit(t, rig.phone, 1, 161_600, 200, 5)

	digits := waitForDigits(t, rig, 2)
	if len(digits) != 2 {
		t.Fatalf("two keypresses produced %d events: %+v", len(digits), digits)
	}
	if digits[0].Digit != "1" || digits[1].Digit != "1" {
		t.Errorf("digits = %q, %q, want 1, 1", digits[0].Digit, digits[1].Digit)
	}
	if digits[0].DurationMs != 60 || digits[1].DurationMs != 100 {
		t.Errorf("durations = %d, %d ms, want 60, 100",
			digits[0].DurationMs, digits[1].DurationMs)
	}
}

// A digit whose END never arrives, closed by the arrival of the NEXT one.
//
// This is the recovery that matters in practice, and it is why the cutoff is a backstop rather than
// the mechanism: somebody typing a PIN presses the next key within a few hundred milliseconds, so a
// lost END costs nothing at all rather than costing the max-duration wait.
func TestDtmfDetectionClosesADigitWhoseEndWasLostOnTheNextDigit(t *testing.T) {
	rig := newDetectRig(t, 58040, 58059, 0)

	// Digit 7: three update packets and no END at all — every copy lost.
	for frame := 1; frame <= 3; frame++ {
		rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 7, false,
			uint16(frame*160), 160_000, uint16(100+frame), frame == 1))
	}
	pressDigit(t, rig.phone, 8, 161_600, 200, 3)

	digits := waitForDigits(t, rig, 2)
	if len(digits) != 2 {
		t.Fatalf("want two digits, got %d: %+v", len(digits), digits)
	}
	if digits[0].Digit != "7" || digits[0].EndedBy != rtp.DtmfEndedByNextDigit {
		t.Errorf("first digit = %q ended by %q, want 7 ended by next-digit",
			digits[0].Digit, digits[0].EndedBy)
	}
	if digits[1].Digit != "8" || digits[1].EndedBy != rtp.DtmfEndedByEndBit {
		t.Errorf("second digit = %q ended by %q, want 8 ended by end-bit",
			digits[1].Digit, digits[1].EndedBy)
	}
}

// The degenerate case: a tone that begins and never ends, with the leg still sending audio.
//
// Without the cutoff that keypress would sit in the detector for the life of the call and the
// caller would be told nothing — the silent failure this design keeps rejecting. It surfaces ONCE,
// and every further packet of that digit lands on the already-surfaced branch.
func TestDtmfDetectionSurfacesADigitWithNoEndAtTheCutoff(t *testing.T) {
	const maxDigit = 40 * time.Millisecond
	rig := newDetectRig(t, 58060, 58079, maxDigit)

	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 9, false, 160, 160_000, 100, true))
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 9, false, 320, 160_000, 101, false))

	// The cutoff is evaluated on ARRIVING packets rather than by a timer per digit: the audio a leg
	// resumes the moment a tone ends is what carries the evaluation, so it lands within one frame of
	// the deadline without a goroutine per keypress.
	time.Sleep(2 * maxDigit)
	rig.phone.send(t, audioPacket(161_000, 102))

	digits := waitForDigits(t, rig, 1)
	if len(digits) != 1 {
		t.Fatalf("want exactly one digit, got %d: %+v", len(digits), digits)
	}
	if digits[0].Digit != "9" || digits[0].EndedBy != rtp.DtmfEndedByMaxDuration {
		t.Errorf("digit = %q ended by %q, want 9 ended by max-duration",
			digits[0].Digit, digits[0].EndedBy)
	}
	// The duration the SENDER last claimed, not the wall clock the cutoff used. Saying 40 ms because
	// that is how long we waited would be reporting our own timer as somebody's keypress.
	if digits[0].DurationMs != 40 {
		t.Errorf("durationMs = %d, want 40", digits[0].DurationMs)
	}

	// And more audio does not produce a second one.
	rig.phone.send(t, audioPacket(161_160, 103))
	time.Sleep(50 * time.Millisecond)
	if got := rig.lifecycle.detectedDigits(); len(got) != 1 {
		t.Errorf("the cutoff fired more than once: %+v", got)
	}
}

// The END packet overtaking the updates it belongs to, which is ordinary RTP reordering.
//
// The digit is surfaced on the END, and the updates that arrive after it share its timestamp, find
// it surfaced and are dropped — the same branch the two END retransmissions land on. A detector
// that required the updates first would publish the digit twice.
func TestDtmfDetectionToleratesAnEndReorderedAheadOfItsUpdates(t *testing.T) {
	rig := newDetectRig(t, 58080, 58099, 0)

	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 3, true, 480, 160_000, 103, false))
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 3, false, 160, 160_000, 100, true))
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 3, false, 320, 160_000, 101, false))
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 3, false, 480, 160_000, 102, false))

	digits := waitForDigits(t, rig, 1)
	if len(digits) != 1 {
		t.Fatalf("a reordered END produced %d events: %+v", len(digits), digits)
	}
	if digits[0].Digit != "3" || digits[0].DurationMs != 60 {
		t.Errorf("digit = %q for %d ms, want 3 for 60", digits[0].Digit, digits[0].DurationMs)
	}
}

// A packet delayed past a whole digit boundary. The detector remembers one digit back, which is
// what stops a straggler from being read as a third press of the same key.
func TestDtmfDetectionDropsAStragglerFromThePreviousDigit(t *testing.T) {
	rig := newDetectRig(t, 58100, 58119, 0)

	pressDigit(t, rig.phone, 4, 160_000, 100, 3)
	pressDigit(t, rig.phone, 6, 161_600, 200, 3)
	// An update packet from the FIRST digit, arriving after the second has been and gone.
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 4, false, 320, 160_000, 101, false))

	digits := waitForDigits(t, rig, 2)
	if len(digits) != 2 {
		t.Fatalf("want two digits, got %d: %+v", len(digits), digits)
	}
	if digits[0].Digit != "4" || digits[1].Digit != "6" {
		t.Errorf("digits = %q, %q, want 4, 6", digits[0].Digit, digits[1].Digit)
	}
}

// The marker bit is not required, and losing it must not cost a keypress.
//
// It is one bit on ONE packet, so a detector keyed on it loses a whole digit to a single lost
// datagram and every digit from a sender that forgets to set it. The timestamp is the identity.
func TestDtmfDetectionDoesNotNeedTheMarkerBit(t *testing.T) {
	rig := newDetectRig(t, 58120, 58139, 0)

	// No marker anywhere, and the first update packet lost as well.
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 2, false, 320, 160_000, 101, false))
	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 2, true, 320, 160_000, 102, false))

	digits := waitForDigits(t, rig, 1)
	if len(digits) != 1 || digits[0].Digit != "2" {
		t.Fatalf("want one digit 2, got %+v", digits)
	}
}

// Events above the keypad are not digits, and inventing a character for them would hand a `gather`
// something no dialplan can contain. 16 is RFC 4733's hook flash.
func TestDtmfDetectionIgnoresNonKeypadEvents(t *testing.T) {
	rig := newDetectRig(t, 58140, 58159, 0)

	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 16, true, 320, 160_000, 100, true))
	// A payload too short to be a telephone-event at all. The payload type says what a packet
	// CLAIMS to be, and this socket is open to the internet.
	rig.phone.send(t, pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: detectTelephonePT,
			SequenceNumber: 101, Timestamp: 160_000, SSRC: detectSSRC,
		},
		Payload: []byte{0x01, 0x02},
	})
	// A real digit behind them, so the assertion is "those two produced nothing" rather than
	// "nothing had happened yet".
	pressDigit(t, rig.phone, 0, 161_600, 200, 2)

	digits := waitForDigits(t, rig, 1)
	if len(digits) != 1 || digits[0].Digit != "0" {
		t.Fatalf("want only the real digit 0, got %+v", digits)
	}
}

// A leg that begins a tone and stops sending entirely. The arrival-driven cutoff never fires
// because nothing arrives, so the teardown is the backstop — and it surfaces the keypress BEFORE
// the session-ended the engine tears the leg down on.
func TestDtmfDetectionFlushesAnOpenDigitWhenTheSessionEnds(t *testing.T) {
	rig := newDetectRig(t, 58160, 58179, 0)

	rig.phone.send(t, telephoneEventPacket(detectTelephonePT, 11, false, 480, 160_000, 100, true))
	waitFor(t, "the session to latch onto its far end", func() bool {
		session, ok := rig.manager.Get(rig.sessionID)
		return ok && session.Stats().DtmfPacketsReceived == 1
	})

	rig.manager.Release(rig.sessionID)

	digits := rig.lifecycle.detectedDigits()
	if len(digits) != 1 {
		t.Fatalf("want one flushed digit, got %+v", digits)
	}
	if digits[0].Digit != "#" || digits[0].EndedBy != rtp.DtmfEndedBySessionEnded {
		t.Errorf("digit = %q ended by %q, want # ended by session-ended",
			digits[0].Digit, digits[0].EndedBy)
	}
}

// DETECTION IS A TAP, AND THIS IS THE ASSERTION THAT SAYS SO.
//
// Rung 2 made DTMF free across a bridge: a telephone-event payload is just bytes to a relay, and
// the header rewrite renumbers the payload type between two legs that negotiated differently.
// Rung 3's receive half must not take that away — the far end of an attended transfer is entitled
// to hear the key the caller pressed — so the packets keep flowing to the peer byte for byte WHILE
// the engine is told a digit was pressed. Both halves are asserted here, in one test, because
// either one alone would stay green if the tap became a consumption.
func TestDtmfDetectionTapsWithoutConsumingTheRelayedPackets(t *testing.T) {
	rig := newBridgedDetectRig(t, 58180, 58199)

	const frames = 3
	for frame := 1; frame <= frames; frame++ {
		rig.aPhone.send(t, telephoneEventPacket(96, 7, false,
			uint16(frame*160), 160_000, uint16(100+frame), frame == 1))
	}
	for copyIndex := 0; copyIndex < 3; copyIndex++ {
		rig.aPhone.send(t, telephoneEventPacket(96, 7, true,
			uint16(frames*160), 160_000, uint16(104+copyIndex), false))
	}

	// The relay half: every one of the six packets reaches leg B, payload byte for byte, marker
	// intact on the first, and renumbered from A's 96 to B's 101.
	var relayed []pionrtp.Packet
	for len(relayed) < 6 {
		packet, ok := rig.bPhone.receive(t)
		if !ok {
			break
		}
		relayed = append(relayed, packet)
	}
	if len(relayed) != 6 {
		t.Fatalf("the relay forwarded %d of 6 telephone-event packets; detection consumed some",
			len(relayed))
	}
	if !relayed[0].Marker {
		t.Error("the start-of-digit marker did not survive the relay")
	}
	for index, packet := range relayed {
		if packet.PayloadType != 101 {
			t.Errorf("relayed packet %d carried PT %d, want leg B's negotiated 101",
				index, packet.PayloadType)
		}
		if packet.Timestamp != 160_000 {
			t.Errorf("relayed packet %d carried timestamp %d, want the sender's 160000",
				index, packet.Timestamp)
		}
		event := decodeTelephoneEvent(t, packet)
		if event.event != 7 {
			t.Errorf("relayed packet %d carried event %d, want 7", index, event.event)
		}
	}
	if !decodeTelephoneEvent(t, relayed[5]).end {
		t.Error("the third END copy did not reach the far end")
	}

	// The detection half: exactly one keypress on leg A, from the same six packets.
	waitFor(t, "the digit to be announced", func() bool {
		return len(rig.lifecycle.detectedDigits()) >= 1
	})
	time.Sleep(50 * time.Millisecond)
	digits := rig.lifecycle.detectedDigits()
	if len(digits) != 1 {
		t.Fatalf("the tap announced %d digits for one keypress: %+v", len(digits), digits)
	}
	if digits[0].Digit != "7" || digits[0].DurationMs != 60 {
		t.Errorf("digit = %q for %d ms, want 7 for 60", digits[0].Digit, digits[0].DurationMs)
	}
}

// The event codes are RFC 4733 §3.2 and they are not arbitrary: the sender looks the key up in the
// same table, so an off-by-one is a caller who pressed 8 and an IVR that heard 9.
func TestDtmfDigitForEventCoversTheKeypadAndNothingElse(t *testing.T) {
	for code, want := range map[byte]string{
		0: "0", 5: "5", 9: "9", 10: "*", 11: "#", 12: "A", 15: "D",
	} {
		got, ok := rtp.DtmfDigitForEvent(code)
		if !ok || got != want {
			t.Errorf("DtmfDigitForEvent(%d) = %q, %v, want %q, true", code, got, ok, want)
		}
	}
	for _, code := range []byte{16, 17, 40, 255} {
		if got, ok := rtp.DtmfDigitForEvent(code); ok {
			t.Errorf("DtmfDigitForEvent(%d) = %q, true; codes above the keypad are not digits",
				code, got)
		}
	}
}
