package audio_test

import (
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

func TestUpsampleDoublesTheRateAndKeepsTheLevel(t *testing.T) {
	t.Parallel()

	// A resample changes the band, never the level.
	cases := []float64{300, 1000, 2000, 3000}

	for _, hertz := range cases {
		t.Run(hertzName(hertz), func(t *testing.T) {
			t.Parallel()

			in := sine(1600, hertz, 8000, audio.SampleRate)
			var up audio.Resampler8to16
			out := up.Resample(in)

			if len(out) != 2*len(in) {
				t.Fatalf("upsampling %d samples produced %d, want %d", len(in), len(out), 2*len(in))
			}
			want := goertzel(in[200:], hertz, audio.SampleRate)
			got := goertzel(out[400:], hertz, wideRate)
			if ratio := got / want; ratio < 0.9 || ratio > 1.1 {
				t.Errorf("level survived at %.3f×", ratio)
			}
		})
	}
}

func TestUpsampleRejectsTheImageItCreates(t *testing.T) {
	t.Parallel()

	// Zero-stuffing puts a mirror image of the signal above 4 kHz; the kernel must remove it.
	const hertz = 1000
	in := sine(1600, hertz, 8000, audio.SampleRate)
	var up audio.Resampler8to16
	out := up.Resample(in)

	wanted := goertzel(out[400:], hertz, wideRate)
	// The image of a 1 kHz tone stuffed to 16 kHz lands at 8000-1000 = 7000 Hz.
	image := goertzel(out[400:], 7000, wideRate)
	if image > wanted/100 {
		t.Errorf("the image at 7 kHz is %.1f against %.1f of signal — under 40 dB of rejection",
			image, wanted)
	}
}

func TestDownsampleHalvesTheRateAndKeepsTheLevel(t *testing.T) {
	t.Parallel()

	in := sine(3200, 1000, 8000, wideRate)
	var down audio.Resampler16to8
	out := down.Resample(in)

	if len(out) != len(in)/2 {
		t.Fatalf("downsampling %d samples produced %d, want %d", len(in), len(out), len(in)/2)
	}
	want := goertzel(in[400:], 1000, wideRate)
	got := goertzel(out[200:], 1000, audio.SampleRate)
	if ratio := got / want; ratio < 0.9 || ratio > 1.1 {
		t.Errorf("level survived at %.3f×", ratio)
	}
}

func TestDownsampleFiltersBeforeItDecimates(t *testing.T) {
	t.Parallel()

	// Decimating without filtering folds energy above 4 kHz back into the audible band.
	in := sine(3200, 6000, 8000, wideRate)
	var down audio.Resampler16to8
	out := down.Resample(in)

	// 6 kHz decimated to 8 kHz without a filter would alias to 8000-6000 = 2000 Hz.
	if aliased := goertzel(out[200:], 2000, audio.SampleRate); aliased > 200 {
		t.Errorf("a 6 kHz tone folded back to 2 kHz with %.1f of energy; the filter is not running",
			aliased)
	}
}

func TestResamplersCarryStateAcrossFrames(t *testing.T) {
	t.Parallel()

	// Resampling in frames must match resampling the whole run, which holds only if the filter
	// history survives the call boundary.
	in := sine(1600, 1000, 8000, audio.SampleRate)

	var whole audio.Resampler8to16
	reference := whole.Resample(in)

	var framed audio.Resampler8to16
	var pieces []int16
	for offset := 0; offset < len(in); offset += audio.FrameSamples {
		pieces = append(pieces, framed.Resample(in[offset:offset+audio.FrameSamples])...)
	}

	if len(pieces) != len(reference) {
		t.Fatalf("framed resampling produced %d samples, whole produced %d", len(pieces), len(reference))
	}
	for index := range reference {
		if pieces[index] != reference[index] {
			t.Fatalf("sample %d differs (%d vs %d): the filter history did not survive a frame boundary",
				index, pieces[index], reference[index])
		}
	}
}

func hertzName(hertz float64) string {
	switch hertz {
	case 300:
		return "300 Hz"
	case 1000:
		return "1 kHz"
	case 2000:
		return "2 kHz"
	default:
		return "3 kHz"
	}
}
