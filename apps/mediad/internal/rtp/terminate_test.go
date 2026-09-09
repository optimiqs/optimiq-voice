package rtp_test

import (
	"encoding/binary"
	"strings"
	"testing"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// `terminateOn`: `announceDigit` asks the recorder whether the digit just detected is one of its
// terminators — checked there rather than in the recorder's tick loop, which sees only audio.

// sendDigit puts one complete RFC 4733 keypress on the wire: update packets and the END copy, all
// sharing the timestamp the digit started at.
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
	// Voicemail's `#`. Without it the recording runs to `maxDurationMs` on every message.
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
	// Which digit ended it goes in `detail`; there is no sixth `reason` value for it.
	if !strings.Contains(summary.Detail, "#") {
		t.Errorf("detail = %q, want it to name the digit that ended the recording", summary.Detail)
	}
}

func TestARecordingIgnoresDigitsOutsideItsTerminatorSet(t *testing.T) {
	// A caller who presses 5 while leaving a message has not finished leaving it.
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
	// The set is a string because that is the shape the contract carries; membership is the rule.
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
	// The default: a recorder that stopped on an unrequested digit would truncate a call recording
	// the moment somebody navigated an IVR at the other end.
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
