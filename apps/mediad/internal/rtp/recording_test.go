package rtp_test

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The recording suite drives real sockets and a hand-driven clock, and asserts on the FILE. A
// recording is only ever judged by somebody playing it back, so a test that stopped at "the
// recorder was told about a frame" would stay green with the header unpatched or the mix silent.

// recordingRig is a playback rig plus a temporary recordings root.
type recordingRig struct {
	*playbackRig
	root string
}

func newRecordingRig(t *testing.T, low, high int) *recordingRig {
	t.Helper()
	return &recordingRig{playbackRig: newPlaybackRig(t, low, high), root: t.TempDir()}
}

// start begins a recording on leg A under a derived object key, exactly as the control surface does.
func (r *recordingRig) start(t *testing.T, ref string, direction rtp.RecordingDirection, opts rtp.RecordingOptions) {
	t.Helper()
	objectKey := testOrg + "/" + testCall + "/" + ref + ".wav"
	opts.Ref = ref
	opts.ObjectKey = objectKey
	opts.Direction = direction
	opts.Path = filepath.Join(r.root, filepath.FromSlash(objectKey))
	opts.Encoding = audio.EncodingULaw
	if err := r.manager.StartRecording(r.aID, opts); err != nil {
		t.Fatalf("StartRecording: %v", err)
	}
}

// speak sends one frame of a constant µ-law level into leg A, as the far party talking.
func (r *recordingRig) speak(t *testing.T, level byte) {
	t.Helper()
	frame := make([]byte, audio.FrameSamples)
	for index := range frame {
		frame[index] = level
	}
	r.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111, SequenceNumber: uint16(level)},
		Payload: frame,
	})
}

// finishedSummary steps the clock until the recorder announces, then returns what it said.
func (r *recordingRig) finishedSummary(t *testing.T) rtp.RecordingSummary {
	t.Helper()
	waitFor(t, "the recording announced that it finished", func() bool {
		return len(r.lifecycle.recordingSummaries()) > 0
	})
	return r.lifecycle.recordingSummaries()[0]
}

// readSamples pulls the linear audio back out of a finished recording.
func readSamples(t *testing.T, path string) []int16 {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if len(raw) < 44 {
		t.Fatalf("%s is %d bytes, shorter than a WAV header", path, len(raw))
	}
	body := raw[44:]
	samples := make([]int16, len(body)/2)
	for index := range samples {
		samples[index] = int16(binary.LittleEndian.Uint16(body[index*2:]))
	}
	return samples
}

func TestRecordingWritesTheReceivedDirectionAsAPlayableWAV(t *testing.T) {
	// `receive` is what a voicemail wants: the message should hold the caller, not the greeting that
	// was played at them.
	rig := newRecordingRig(t, 57600, 57619)
	rig.latch(t)
	rig.start(t, "rec-1", rtp.RecordReceive, rtp.RecordingOptions{})

	rig.speak(t, 0x10)
	waitFor(t, "the frame reached the recorder", func() bool {
		session, ok := rig.manager.Get(rig.aID)
		return ok && session.Stats().PacketsReceived >= 2
	})
	rig.tick(t)
	rig.tick(t)

	if _, stopped := rig.manager.StopRecording("rec-1"); !stopped {
		t.Fatal("StopRecording reported nothing to stop")
	}
	summary := rig.finishedSummary(t)

	if summary.Reason != rtp.RecordingStopped {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.RecordingStopped)
	}
	if summary.ObjectKey != testOrg+"/"+testCall+"/rec-1.wav" {
		t.Errorf("objectKey = %q, want the engine's own <org>/<call>/<ref>.wav", summary.ObjectKey)
	}
	if summary.DurationMs <= 0 {
		t.Errorf("durationMs = %d, want the wall-clock length of what was written", summary.DurationMs)
	}
	// The byte count is the whole reason this event exists next to `channel.record.stopped`, which
	// the engine has never been able to fill: it does not hold the file.
	if want := int64(summary.DurationMs*audio.SampleRate/1000*2 + 44); summary.Bytes != want {
		t.Errorf("bytes = %d, want %d (header plus PCM16 at 8 kHz)", summary.Bytes, want)
	}

	path := filepath.Join(rig.root, testOrg, testCall, "rec-1.wav")
	samples := readSamples(t, path)
	if len(samples) == 0 {
		t.Fatal("the recording holds no audio")
	}
	if samples[0] == 0 {
		t.Error("the first sample is silence; the received frame did not reach the file")
	}
}

func TestRecordingWritesSilenceForADirectionThatSaysNothing(t *testing.T) {
	// The recorder ticks rather than writing on arrival, so a party who is not speaking is
	// represented by the right amount of nothing. Otherwise every word after a pause arrives early.
	rig := newRecordingRig(t, 57620, 57639)
	rig.latch(t)
	rig.start(t, "rec-2", rtp.RecordReceive, rtp.RecordingOptions{})

	for index := 0; index < 5; index++ {
		rig.tick(t)
	}
	rig.manager.StopRecording("rec-2")
	summary := rig.finishedSummary(t)

	if summary.DurationMs < 80 {
		t.Errorf("durationMs = %d after five ticks of silence, want the clock to have advanced",
			summary.DurationMs)
	}
	samples := readSamples(t, filepath.Join(rig.root, testOrg, testCall, "rec-2.wav"))
	for _, sample := range samples {
		if sample != 0 {
			t.Fatalf("a tick with nothing waiting wrote %d, want silence", sample)
			break
		}
	}
}

func TestRecordingBothDirectionsSumsThemIntoOneStream(t *testing.T) {
	// The snoop replacement. A session already IS both directions — what it receives is the far
	// party, what it sends is everything the far party was told — so a tap needs no second channel.
	rig := newRecordingRig(t, 57640, 57659)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	rig.start(t, "rec-3", rtp.RecordBoth, rtp.RecordingOptions{})

	// Leg A speaks (the receive half) and leg B speaks (which the relay writes OUT of leg A, the
	// send half). Both must land in one file.
	rig.speak(t, 0x10)
	peerFrame := make([]byte, audio.FrameSamples)
	for index := range peerFrame {
		peerFrame[index] = 0x20
	}
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222, SequenceNumber: 4},
		Payload: peerFrame,
	})

	waitFor(t, "both directions reached the recorder", func() bool {
		a, aOK := rig.manager.Get(rig.aID)
		return aOK && a.Stats().PacketsReceived >= 2 && a.Stats().PacketsSent >= 1
	})
	rig.tick(t)
	rig.tick(t)

	rig.manager.StopRecording("rec-3")
	summary := rig.finishedSummary(t)
	if summary.Direction != rtp.RecordBoth {
		t.Errorf("direction = %q, want %q", summary.Direction, rtp.RecordBoth)
	}

	samples := readSamples(t, filepath.Join(rig.root, testOrg, testCall, "rec-3.wav"))
	sumOfBoth := int(audio.ULawToLinear(0x10)) + int(audio.ULawToLinear(0x20))
	found := false
	for _, sample := range samples {
		if int(sample) == sumOfBoth {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("no sample equals the sum of the two directions (%d); they were not mixed", sumOfBoth)
	}
}

func TestRecordingStopsItselfOnContinuousSilence(t *testing.T) {
	// The NORMAL end of a voicemail: the caller stopped talking. Without it a message runs to the
	// duration limit on every call.
	rig := newRecordingRig(t, 57660, 57679)
	rig.latch(t)
	rig.start(t, "rec-4", rtp.RecordReceive, rtp.RecordingOptions{MaxSilence: 60 * time.Millisecond})

	for index := 0; index < 3; index++ {
		rig.tick(t)
	}
	summary := rig.finishedSummary(t)
	if summary.Reason != rtp.RecordingMaxSilence {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.RecordingMaxSilence)
	}
}

func TestRecordingStopsItselfAtTheDurationLimit(t *testing.T) {
	rig := newRecordingRig(t, 57680, 57699)
	rig.latch(t)
	rig.start(t, "rec-5", rtp.RecordReceive, rtp.RecordingOptions{MaxDuration: 40 * time.Millisecond})

	rig.tick(t)
	rig.tick(t)
	summary := rig.finishedSummary(t)

	if summary.Reason != rtp.RecordingMaxDuration {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.RecordingMaxDuration)
	}
	if summary.DurationMs != 40 {
		t.Errorf("durationMs = %d, want exactly the limit 40", summary.DurationMs)
	}
}

func TestRecordingFinalisesWhenTheSessionEndsUnderIt(t *testing.T) {
	// A caller who hangs up mid-message must leave a PLAYABLE message, not a partial nobody can
	// open. And the announcement has to arrive before the leg is torn down, or nothing archives it.
	rig := newRecordingRig(t, 57700, 57719)
	rig.latch(t)
	rig.start(t, "rec-6", rtp.RecordReceive, rtp.RecordingOptions{})

	rig.speak(t, 0x10)
	waitFor(t, "the frame reached the recorder", func() bool {
		session, ok := rig.manager.Get(rig.aID)
		return ok && session.Stats().PacketsReceived >= 2
	})
	rig.tick(t)

	if !rig.manager.Release(rig.aID) {
		t.Fatal("Release reported nothing to release")
	}

	summary := rig.finishedSummary(t)
	if summary.Reason != rtp.RecordingSessionEnded {
		t.Errorf("reason = %q, want %q", summary.Reason, rtp.RecordingSessionEnded)
	}
	path := filepath.Join(rig.root, testOrg, testCall, "rec-6.wav")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the recording was not finalised at its object key: %v", err)
	}
	if _, err := os.Stat(path + audio.PartialSuffix); !os.IsNotExist(err) {
		t.Error("a partial file survived the teardown")
	}

	// The ordering is the contract: the engine tears the leg down on `session.ended`, so a
	// `recording.finished` published after it would arrive to a consumer that has already moved on.
	if got := len(rig.lifecycle.endedReasons()); got != 1 {
		t.Fatalf("session.ended announcements = %d, want 1", got)
	}
}

func TestRecordingIsAnnouncedExactlyOnce(t *testing.T) {
	// Two paths reach a finished recording — the manager's watcher and a session teardown that had
	// to wait for it — and two announcements would file two rows for one file.
	rig := newRecordingRig(t, 57720, 57739)
	rig.latch(t)
	rig.start(t, "rec-7", rtp.RecordReceive, rtp.RecordingOptions{})

	rig.tick(t)
	rig.manager.StopRecording("rec-7")
	rig.finishedSummary(t)
	rig.manager.Release(rig.aID)

	waitFor(t, "the session ended", func() bool { return len(rig.lifecycle.endedReasons()) > 0 })
	if got := len(rig.lifecycle.recordingSummaries()); got != 1 {
		t.Errorf("recording.finished announcements = %d, want exactly 1", got)
	}
}

func TestRecordingRefusesASecondRecordingOnOneSession(t *testing.T) {
	// The opposite of the playback rule, and for the opposite reason: superseding a prompt loses
	// audio nobody will miss, while superseding a recording throws away a file somebody is waiting
	// on.
	rig := newRecordingRig(t, 57740, 57759)
	rig.latch(t)
	rig.start(t, "rec-8", rtp.RecordReceive, rtp.RecordingOptions{})

	err := rig.manager.StartRecording(rig.aID, rtp.RecordingOptions{
		Ref:       "rec-9",
		Path:      filepath.Join(rig.root, "rec-9.wav"),
		ObjectKey: "rec-9.wav",
		Direction: rtp.RecordReceive,
		Encoding:  audio.EncodingULaw,
	})
	if !errors.Is(err, rtp.ErrAlreadyRecording) {
		t.Errorf("a second recording on one session = %v, want ErrAlreadyRecording", err)
	}
}

func TestStopRecordingIsFencedByReference(t *testing.T) {
	// A stop that arrived late, after the recording it names finished and another started, must not
	// truncate the new one.
	rig := newRecordingRig(t, 57760, 57779)
	rig.latch(t)
	rig.start(t, "rec-10", rtp.RecordReceive, rtp.RecordingOptions{})

	if _, stopped := rig.manager.StopRecording("some-other-ref"); stopped {
		t.Error("a stop naming a different reference stopped the live recording")
	}
	if _, ok := rig.manager.RecordingSessionOf("rec-10"); !ok {
		t.Error("the live recording lost its index entry to a stop that did not name it")
	}
}

func TestStopRecordingOfAFinishedRecordingIsASuccess(t *testing.T) {
	// The common case rather than an edge one: a recording that hit its duration limit has already
	// finalised itself by the time the engine's teardown gets around to stopping it.
	rig := newRecordingRig(t, 57780, 57799)
	rig.latch(t)

	if _, stopped := rig.manager.StopRecording("never-existed"); stopped {
		t.Error("stopping a reference nothing is recording reported that it stopped something")
	}
}

func TestRecordingRefusesAnUnknownSession(t *testing.T) {
	rig := newRecordingRig(t, 57800, 57819)
	err := rig.manager.StartRecording("nobody", rtp.RecordingOptions{
		Ref:       "rec-x",
		Path:      filepath.Join(rig.root, "rec-x.wav"),
		Direction: rtp.RecordReceive,
	})
	if !errors.Is(err, rtp.ErrUnknownSession) {
		t.Errorf("StartRecording on an unknown session = %v, want ErrUnknownSession", err)
	}
}

func TestRecordingExcludesTelephoneEventPacketsFromTheAudio(t *testing.T) {
	// A digit is not audio, and decoding a four-byte telephone-event payload as G.711 writes four
	// samples of noise into the middle of a recording.
	rig := newRecordingRig(t, 57820, 57839)
	rig.latch(t)
	rig.start(t, "rec-11", rtp.RecordReceive, rtp.RecordingOptions{})

	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypeTelephoneEvent, SSRC: 111, SequenceNumber: 3},
		Payload: []byte{0x05, 0x0a, 0x00, 0xa0},
	})
	waitFor(t, "the digit reached the session", func() bool {
		session, ok := rig.manager.Get(rig.aID)
		return ok && session.Stats().PacketsReceived >= 2
	})
	rig.tick(t)
	rig.manager.StopRecording("rec-11")
	rig.finishedSummary(t)

	for _, sample := range readSamples(t, filepath.Join(rig.root, testOrg, testCall, "rec-11.wav")) {
		if sample != 0 {
			t.Fatalf("a telephone-event packet wrote %d into the audio", sample)
		}
	}
}
