package audio_test

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// The writer suite asserts on BYTES ON DISK, because that is what a player at the far end of a
// download link opens. A test that checked a method was called would stay green with the data
// length still at its placeholder zero — which produces a file every player reports as empty.

func TestCreateWAVWritesToAPartialUntilItIsClosed(t *testing.T) {
	// The final path must never name an incomplete file: apps/api's archiver stats the object key
	// the moment `channel.record.stopped` lands and copies whatever is there.
	root := t.TempDir()
	final := filepath.Join(root, "org", "call", "rec-1.wav")

	writer, err := audio.CreateWAV(final)
	if err != nil {
		t.Fatalf("CreateWAV: %v", err)
	}
	if _, err := os.Stat(final); !os.IsNotExist(err) {
		t.Error("the final path exists while the recording is still being written")
	}
	if _, err := os.Stat(final + audio.PartialSuffix); err != nil {
		t.Errorf("the partial file is missing: %v", err)
	}

	if err := writer.WriteSamples(make([]int16, audio.FrameSamples)); err != nil {
		t.Fatalf("WriteSamples: %v", err)
	}
	bytes, err := writer.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := os.Stat(final + audio.PartialSuffix); !os.IsNotExist(err) {
		t.Error("the partial file survived a successful close")
	}
	info, err := os.Stat(final)
	if err != nil {
		t.Fatalf("the finished recording is not at its object key: %v", err)
	}
	if info.Size() != bytes {
		t.Errorf("Close reported %d bytes, the file is %d", bytes, info.Size())
	}
}

func TestCreateWAVPatchesBothLengthFieldsOnClose(t *testing.T) {
	// The two lengths are written as zero and patched at the end, because the length of a recording
	// is not known until it stops. A patch that missed either one produces a file that opens and
	// plays nothing.
	root := t.TempDir()
	final := filepath.Join(root, "rec.wav")

	writer, err := audio.CreateWAV(final)
	if err != nil {
		t.Fatalf("CreateWAV: %v", err)
	}
	const frames = 3
	for index := 0; index < frames; index++ {
		if err := writer.WriteSamples(make([]int16, audio.FrameSamples)); err != nil {
			t.Fatalf("WriteSamples: %v", err)
		}
	}
	if _, err := writer.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	raw, err := os.ReadFile(final)
	if err != nil {
		t.Fatalf("reading the recording: %v", err)
	}
	if string(raw[0:4]) != "RIFF" || string(raw[8:12]) != "WAVE" {
		t.Fatalf("the file is not RIFF/WAVE: %q", raw[:12])
	}

	dataBytes := uint32(frames * audio.FrameSamples * 2)
	if got := binary.LittleEndian.Uint32(raw[40:44]); got != dataBytes {
		t.Errorf("data chunk length = %d, want %d", got, dataBytes)
	}
	if got := binary.LittleEndian.Uint32(raw[4:8]); got != 36+dataBytes {
		t.Errorf("RIFF length = %d, want %d", got, 36+dataBytes)
	}
	// 8 kHz mono PCM16 — the geometry every consumer of these files assumes.
	if got := binary.LittleEndian.Uint16(raw[22:24]); got != 1 {
		t.Errorf("channels = %d, want mono", got)
	}
	if got := binary.LittleEndian.Uint32(raw[24:28]); got != audio.SampleRate {
		t.Errorf("sample rate = %d, want %d", got, audio.SampleRate)
	}
	if got := binary.LittleEndian.Uint16(raw[34:36]); got != 16 {
		t.Errorf("bits per sample = %d, want 16", got)
	}
}

func TestCreateWAVRefusesToOverwriteAPartialInFlight(t *testing.T) {
	// Two recordings racing for one reference is a caller bug, and truncating would make the second
	// silently destroy the first's audio.
	root := t.TempDir()
	final := filepath.Join(root, "rec.wav")

	first, err := audio.CreateWAV(final)
	if err != nil {
		t.Fatalf("CreateWAV: %v", err)
	}
	t.Cleanup(func() { _ = first.Abort() })

	if _, err := audio.CreateWAV(final); err == nil {
		t.Error("a second writer opened a partial that is already in flight")
	}
}

func TestAbortLeavesNoFileAtTheObjectKey(t *testing.T) {
	root := t.TempDir()
	final := filepath.Join(root, "rec.wav")

	writer, err := audio.CreateWAV(final)
	if err != nil {
		t.Fatalf("CreateWAV: %v", err)
	}
	if err := writer.WriteSamples(make([]int16, audio.FrameSamples)); err != nil {
		t.Fatalf("WriteSamples: %v", err)
	}
	if err := writer.Abort(); err != nil {
		t.Fatalf("Abort: %v", err)
	}

	if _, err := os.Stat(final); !os.IsNotExist(err) {
		t.Error("an aborted recording left a file at its object key; the archiver would copy it")
	}
	if _, err := os.Stat(final + audio.PartialSuffix); !os.IsNotExist(err) {
		t.Error("an aborted recording left its partial behind")
	}
}

func TestDurationMsCountsWhatWasWritten(t *testing.T) {
	writer, err := audio.CreateWAV(filepath.Join(t.TempDir(), "rec.wav"))
	if err != nil {
		t.Fatalf("CreateWAV: %v", err)
	}
	t.Cleanup(func() { _ = writer.Abort() })

	for index := 0; index < 50; index++ {
		if err := writer.WriteSamples(make([]int16, audio.FrameSamples)); err != nil {
			t.Fatalf("WriteSamples: %v", err)
		}
	}
	if got := writer.DurationMs(); got != 1000 {
		t.Errorf("DurationMs after 50 frames = %d, want 1000", got)
	}
}

func TestMixIntoSaturatesRatherThanWrapping(t *testing.T) {
	// A wrap turns a loud moment into a full-amplitude sign flip, which is not "slightly clipped" —
	// it is a bang. Clamping produces the mild distortion every mixer produces when two people
	// shout at once.
	destination := []int16{30000, -30000, 100}
	audio.MixInto(destination, []int16{30000, -30000, -50})

	if destination[0] != 32767 {
		t.Errorf("a positive overflow mixed to %d, want the ceiling 32767", destination[0])
	}
	if destination[1] != -32768 {
		t.Errorf("a negative overflow mixed to %d, want the floor -32768", destination[1])
	}
	if destination[2] != 50 {
		t.Errorf("an in-range sum mixed to %d, want 50", destination[2])
	}
}

func TestMixIntoStopsAtTheShorterFrame(t *testing.T) {
	// A short frame from one direction must not read past the other's buffer.
	destination := []int16{1, 2, 3}
	audio.MixInto(destination, []int16{10})
	if destination[0] != 11 || destination[1] != 2 || destination[2] != 3 {
		t.Errorf("MixInto with a short source = %v, want [11 2 3]", destination)
	}
}

func TestDecodeLinearRoundTripsThroughBothLaws(t *testing.T) {
	// The recorder writes linear, so a frame that came in as G.711 has to come back out recognisably.
	// G.711 is lossy, so this asserts proximity rather than equality — a decoder with a sign error
	// would be nowhere near.
	for _, encoding := range []audio.Encoding{audio.EncodingULaw, audio.EncodingALaw} {
		for _, sample := range []int16{0, 1000, -1000, 16000, -16000} {
			var encoded byte
			if encoding == audio.EncodingALaw {
				encoded = audio.LinearToALaw(sample)
			} else {
				encoded = audio.LinearToULaw(sample)
			}
			decoded := audio.DecodeLinear([]byte{encoded}, encoding)
			if len(decoded) != 1 {
				t.Fatalf("DecodeLinear returned %d samples for one byte", len(decoded))
			}
			if diff := int(decoded[0]) - int(sample); diff > 600 || diff < -600 {
				t.Errorf("%s round trip of %d gave %d, which is further off than G.711 quantisation",
					encoding, sample, decoded[0])
			}
		}
	}
}
