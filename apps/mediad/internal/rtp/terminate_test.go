package rtp_test

import (
	"encoding/binary"
	"strings"
	"testing"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// `terminateOn`, which design doc §10 question 10 has been carrying as "a WIRING gap rather than a
// missing capability" since rung 3's receive half landed.
//
// The wiring is one line in `announceDigit`: the recorder is asked whether the digit it just
// detected is one of its terminators. It is checked THERE rather than in the recorder's own tick
// loop because that loop sees decoded audio frames, and a `#` is not in them.

// sendDigit puts one complete RFC 4733 keypress on the wire: a few update packets and the END copy,
// all sharing the timestamp the digit started at, which is what makes them one keypress rather than
// several.
func sendDigit(t *testing.T, from *phone, event byte, timestamp uint32, firstSequence uint16) {
	t.Helper()
	for step := 1; step <= 3; step++ {
		payload := make([]byte, 4)
		payload[0] = event
		payload[1] = 10
		end := step == 3
		if end {
			payload[1] |= 0x80
		}
		binary.BigEndian.PutUint16(payload[2:], uint16(step)*audio.FrameTimestampStep)

		from.send(t, pionrtp.Packet{
			Header: pionrtp.Header{
				Version:        2,
				PayloadType:    rtp.PayloadTypeTelephoneEvent,
				SSRC:           111,
				SequenceNumber: firstSequence + uint16(step),
				Timestamp:      timestamp,
				Marker:         step == 1,
			},
			Payload: payload,
		})
	}
}

func TestRecordingStopsOnATerminatorDigit(t *testing.T) {
	// Voicemail's `#`. Without this the recording runs to `maxDurationMs` on every message, which is
	// why the argument was refused rather than accepted-and-ignored for two waves.
	rig := newRecordingRig(t, 64000, 64019)
	rig.latch(t)
	rig.start(t, "rec-1", rtp.RecordReceive, rtp.RecordingOptions{TerminateOn: "#"})

	rig.speak(t, 0x10)
	rig.tick(t)

	// Event code 11 is `#` (RFC 4733 §3.2).
	sendDigit(t, rig.aPhone, 11, 8000, 100)

	summary := rig.finishedSummary(t)
	if summary.Reason != rtp.RecordingStopped {
		t.Errorf("reason = %q, want stopped", summary.Reason)
	}
	// WHICH digit ended it goes in `detail`, which the contract already carries and which is the only
	// part a person investigating a truncated voicemail actually wants. A sixth `reason` value would
	// be two media planes agreeing on a vocabulary the engine does not branch on.
	if !strings.Contains(summary.Detail, "#") {
		t.Errorf("detail = %q, want it to name the digit that ended the recording", summary.Detail)
	}
}

func TestARecordingIgnoresDigitsOutsideItsTerminatorSet(t *testing.T) {
	// A caller who presses 5 while leaving a message has not finished leaving it. A recorder that
	// stopped on any digit would truncate every message from anybody with a phone in their pocket.
	rig := newRecordingRig(t, 64020, 64039)
	rig.latch(t)
	rig.start(t, "rec-1", rtp.RecordReceive, rtp.RecordingOptions{TerminateOn: "#"})

	sendDigit(t, rig.aPhone, 5, 8000, 100)
	rig.speak(t, 0x10)
	rig.tick(t)

	session, _ := rig.manager.Get(rig.aID)
	waitFor(t, "the digit was detected", func() bool {
		return session.Stats().DtmfDigitsReceived > 0
	})
	if recording := session.ActiveRecording(); recording == nil {
		t.Fatal("a digit outside the terminator set ended the recording")
	}
	if len(rig.lifecycle.recordingSummaries()) != 0 {
		t.Error("the recording announced that it finished")
	}
}

func TestATerminatorSetAcceptsSeveralDigits(t *testing.T) {
	// `#*` is what a caller sends when the dialplan offers two ways out of a prompt. The set is a
	// STRING because that is the shape the contract carries, and membership is the whole of the
	// matching rule.
	rig := newRecordingRig(t, 64040, 64059)
	rig.latch(t)
	rig.start(t, "rec-1", rtp.RecordReceive, rtp.RecordingOptions{TerminateOn: "#*"})

	rig.speak(t, 0x10)
	rig.tick(t)

	// Event code 10 is `*`.
	sendDigit(t, rig.aPhone, 10, 8000, 100)

	summary := rig.finishedSummary(t)
	if summary.Reason != rtp.RecordingStopped {
		t.Errorf("reason = %q, want stopped", summary.Reason)
	}
	if !strings.Contains(summary.Detail, "*") {
		t.Errorf("detail = %q, want it to name `*`", summary.Detail)
	}
}

func TestNoTerminatorSetMeansNoDigitEndsARecording(t *testing.T) {
	// The default, and the behaviour every recording had before this. A recorder that stopped on a
	// digit nobody asked it to watch for would truncate an on-demand call recording the moment
	// somebody navigated an IVR on the other end.
	rig := newRecordingRig(t, 64060, 64079)
	rig.latch(t)
	rig.start(t, "rec-1", rtp.RecordReceive, rtp.RecordingOptions{})

	sendDigit(t, rig.aPhone, 11, 8000, 100)
	rig.speak(t, 0x10)
	rig.tick(t)

	session, _ := rig.manager.Get(rig.aID)
	waitFor(t, "the digit was detected", func() bool {
		return session.Stats().DtmfDigitsReceived > 0
	})
	if session.ActiveRecording() == nil {
		t.Fatal("a recording with no terminator set was ended by a digit")
	}
}
