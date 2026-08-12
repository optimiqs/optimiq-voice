package audio_test

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// goertzel measures the energy at one frequency in a block of samples.
//
// A Goertzel filter rather than an FFT because it answers exactly the question the assertions need —
// "how much 440 Hz is in this?" — for one bin, in one pass, with no library. It is also, not
// coincidentally, how a telephony DTMF detector works, so it is the same measurement a real handset
// would make of these tones.
func goertzel(samples []int16, hertz float64, rate int) float64 {
	omega := 2 * math.Pi * hertz / float64(rate)
	coefficient := 2 * math.Cos(omega)

	var s1, s2 float64
	for _, sample := range samples {
		s0 := float64(sample) + coefficient*s1 - s2
		s2, s1 = s1, s0
	}
	power := s1*s1 + s2*s2 - coefficient*s1*s2
	if power < 0 {
		return 0
	}
	// Normalised by block length so blocks of different sizes are comparable.
	return math.Sqrt(power) / float64(len(samples))
}

// linearise decodes a run of frames back to linear samples, which is what the measurements above
// need: the generator's output is companded, and µ-law is not linear enough to measure directly.
func linearise(t *testing.T, frames [][]byte, encoding audio.Encoding) []int16 {
	t.Helper()
	var samples []int16
	for _, frame := range frames {
		samples = append(samples, audio.DecodeLinear(frame, encoding)...)
	}
	return samples
}

func TestGenerateProducesTheAdvertisedFrequencies(t *testing.T) {
	t.Parallel()

	// Each case names the frequencies the tone plan specifies and one that is NOT in it, because a
	// generator that produced broadband noise would pass an "is there energy at 440 Hz" assertion on
	// its own. The absent frequency is what makes the present ones mean something.
	cases := []struct {
		name    string
		tone    string
		present []float64
		absent  []float64
	}{
		{"dial tone is 350+440", "dial", []float64{350, 440}, []float64{600, 1000}},
		{"ringback is 440+480", "ringback", []float64{440, 480}, []float64{350, 620}},
		{"busy is 480+620", "busy", []float64{480, 620}, []float64{350, 440}},
		{"congestion is 480+620", "congestion", []float64{480, 620}, []float64{350, 440}},
		{"the record beep is 1000", "beep", []float64{1000}, []float64{350, 440, 480}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			tone, err := audio.ParseTone(testCase.tone)
			if err != nil {
				t.Fatalf("ParseTone(%q): %v", testCase.tone, err)
			}
			clip, err := tone.Generate(audio.EncodingULaw)
			if err != nil {
				t.Fatalf("Generate: %v", err)
			}

			// The FIRST segment is the sounding one for every tone here, and measuring the whole clip
			// would average the silence of a cadence into the answer.
			sounding := linearise(t, clip.Frames[:framesOfFirstSegment(tone)], audio.EncodingULaw)

			for _, hertz := range testCase.present {
				if energy := goertzel(sounding, hertz, audio.SampleRate); energy < 1000 {
					t.Errorf("energy at %.0f Hz is %.0f; the tone plan says it should be present", hertz, energy)
				}
			}
			for _, hertz := range testCase.absent {
				if energy := goertzel(sounding, hertz, audio.SampleRate); energy > 300 {
					t.Errorf("energy at %.0f Hz is %.0f; nothing should be there", hertz, energy)
				}
			}
		})
	}
}

// framesOfFirstSegment is how many 20 ms frames the tone's first segment occupies.
func framesOfFirstSegment(tone audio.Tone) int {
	return (tone.Segments[0].DurationMs + audio.FrameDurationMs - 1) / audio.FrameDurationMs
}

func TestCadenceAlternatesToneAndSilence(t *testing.T) {
	t.Parallel()

	tone, err := audio.ParseTone("ringback")
	if err != nil {
		t.Fatalf("ParseTone: %v", err)
	}
	clip, err := tone.Generate(audio.EncodingULaw)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	// 2000 ms on plus 4000 ms off, at 20 ms a frame.
	if want := 300; len(clip.Frames) != want {
		t.Fatalf("ringback is %d frames, want %d (2 s on + 4 s off)", len(clip.Frames), want)
	}

	sounding := linearise(t, clip.Frames[:100], audio.EncodingULaw)
	silent := linearise(t, clip.Frames[100:], audio.EncodingULaw)

	if energy := goertzel(sounding, 440, audio.SampleRate); energy < 1000 {
		t.Errorf("the ON segment has %.0f energy at 440 Hz; it should be ringing", energy)
	}
	if energy := goertzel(silent, 440, audio.SampleRate); energy > 50 {
		t.Errorf("the OFF segment has %.0f energy at 440 Hz; it should be silent", energy)
	}
}

func TestCadenceSegmentsAreWholeCyclesSoTheLoopDoesNotClick(t *testing.T) {
	t.Parallel()

	// The property this asserts is the reason the standard cadences are what they are, and it is
	// what makes a looping tone click-free: every segment starts its oscillators at phase zero, so a
	// segment that did NOT contain a whole number of cycles would step from a non-zero sample to
	// silence at its own end and to a fresh zero at the next repetition. Both are audible.
	cases := []struct {
		name  string
		tone  string
		index int
	}{
		{"ringback 440 across 2 s", "ringback", 0},
		{"busy 480 across 500 ms", "busy", 0},
		{"congestion 480 across 250 ms", "congestion", 0},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			tone, ok := audio.LookupTone(testCase.tone)
			if !ok {
				t.Fatalf("LookupTone(%q) found nothing", testCase.tone)
			}
			segment := tone.Segments[testCase.index]
			for _, hertz := range segment.Freqs {
				cycles := hertz * float64(segment.DurationMs) / 1000
				if math.Abs(cycles-math.Round(cycles)) > 1e-9 {
					t.Errorf("%.0f Hz across %d ms is %.4f cycles; a fractional cycle clicks on every repeat",
						hertz, segment.DurationMs, cycles)
				}
			}
		})
	}
}

func TestGeneratedTonesNeverClip(t *testing.T) {
	t.Parallel()

	// Two summed sinusoids at full scale would overflow; the amplitude constant exists to stop that.
	// A clipped call-progress tone is a buzz that a handset's own detector does not recognise, so
	// this is a correctness assertion rather than a quality one.
	for _, name := range audio.StandardToneNames() {
		tone, ok := audio.LookupTone(name)
		if !ok {
			t.Fatalf("LookupTone(%q) found nothing", name)
		}
		clip, err := tone.Generate(audio.EncodingULaw)
		if err != nil {
			t.Fatalf("Generate(%q): %v", name, err)
		}
		for _, sample := range linearise(t, clip.Frames, audio.EncodingULaw) {
			if sample >= math.MaxInt16 || sample <= math.MinInt16+1 {
				t.Fatalf("%s reaches %d, which is full scale: the tone is clipping", name, sample)
			}
		}
	}
}

func TestParseTone(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		ref      string
		wantErr  error
		segments int
		loop     bool
	}{
		{name: "a standard name", ref: "ringback", segments: 2, loop: true},
		{name: "a standard name is case-insensitive", ref: "RingBack", segments: 2, loop: true},
		{name: "a one-shot marker does not loop", ref: "beep", segments: 1, loop: false},
		{name: "an inline single tone", ref: "1000/250", segments: 1, loop: true},
		{name: "an inline cadence with silence", ref: "480+620/500,/500", segments: 2, loop: true},
		{name: "an unknown name", ref: "trombone", wantErr: audio.ErrUnknownTone},
		{name: "empty", ref: "", wantErr: audio.ErrBadToneSpec},
		{name: "no duration", ref: "440+480", wantErr: audio.ErrUnknownTone},
		{name: "a zero duration", ref: "440/0", wantErr: audio.ErrBadToneSpec},
		{name: "a negative duration", ref: "440/-20", wantErr: audio.ErrBadToneSpec},
		// Above the Nyquist frequency a sinusoid aliases to a different tone entirely, which is
		// worse than a refusal because nobody would look for it in a tone table.
		{name: "a frequency above Nyquist", ref: "5000/100", wantErr: audio.ErrBadToneSpec},
		{name: "a non-numeric frequency", ref: "middle-c/100", wantErr: audio.ErrBadToneSpec},
		{name: "longer than the cap", ref: "440/120000", wantErr: audio.ErrBadToneSpec},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			tone, err := audio.ParseTone(testCase.ref)
			if testCase.wantErr != nil {
				if !errors.Is(err, testCase.wantErr) {
					t.Fatalf("ParseTone(%q) = %v, want %v", testCase.ref, err, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseTone(%q): %v", testCase.ref, err)
			}
			if len(tone.Segments) != testCase.segments {
				t.Errorf("segments = %d, want %d", len(tone.Segments), testCase.segments)
			}
			if tone.Loop != testCase.loop {
				t.Errorf("loop = %v, want %v", tone.Loop, testCase.loop)
			}
		})
	}
}

func TestUnknownToneNamesTheAlternatives(t *testing.T) {
	t.Parallel()

	// A refusal that names what IS available is the difference between a fixable message and a
	// support ticket, and it is the same rule the media-scheme refusals follow.
	_, err := audio.ParseTone("trombone")
	if err == nil {
		t.Fatal("ParseTone accepted a tone that does not exist")
	}
	for _, name := range []string{"ringback", "busy", "beep"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the refusal does not mention %q: %v", name, err)
		}
	}
}

func TestGenerateHonoursTheLegsCompandingLaw(t *testing.T) {
	t.Parallel()

	// A µ-law tone on an A-law leg is a rasp, exactly as a µ-law prompt is. The generator has to
	// produce the leg's own law for the same reason the WAV decoder does.
	tone, _ := audio.LookupTone("beep")
	for _, encoding := range []audio.Encoding{audio.EncodingULaw, audio.EncodingALaw} {
		clip, err := tone.Generate(encoding)
		if err != nil {
			t.Fatalf("Generate(%s): %v", encoding, err)
		}
		if clip.Encoding != encoding {
			t.Errorf("clip encoding = %s, want %s", clip.Encoding, encoding)
		}
		samples := linearise(t, clip.Frames, encoding)
		if energy := goertzel(samples, 1000, audio.SampleRate); energy < 1000 {
			t.Errorf("%s beep has %.0f energy at 1000 Hz", encoding, energy)
		}
	}
}

func TestSilenceToneIsActuallySilent(t *testing.T) {
	t.Parallel()

	// The MOH fallback for an instance with no music mounted. It must be the companding law's own
	// silence byte rather than 0x00, which is a loud value in both laws.
	tone, _ := audio.LookupTone("silence")
	for _, encoding := range []audio.Encoding{audio.EncodingULaw, audio.EncodingALaw} {
		clip, err := tone.Generate(encoding)
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		for _, sample := range linearise(t, clip.Frames, encoding) {
			if sample > 16 || sample < -16 {
				t.Fatalf("%s silence contains a sample of %d", encoding, sample)
			}
		}
	}
}
