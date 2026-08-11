package rtp_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The playback suite drives REAL sockets, for the same reason the bridge suite does: a prompt is
// bytes on a wire with a header on them, and a test with a fake socket asserts that a method was
// called — which is exactly the assertion that stays green when the header is wrong.
//
// What it does NOT do is sleep. The pacing clock is injected, so a test steps a prompt frame by
// frame and every assertion lands at a defined point rather than after a timeout somebody tuned.

// playbackRig is a bridged pair plus a hand-driven 20 ms clock.
type playbackRig struct {
	*bridgeRig
	// ticks is UNBUFFERED, which is what makes the suite deterministic: a send blocks until the
	// playback goroutine has taken it, so "tick, then read a packet" is a synchronisation point and
	// not a race.
	ticks     chan time.Time
	lifecycle *recordingLifecycle
}

func newPlaybackRig(t *testing.T, low, high int) *playbackRig {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	ticks := make(chan time.Time)
	lifecycle := &recordingLifecycle{}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Lifecycle:  lifecycle,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Ticker: func(time.Duration) (<-chan time.Time, func()) {
			return ticks, func() {}
		},
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

	a, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-a", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU, TelephoneEventPayloadType: rtp.PayloadTypeTelephoneEvent,
	})
	if err != nil {
		t.Fatalf("allocating leg A: %v", err)
	}
	b, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-b", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU, TelephoneEventPayloadType: rtp.PayloadTypeTelephoneEvent,
	})
	if err != nil {
		t.Fatalf("allocating leg B: %v", err)
	}

	return &playbackRig{
		bridgeRig: &bridgeRig{
			manager: manager,
			aID:     a.SessionID, bID: b.SessionID,
			aPort: a.RTPPort, bPort: b.RTPPort,
			aPhone: newPhone(t, a.RTPPort),
			bPhone: newPhone(t, b.RTPPort),
		},
		ticks:     ticks,
		lifecycle: lifecycle,
	}
}

// tick releases exactly one frame, and fails rather than hanging if the playback is not waiting.
func (r *playbackRig) tick(t *testing.T) {
	t.Helper()
	select {
	case r.ticks <- time.Now():
	case <-time.After(readTimeout):
		t.Fatal("the playback did not take a tick; it is not waiting for one")
	}
}

// promptFrames builds n distinguishable 20 ms G.711 frames.
func promptFrames(count int) [][]byte {
	frames := make([][]byte, count)
	for index := range frames {
		frame := make([]byte, audio.FrameSamples)
		for byteIndex := range frame {
			frame[byteIndex] = byte(index + 1)
		}
		frames[index] = frame
	}
	return frames
}

func startPrompt(t *testing.T, rig *playbackRig, sessionID, ref string, frames int) {
	t.Helper()
	err := rig.manager.StartPlayback(sessionID, rtp.PlaybackOptions{
		Ref:      ref,
		Frames:   promptFrames(frames),
		Encoding: audio.EncodingULaw,
	})
	if err != nil {
		t.Fatalf("StartPlayback: %v", err)
	}
}

func TestPlaybackPacketisesFramesInOrder(t *testing.T) {
	rig := newPlaybackRig(t, 57000, 57019)
	rig.latch(t)
	startPrompt(t, rig, rig.aID, "pb-1", 3)

	var previousSeq uint16
	var previousTimestamp uint32
	for index := 0; index < 3; index++ {
		rig.tick(t)
		packet, ok := rig.aPhone.receive(t)
		if !ok {
			t.Fatalf("frame %d never arrived", index)
		}

		if packet.PayloadType != rtp.PayloadTypePCMU {
			t.Errorf("frame %d payload type = %d, want the session's negotiated PCMU", index, packet.PayloadType)
		}
		if len(packet.Payload) != audio.FrameSamples {
			t.Errorf("frame %d is %d bytes, want a 20 ms frame of %d", index, len(packet.Payload), audio.FrameSamples)
		}
		if packet.Payload[0] != byte(index+1) {
			t.Errorf("frame %d carries clip frame %d; the prompt is out of order", index, packet.Payload[0]-1)
		}

		// The marker bit is RFC 3550's start-of-talkspurt flag, and it belongs on the FIRST frame
		// only: the outbound stream just changed timestamp clocks, and every frame after it is a
		// continuation.
		if index == 0 && !packet.Marker {
			t.Error("the first prompt frame has no marker bit; a receiver reads the timestamp jump as loss")
		}
		if index > 0 {
			if packet.Marker {
				t.Errorf("frame %d has a marker bit; only the first frame starts a talkspurt", index)
			}
			if packet.SequenceNumber != previousSeq+1 {
				t.Errorf("frame %d sequence = %d, want %d: a prompt must not skip the sequence space",
					index, packet.SequenceNumber, previousSeq+1)
			}
			if packet.Timestamp != previousTimestamp+audio.FrameTimestampStep {
				t.Errorf("frame %d timestamp = %d, want %d (one 20 ms step at 8 kHz)",
					index, packet.Timestamp, previousTimestamp+audio.FrameTimestampStep)
			}
		}
		previousSeq, previousTimestamp = packet.SequenceNumber, packet.Timestamp
	}
}

func TestPlaybackKeepsTheSessionsOwnSSRCAndSequenceSpace(t *testing.T) {
	// A prompt is not a second stream: it is this leg's audio, sourced from a file for a while.
	// Giving it its own SSRC would make the endpoint see one sender stop and another start around
	// every prompt, which is the audible click the relay's header rewrite exists to avoid.
	rig := newPlaybackRig(t, 57020, 57039)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	// One relayed packet first, so the session's sequence counter is already moving.
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222, SequenceNumber: 900, Timestamp: 16000},
		Payload: []byte{0x11},
	})
	relayed, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the relay never delivered the peer's packet")
	}

	startPrompt(t, rig, rig.aID, "pb-1", 1)
	rig.tick(t)
	prompt, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the prompt frame never arrived")
	}

	if prompt.SSRC != relayed.SSRC {
		t.Errorf("prompt SSRC = %d, relay SSRC = %d; a prompt must not change the leg's sender",
			prompt.SSRC, relayed.SSRC)
	}
	if prompt.SequenceNumber != relayed.SequenceNumber+1 {
		t.Errorf("prompt sequence = %d, want %d: the prompt continues the leg's sequence space",
			prompt.SequenceNumber, relayed.SequenceNumber+1)
	}
	// And the timestamp continues FORWARD from the relayed one rather than restarting at zero,
	// which some endpoints read as a stream restart and answer by flushing — clipping the first
	// syllable of every prompt.
	if prompt.Timestamp != relayed.Timestamp+audio.FrameTimestampStep {
		t.Errorf("prompt timestamp = %d, want %d: it must not send the stream's clock backwards",
			prompt.Timestamp, relayed.Timestamp+audio.FrameTimestampStep)
	}
}

func TestPlaybackReplacesThePeersAudioAndResumesAfterwards(t *testing.T) {
	// REPLACE is the rung 1 rule: a session has one outbound stream, and interleaving the peer's
	// frames into a prompt would put two unrelated timestamp clocks under one SSRC.
	rig := newPlaybackRig(t, 57040, 57059)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	startPrompt(t, rig, rig.aID, "pb-1", 1)

	// B talks while A is being played a prompt. Nothing of B's may reach A.
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222, SequenceNumber: 5, Timestamp: 800},
		Payload: []byte{0x77},
	})
	session, _ := rig.manager.Get(rig.aID)
	waitFor(t, "the peer's frame was suppressed by the playback", func() bool {
		return session.Stats().SuppressedByPlayback == 1
	})

	rig.tick(t)
	prompt, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the prompt frame never arrived")
	}
	if prompt.Payload[0] != 1 {
		t.Fatalf("A received %#02x, which is the peer's audio and not the prompt", prompt.Payload[0])
	}

	playback := session.ActivePlayback()
	if playback != nil {
		<-playback.Done()
	}
	waitFor(t, "the playback cleared", func() bool { return session.ActivePlayback() == nil })

	// The relay resumes untouched, and the first packet after a prompt carries a marker because the
	// stream is switching back to the peer's timestamp clock.
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222, SequenceNumber: 6, Timestamp: 960},
		Payload: []byte{0x88},
	})
	resumed, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the relay did not resume after the prompt finished")
	}
	if resumed.Payload[0] != 0x88 {
		t.Errorf("resumed payload = %#02x, want the peer's 0x88", resumed.Payload[0])
	}
	if !resumed.Marker {
		t.Error("the first relayed packet after a prompt has no marker bit")
	}
}

func TestPlaybackDoesNotInterruptDTMFTravellingTheOtherWay(t *testing.T) {
	// THE test for barge-in. A caller pressing a digit while the menu is still talking sends RFC
	// 4733 INTO the played-to leg, and that path must be completely untouched by playback —
	// otherwise `gather` would collect nothing and every IVR would require the caller to wait out
	// the prompt.
	rig := newPlaybackRig(t, 57060, 57079)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	startPrompt(t, rig, rig.aID, "pb-1", 2)

	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the first prompt frame never arrived")
	}

	// A presses 1 mid-prompt. Marker set, because it is the start of a digit.
	rig.aPhone.send(t, pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: rtp.PayloadTypeTelephoneEvent,
			SSRC: 111, SequenceNumber: 42, Timestamp: 3200, Marker: true,
		},
		Payload: []byte{0x01, 0x0A, 0x00, 0xA0},
	})

	digit, ok := rig.bPhone.receive(t)
	if !ok {
		t.Fatal("the digit never reached the peer; barge-in is broken during playback")
	}
	if digit.PayloadType != rtp.PayloadTypeTelephoneEvent {
		t.Errorf("relayed payload type = %d, want the RFC 4733 type", digit.PayloadType)
	}
	if !digit.Marker {
		t.Error("the start-of-digit marker was dropped; an IVR cannot detect the keypress")
	}
	if digit.Payload[0] != 0x01 {
		t.Errorf("relayed digit = %#02x, want 1", digit.Payload[0])
	}

	// And the prompt is still running: a digit does not stop it, the engine does.
	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the prompt stopped when a digit arrived; only stop-playback ends it")
	}
}

func TestPlaybackStopMidPlay(t *testing.T) {
	rig := newPlaybackRig(t, 57080, 57099)
	rig.latch(t)
	startPrompt(t, rig, rig.aID, "pb-1", 50)

	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the first frame never arrived")
	}

	sessionID, stopped := rig.manager.StopPlayback("pb-1")
	if !stopped {
		t.Fatal("StopPlayback reported nothing to stop")
	}
	if sessionID != rig.aID {
		t.Errorf("StopPlayback reported session %q, want %q", sessionID, rig.aID)
	}

	waitFor(t, "the playback announced itself finished", func() bool {
		return len(rig.lifecycle.playbackSummaries()) == 1
	})
	summary := rig.lifecycle.playbackSummaries()[0]
	if summary.Reason != rtp.PlaybackStopped {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.PlaybackStopped)
	}
	// playedMs is what actually reached the far end, not the clip's length: a barge-in one frame
	// into a one-second menu played 20 ms.
	if summary.PlayedMs != audio.FrameDurationMs {
		t.Errorf("playedMs = %d, want %d", summary.PlayedMs, audio.FrameDurationMs)
	}
	if summary.Ref != "pb-1" {
		t.Errorf("ref = %q, want pb-1", summary.Ref)
	}

	// Nothing else goes out after the stop.
	expectSilence(t, rig)
}

func TestPlaybackCompletesAndAnnouncesItself(t *testing.T) {
	rig := newPlaybackRig(t, 57100, 57119)
	rig.latch(t)
	startPrompt(t, rig, rig.aID, "pb-1", 2)

	for index := 0; index < 2; index++ {
		rig.tick(t)
		if _, ok := rig.aPhone.receive(t); !ok {
			t.Fatalf("frame %d never arrived", index)
		}
	}

	waitFor(t, "the playback announced itself finished", func() bool {
		return len(rig.lifecycle.playbackSummaries()) == 1
	})
	summary := rig.lifecycle.playbackSummaries()[0]
	if summary.Reason != rtp.PlaybackCompleted {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.PlaybackCompleted)
	}
	if summary.PlayedMs != 2*audio.FrameDurationMs {
		t.Errorf("playedMs = %d, want %d", summary.PlayedMs, 2*audio.FrameDurationMs)
	}

	// The reference is out of the index, so a late stop cannot match a session that has since
	// started a different prompt.
	if _, found := rig.manager.PlaybackSessionOf("pb-1"); found {
		t.Error("the playback reference survived the prompt it named")
	}
	if _, stopped := rig.manager.StopPlayback("pb-1"); stopped {
		t.Error("stopping a finished playback reported a stop; it must be a no-op")
	}
}

func TestPlaybackStopOfAnUnknownReferenceIsANoOp(t *testing.T) {
	// The COMMON case, not an edge one: every `gather` stops its prompt whatever ended the
	// collection, so a caller who listens to the whole menu produces exactly this on every call.
	rig := newPlaybackRig(t, 57120, 57139)
	if _, stopped := rig.manager.StopPlayback("never-started"); stopped {
		t.Error("StopPlayback reported a stop for a reference nothing is playing")
	}
}

func TestPlaybackEndsWhenTheSessionDoes(t *testing.T) {
	rig := newPlaybackRig(t, 57140, 57159)
	rig.latch(t)
	startPrompt(t, rig, rig.aID, "pb-1", 50)

	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the first frame never arrived")
	}

	if !rig.manager.Release(rig.aID) {
		t.Fatal("Release reported nothing to release")
	}

	waitFor(t, "the playback announced itself finished", func() bool {
		return len(rig.lifecycle.playbackSummaries()) == 1
	})
	summary := rig.lifecycle.playbackSummaries()[0]
	// `stopped`, not `error`: nothing failed, the leg went away, and the session.ended event carries
	// the real story.
	if summary.Reason != rtp.PlaybackStopped {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.PlaybackStopped)
	}
	if summary.Detail == "" {
		t.Error("a playback ended by its session carries no detail saying so")
	}
}

func TestPlaybackSupersedesTheOneBeforeIt(t *testing.T) {
	// A re-prompt must not queue behind the prompt the caller just interrupted.
	rig := newPlaybackRig(t, 57160, 57179)
	rig.latch(t)
	startPrompt(t, rig, rig.aID, "pb-1", 50)
	rig.tick(t)
	if _, ok := rig.aPhone.receive(t); !ok {
		t.Fatal("the first prompt never started")
	}

	startPrompt(t, rig, rig.aID, "pb-2", 1)

	waitFor(t, "the superseded playback announced itself", func() bool {
		for _, summary := range rig.lifecycle.playbackSummaries() {
			if summary.Ref == "pb-1" && summary.Reason == rtp.PlaybackStopped {
				return true
			}
		}
		return false
	})

	session, _ := rig.manager.Get(rig.aID)
	if active := session.ActivePlayback(); active == nil || active.Ref() != "pb-2" {
		t.Fatal("the second prompt is not the active one")
	}
	rig.tick(t)
	packet, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("the second prompt never played")
	}
	if packet.Payload[0] != 1 {
		t.Errorf("the frame is from the superseded prompt, not the new one")
	}
}

func TestPlaybackRefusals(t *testing.T) {
	t.Run("no far end learned yet", func(t *testing.T) {
		// Symmetric RTP means the address is LEARNED. A leg that has not sent has taught us nowhere
		// to send, and a playback that "started" into that would report success and send nothing.
		rig := newPlaybackRig(t, 57180, 57199)
		err := rig.manager.StartPlayback(rig.aID, rtp.PlaybackOptions{
			Ref: "pb-1", Frames: promptFrames(1), Encoding: audio.EncodingULaw,
		})
		if !errors.Is(err, rtp.ErrNoRemote) {
			t.Fatalf("StartPlayback error = %v, want ErrNoRemote", err)
		}
	})

	t.Run("a clip in the wrong companding law", func(t *testing.T) {
		// An A-law clip on a µ-law leg is a rasp, not a wrong-sounding voice.
		rig := newPlaybackRig(t, 57200, 57219)
		rig.latch(t)
		err := rig.manager.StartPlayback(rig.aID, rtp.PlaybackOptions{
			Ref: "pb-1", Frames: promptFrames(1), Encoding: audio.EncodingALaw,
		})
		if !errors.Is(err, rtp.ErrPlaybackPayloadType) {
			t.Fatalf("StartPlayback error = %v, want ErrPlaybackPayloadType", err)
		}
	})

	t.Run("an unknown session", func(t *testing.T) {
		rig := newPlaybackRig(t, 57220, 57239)
		err := rig.manager.StartPlayback("nobody", rtp.PlaybackOptions{
			Ref: "pb-1", Frames: promptFrames(1), Encoding: audio.EncodingULaw,
		})
		if !errors.Is(err, rtp.ErrUnknownSession) {
			t.Fatalf("StartPlayback error = %v, want ErrUnknownSession", err)
		}
	})

	t.Run("no frames", func(t *testing.T) {
		rig := newPlaybackRig(t, 57240, 57259)
		rig.latch(t)
		if err := rig.manager.StartPlayback(rig.aID, rtp.PlaybackOptions{
			Ref: "pb-1", Encoding: audio.EncodingULaw,
		}); err == nil {
			t.Fatal("StartPlayback accepted a prompt with no frames")
		}
	})

	t.Run("no reference", func(t *testing.T) {
		rig := newPlaybackRig(t, 57260, 57279)
		rig.latch(t)
		if err := rig.manager.StartPlayback(rig.aID, rtp.PlaybackOptions{
			Frames: promptFrames(1), Encoding: audio.EncodingULaw,
		}); err == nil {
			t.Fatal("StartPlayback accepted a prompt with no reference")
		}
	})
}

// expectSilence asserts nothing more reaches the A-leg's phone, with a short deadline. Short is
// correct: every caller has already synchronised on the event that decided the outcome.
func expectSilence(t *testing.T, rig *playbackRig) {
	t.Helper()
	if err := rig.aPhone.conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 1500)
	if _, _, err := rig.aPhone.conn.ReadFromUDP(buf); err == nil {
		t.Error("a frame was sent after the playback stopped")
	}
}
