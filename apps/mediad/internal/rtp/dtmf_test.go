package rtp_test

import (
	"encoding/binary"
	"errors"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The DTMF suite drives REAL sockets and a hand-driven clock, for the same reasons the playback
// suite does: a digit is four bytes with a header on them at a defined cadence, and a test that
// asserted a method was called would stay green with the E bit in the wrong place.

// The three fields of an RFC 4733 payload, pulled back out of the wire bytes.
type telephoneEvent struct {
	event    byte
	end      bool
	volume   byte
	duration uint16
}

func decodeTelephoneEvent(t *testing.T, packet pionrtp.Packet) telephoneEvent {
	t.Helper()
	if len(packet.Payload) != 4 {
		t.Fatalf("a telephone-event payload is 4 bytes, got %d", len(packet.Payload))
	}
	return telephoneEvent{
		event:    packet.Payload[0],
		end:      packet.Payload[1]&0x80 != 0,
		volume:   packet.Payload[1] & 0x3F,
		duration: binary.BigEndian.Uint16(packet.Payload[2:]),
	}
}

// sendDigits starts an injection with the default 100 ms tone and no gap, so a test steps exactly
// the tone packets it is asserting on.
func sendDigits(t *testing.T, rig *playbackRig, sessionID, digits string) {
	t.Helper()
	err := rig.manager.SendDtmf(sessionID, rtp.DtmfOptions{
		Digits:       digits,
		ToneDuration: 100 * time.Millisecond,
		Gap:          -1,
	})
	if err != nil {
		t.Fatalf("SendDtmf: %v", err)
	}
}

func TestDtmfEventCodesCoverEveryKeypadSymbol(t *testing.T) {
	// The codes are RFC 4733 §3.2 and they are not arbitrary: a receiver looks the number up in the
	// same table, so an off-by-one here is a caller who pressed 8 and an IVR that heard 9.
	for digit, want := range map[rune]byte{
		'0': 0, '5': 5, '9': 9, '*': 10, '#': 11, 'A': 12, 'D': 15, 'b': 13,
	} {
		code, err := rtp.DtmfEventCode(digit)
		if err != nil {
			t.Errorf("DtmfEventCode(%q): %v", string(digit), err)
			continue
		}
		if code != want {
			t.Errorf("DtmfEventCode(%q) = %d, want %d", string(digit), code, want)
		}
	}
}

func TestDtmfValidatesTheWholeStringBeforeSendingAnything(t *testing.T) {
	// Failing halfway would leave a far-end IVR holding a prefix of what was asked for, under a
	// reply that said the request succeeded.
	if _, err := rtp.ValidateDigits("12X4"); !errors.Is(err, rtp.ErrUnsendableDigit) {
		t.Errorf("ValidateDigits(12X4) error = %v, want ErrUnsendableDigit", err)
	}
	codes, err := rtp.ValidateDigits("1*A")
	if err != nil {
		t.Fatalf("ValidateDigits: %v", err)
	}
	if len(codes) != 3 || codes[0] != 1 || codes[1] != 10 || codes[2] != 12 {
		t.Errorf("ValidateDigits(1*A) = %v, want [1 10 12]", codes)
	}
}

func TestDtmfSendsOneDigitAsAGrowingEventWithThreeEndPackets(t *testing.T) {
	rig := newPlaybackRig(t, 57400, 57419)
	rig.latch(t)
	sendDigits(t, rig, rig.aID, "5")

	// 100 ms of tone is five 20 ms packets, and each one reports the duration SO FAR: that growing
	// number is how a receiver reconstructs one tone from several packets, and a constant one would
	// make every digit look 20 ms long.
	var first pionrtp.Packet
	for index := 1; index <= 5; index++ {
		rig.tick(t)
		packet, ok := rig.aPhone.receive(t)
		if !ok {
			t.Fatalf("tone packet %d never arrived", index)
		}
		if index == 1 {
			first = packet
		}
		event := decodeTelephoneEvent(t, packet)

		if packet.PayloadType != rtp.PayloadTypeTelephoneEvent {
			t.Errorf("packet %d payload type = %d, want the leg's negotiated telephone-event type %d",
				index, packet.PayloadType, rtp.PayloadTypeTelephoneEvent)
		}
		if event.event != 5 {
			t.Errorf("packet %d event = %d, want 5", index, event.event)
		}
		if event.end {
			t.Errorf("packet %d has the END bit set; only the last packets of a digit do", index)
		}
		if want := uint16(index * audio.FrameTimestampStep); event.duration != want {
			t.Errorf("packet %d duration = %d, want %d samples so far", index, event.duration, want)
		}
		// Every packet of one digit carries the timestamp the DIGIT started at. It is a span of the
		// clock, not a point, and a timestamp that advanced per packet would be five separate tones.
		if packet.Timestamp != first.Timestamp {
			t.Errorf("packet %d timestamp = %d, want the digit's start %d",
				index, packet.Timestamp, first.Timestamp)
		}
		// The marker is RFC 4733 §2.5.1.2's start-of-event flag, and it is the one an IVR keys on.
		if marker := index == 1; packet.Marker != marker {
			t.Errorf("packet %d marker = %v, want %v", index, packet.Marker, marker)
		}
	}

	// Three copies of the END packet, back to back. Losing the only one that says "the digit is
	// over" leaves the far end holding a tone open until its own timeout, which an IVR reads as one
	// very long keypress or as two digits where the caller pressed one.
	for copyIndex := 1; copyIndex <= 3; copyIndex++ {
		packet, ok := rig.aPhone.receive(t)
		if !ok {
			t.Fatalf("end packet %d never arrived", copyIndex)
		}
		event := decodeTelephoneEvent(t, packet)
		if !event.end {
			t.Errorf("end packet %d has no END bit", copyIndex)
		}
		if want := uint16(100 * audio.SampleRate / 1000); event.duration != want {
			t.Errorf("end packet %d duration = %d, want the whole tone %d", copyIndex, event.duration, want)
		}
		if packet.Timestamp != first.Timestamp {
			t.Errorf("end packet %d timestamp = %d, want the digit's start %d",
				copyIndex, packet.Timestamp, first.Timestamp)
		}
	}
}

func TestDtmfKeepsTheSessionsOwnSSRCAndSequenceSpace(t *testing.T) {
	// A digit is not a second stream. Giving it its own SSRC would make the endpoint see one sender
	// stop and another start around every keypress, which is the click the relay's header rewrite
	// exists to avoid; a sequence space of its own would look like catastrophic loss.
	rig := newPlaybackRig(t, 57420, 57439)
	rig.latch(t)
	sendDigits(t, rig, rig.aID, "1")

	session, ok := rig.manager.Get(rig.aID)
	if !ok {
		t.Fatal("leg A is not live")
	}

	var previousSeq uint16
	for index := 0; index < 8; index++ { // 5 tone packets + 3 end copies
		if index < 5 {
			rig.tick(t)
		}
		packet, arrived := rig.aPhone.receive(t)
		if !arrived {
			t.Fatalf("packet %d never arrived", index)
		}
		if packet.SSRC != session.SSRC {
			t.Errorf("packet %d SSRC = %d, want the session's own %d", index, packet.SSRC, session.SSRC)
		}
		if index > 0 && packet.SequenceNumber != previousSeq+1 {
			t.Errorf("packet %d sequence = %d, want %d: a digit must not skip the sequence space",
				index, packet.SequenceNumber, previousSeq+1)
		}
		previousSeq = packet.SequenceNumber
	}
}

func TestDtmfAdvancesTheClockAcrossToneAndGapForTheNextDigit(t *testing.T) {
	// The second digit must start where the first one's span ended, gap included. A second digit
	// that reused the first's timestamp would be one tone to a receiver, not two.
	rig := newPlaybackRig(t, 57440, 57459)
	rig.latch(t)
	err := rig.manager.SendDtmf(rig.aID, rtp.DtmfOptions{
		Digits:       "12",
		ToneDuration: 40 * time.Millisecond, // two packets
		Gap:          40 * time.Millisecond, // two ticks of silence
	})
	if err != nil {
		t.Fatalf("SendDtmf: %v", err)
	}

	firstStart := drainDigit(t, rig, 2, 1)
	// The gap sends nothing at all: RFC 4733 carries events, and an inter-digit interval is the
	// absence of one.
	rig.tick(t)
	rig.tick(t)
	secondStart := drainDigit(t, rig, 2, 2)

	toneSamples := uint32(40 * audio.SampleRate / 1000)
	if want := firstStart + toneSamples + toneSamples; secondStart != want {
		t.Errorf("the second digit starts at %d, want %d (the first digit's tone plus the gap)",
			secondStart, want)
	}
}

// drainDigit reads one whole digit — tonePackets tone packets and three end copies — and returns
// the timestamp the digit started at, checking every packet carries the expected event code.
func drainDigit(t *testing.T, rig *playbackRig, tonePackets int, event byte) uint32 {
	t.Helper()
	var start uint32
	for index := 0; index < tonePackets+3; index++ {
		if index < tonePackets {
			rig.tick(t)
		}
		packet, ok := rig.aPhone.receive(t)
		if !ok {
			t.Fatalf("digit %d packet %d never arrived", event, index)
		}
		if index == 0 {
			start = packet.Timestamp
		}
		if decoded := decodeTelephoneEvent(t, packet); decoded.event != event {
			t.Fatalf("packet %d carries event %d, want %d", index, decoded.event, event)
		}
	}
	return start
}

func TestDtmfSuppressesRelayedAudioForTheLengthOfTheString(t *testing.T) {
	// A digit occupies a SPAN of the outbound clock. An audio frame let out in the middle of it puts
	// a second, unrelated clock inside the digit, and the receiver either regenerates a tone of the
	// wrong length or drops it.
	rig := newPlaybackRig(t, 57460, 57479)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	sendDigits(t, rig, rig.aID, "7")

	// Wait until the injection actually owns the stream, so the peer's frame races nothing.
	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the first tone packet never arrived")
	}

	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 0xb0b0, SequenceNumber: 9, Timestamp: 900},
		Payload: make([]byte, audio.FrameSamples),
	})

	// The next thing leg A hears is the next TONE packet, never the peer's audio.
	rig.tick(t)
	packet, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the second tone packet never arrived")
	}
	if packet.PayloadType != rtp.PayloadTypeTelephoneEvent {
		t.Errorf("leg A heard payload type %d during a digit; the peer's audio was not suppressed",
			packet.PayloadType)
	}
}

func TestDtmfRefusesALegThatNegotiatedNoTelephoneEventType(t *testing.T) {
	// `not_supported`, never a silently synthesised tone. The far end said it does not expect RFC
	// 4733; sending under a type it never agreed to produces digits it drops, and an inband tone
	// needs a generator mediad does not have.
	rig := newBridgeRig(t, 57480, 57499)
	descriptor, err := rig.manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-plain", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	phone := newPhone(t, descriptor.RTPPort)
	phone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 1, SequenceNumber: 1},
		Payload: make([]byte, audio.FrameSamples),
	})
	waitFor(t, "the plain leg latched onto its far end", func() bool {
		session, live := rig.manager.Get("leg-plain")
		return live && session.Remote() != nil
	})

	if err := rig.manager.SendDtmf("leg-plain", rtp.DtmfOptions{Digits: "1"}); !errors.Is(err, rtp.ErrNoTelephoneEvent) {
		t.Errorf("SendDtmf on a leg with no telephone-event type = %v, want ErrNoTelephoneEvent", err)
	}
}

func TestDtmfRefusesALegThatHasNotBeenLatchedYet(t *testing.T) {
	// Symmetric RTP learns the far end from its first packet, so a leg that has not sent has taught
	// us nowhere to send. A digit that "started" into that would report success and go nowhere.
	rig := newPlaybackRig(t, 57500, 57519)
	if err := rig.manager.SendDtmf(rig.aID, rtp.DtmfOptions{Digits: "1"}); !errors.Is(err, rtp.ErrNoRemote) {
		t.Errorf("SendDtmf before a latch = %v, want ErrNoRemote", err)
	}
}

func TestDtmfRefusesAnUnknownSession(t *testing.T) {
	rig := newPlaybackRig(t, 57520, 57539)
	if err := rig.manager.SendDtmf("nobody", rtp.DtmfOptions{Digits: "1"}); !errors.Is(err, rtp.ErrUnknownSession) {
		t.Errorf("SendDtmf on an unknown session = %v, want ErrUnknownSession", err)
	}
}

func TestDtmfQueuedDurationCountsToneAndGapPerDigit(t *testing.T) {
	// The reply is sent when injection STARTS, so this is the only number that tells the caller when
	// the far end will have heard the last digit.
	opts := rtp.DtmfOptions{Digits: "123", ToneDuration: 80 * time.Millisecond, Gap: 20 * time.Millisecond}
	if got, want := opts.QueuedDuration(), 300*time.Millisecond; got != want {
		t.Errorf("QueuedDuration = %v, want %v", got, want)
	}
	// Defaults are ARI's, so a request that names neither puts the same thing on the wire on either
	// driver.
	if got, want := (rtp.DtmfOptions{Digits: "1"}).QueuedDuration(), 200*time.Millisecond; got != want {
		t.Errorf("QueuedDuration with defaults = %v, want %v", got, want)
	}
}
