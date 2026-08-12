package rtp_test

import (
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// Rung 5's frame source: "a session sourcing from a LOOP instead of a peer".
//
// The wrap is the whole of it, and the assertions are about what a receiver cannot tell: the far end
// must not be able to distinguish the moment the clip came back round from any other frame boundary,
// because a hold loop that announced itself every four seconds is a hold loop somebody complains
// about.

func TestALoopingSourceWrapsSeamlessly(t *testing.T) {
	rig := newPlaybackRig(t, 63000, 63019)
	rig.latch(t)

	// Two frames, played five times round.
	if err := rig.manager.StartPlayback(rig.aID, rtp.PlaybackOptions{
		Ref:      "moh-1",
		Frames:   promptFrames(2),
		Encoding: audio.EncodingULaw,
		Loop:     true,
		Kind:     rtp.PlaybackMusicOnHold,
	}); err != nil {
		t.Fatalf("StartPlayback: %v", err)
	}

	var previousSeq uint16
	var previousTimestamp uint32
	for index := 0; index < 5; index++ {
		rig.tick(t)
		packet, ok := rig.aPhone.receive(t)
		if !ok {
			t.Fatalf("frame %d never arrived; the loop stopped at the end of the clip", index)
		}

		// The clip repeats: frames 0,1,0,1,0.
		want := byte(index%2 + 1)
		if packet.Payload[0] != want {
			t.Errorf("frame %d carries clip frame %d, want %d", index, packet.Payload[0], want)
		}

		if index == 0 {
			if !packet.Marker {
				t.Error("the first looped frame has no marker; the stream just changed clocks")
			}
		} else {
			// THE WRAP ASSERTION. Re-asserting the marker at index 2 — the first frame of the second
			// time round — would tell the receiver a new talkspurt begins every time the music
			// repeats, which flushes its buffer and clips the first syllable of the loop forever.
			if packet.Marker {
				t.Errorf("frame %d has a marker bit; a wrap is not a new talkspurt", index)
			}
			if packet.SequenceNumber != previousSeq+1 {
				t.Errorf("frame %d sequence = %d, want %d: the wrap broke the sequence space",
					index, packet.SequenceNumber, previousSeq+1)
			}
			if packet.Timestamp != previousTimestamp+audio.FrameTimestampStep {
				t.Errorf("frame %d timestamp = %d, want %d: the wrap sent the clock backwards",
					index, packet.Timestamp, previousTimestamp+audio.FrameTimestampStep)
			}
		}
		previousSeq, previousTimestamp = packet.SequenceNumber, packet.Timestamp
	}
}

func TestALoopingSourceEndsStoppedRatherThanCompleted(t *testing.T) {
	// A loop has no end to complete at. Reporting `completed` would tell a consumer the hold music
	// finished, which is the one thing hold music never does.
	rig := newPlaybackRig(t, 63020, 63039)
	rig.latch(t)

	if err := rig.manager.StartPlayback(rig.aID, rtp.PlaybackOptions{
		Ref:      "moh-1",
		Frames:   promptFrames(1),
		Encoding: audio.EncodingULaw,
		Loop:     true,
	}); err != nil {
		t.Fatalf("StartPlayback: %v", err)
	}

	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the loop sent nothing")
	}

	session, _ := rig.manager.Get(rig.aID)
	playback := session.ActivePlayback()
	if playback == nil {
		t.Fatal("the loop is not the session's active playback")
	}
	if _, stopped := rig.manager.StopPlayback("moh-1"); !stopped {
		t.Fatal("StopPlayback reported nothing to stop")
	}
	<-playback.Done()

	summary := playback.Summary()
	if summary.Reason != rtp.PlaybackStopped {
		t.Errorf("reason = %q, want stopped", summary.Reason)
	}
	// `playedMs` is the only honest measure of how long the caller heard it, which is why it is
	// counted from frames SENT rather than from the clip's length.
	if summary.PlayedMs != audio.FrameDurationMs {
		t.Errorf("playedMs = %d, want %d", summary.PlayedMs, audio.FrameDurationMs)
	}
}

func TestAPromptSupersedesAHoldLoop(t *testing.T) {
	// The rung-1 supersede rule, unchanged: a second playback replaces the first, whatever either of
	// them is. That is what lets an engine play "your call is important to us" over hold music
	// without a queue, and it is why the hold's own reference is remembered — an unhold must stop the
	// loop IT started, not whatever happens to be playing by then.
	rig := newPlaybackRig(t, 63040, 63059)
	rig.latch(t)

	if err := rig.manager.Hold(rig.aID, rtp.HoldOptions{
		MusicRef:      "moh-1",
		MusicFrames:   promptFrames(2),
		MusicEncoding: audio.EncodingULaw,
	}); err != nil {
		t.Fatalf("Hold: %v", err)
	}
	session, _ := rig.manager.Get(rig.aID)
	music := session.ActivePlayback()

	startPrompt(t, rig, rig.aID, "pb-1", 2)
	<-music.Done()
	if summary := music.Summary(); summary.Reason != rtp.PlaybackStopped {
		t.Errorf("the superseded loop ended %q, want stopped", summary.Reason)
	}
	if got := session.ActivePlayback(); got == nil || got.Ref() != "pb-1" {
		t.Error("the prompt did not take over the outbound stream")
	}

	// And the unhold, which names the loop's reference, must not silence the prompt that replaced it.
	if _, err := rig.manager.Unhold(rig.aID); err != nil {
		t.Fatalf("Unhold: %v", err)
	}
	if got := session.ActivePlayback(); got == nil || got.Ref() != "pb-1" {
		t.Error("unholding stopped a prompt it did not start")
	}
}

func TestMusicOnHoldWithoutAHoldKeepsTheConversation(t *testing.T) {
	// `MediaPort` keeps `startMusicOnHold` and `hold` apart — "separate from hold, which is
	// signalling" — and this is why: a queue playing music to a caller who is very much still in a
	// conversation with the queue is the case that needs it. A hold would make that caller inaudible
	// to the agent who then answered to silence.
	rig := newPlaybackRig(t, 63060, 63079)
	rig.latch(t)

	if err := rig.manager.StartMusicOnHold(rig.aID, rtp.PlaybackOptions{
		Ref:      "moh-1",
		Frames:   promptFrames(2),
		Encoding: audio.EncodingULaw,
	}); err != nil {
		t.Fatalf("StartMusicOnHold: %v", err)
	}

	session, _ := rig.manager.Get(rig.aID)
	if session.Held() {
		t.Error("starting music on hold put the leg on hold; they are separate operations")
	}
	playback := session.ActivePlayback()
	if playback == nil {
		t.Fatal("no music started")
	}

	// It loops, whatever the caller passed, because it is hold music.
	rig.tick(t)
	rig.tick(t)
	rig.tick(t)
	for index := 0; index < 3; index++ {
		packet, ok := rig.aPhone.receive(t)
		if !ok {
			t.Fatalf("music frame %d never arrived", index)
		}
		if want := byte(index%2 + 1); packet.Payload[0] != want {
			t.Errorf("music frame %d carries clip frame %d, want %d", index, packet.Payload[0], want)
		}
	}
}
