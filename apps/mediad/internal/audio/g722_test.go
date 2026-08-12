package audio_test

import (
	"bytes"
	"math"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// wideRate is G.722's own sample rate. Not its RTP clock rate, which is 8000 — see the note in
// g722.go about the specification's most famous erratum.
const wideRate = 16000

// sine builds a test signal at a rate and an amplitude.
func sine(samples int, hertz float64, amplitude float64, rate int) []int16 {
	out := make([]int16, samples)
	for i := range out {
		out[i] = int16(amplitude * math.Sin(2*math.Pi*hertz*float64(i)/float64(rate)))
	}
	return out
}

func TestG722RoundTripPreservesToneAndLevel(t *testing.T) {
	t.Parallel()

	// The two bands are coded by two completely different quantisers — six bits below 4 kHz and two
	// above it — so a codec can be right in one and wrong in the other. Both are asserted, and each
	// case also asserts that the energy did NOT appear in the other band, which is what catches a
	// QMF wired up backwards.
	cases := []struct {
		name      string
		hertz     float64
		elsewhere float64
	}{
		{"low band, 300 Hz", 300, 6000},
		{"low band, 1 kHz", 1000, 6000},
		{"low band, 3 kHz", 3000, 6000},
		{"high band, 5 kHz", 5000, 1000},
		{"high band, 6 kHz", 6000, 1000},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			const amplitude = 8000
			in := sine(3200, testCase.hertz, amplitude, wideRate)
			out := audio.NewG722Decoder().Decode(audio.NewG722Encoder().Encode(in))

			if len(out) != len(in) {
				t.Fatalf("round trip produced %d samples from %d", len(out), len(in))
			}

			// The first 400 samples are skipped everywhere in this file: the QMF has a 24-tap history
			// and both predictors start from a reset state, so the opening of any stream is a
			// transient. That is a property of sub-band ADPCM, not a defect, and measuring across it
			// would be measuring the codec's start-up rather than its steady state.
			want := goertzel(in[400:], testCase.hertz, wideRate)
			got := goertzel(out[400:], testCase.hertz, wideRate)
			if ratio := got / want; ratio < 0.9 || ratio > 1.1 {
				t.Errorf("energy at %.0f Hz survived at %.2f×; a codec that changes the LEVEL is heard "+
					"as one side being quiet", testCase.hertz, ratio)
			}
			if leaked := goertzel(out[400:], testCase.elsewhere, wideRate); leaked > want/50 {
				t.Errorf("%.0f Hz of energy leaked to %.0f Hz (%.0f vs %.0f): the sub-bands are crossed",
					testCase.hertz, testCase.elsewhere, leaked, want)
			}
		})
	}
}

func TestG722PacksOneOctetPerSamplePair(t *testing.T) {
	t.Parallel()

	// The framing above this codec assumes it: 20 ms of G.722 is 320 input samples and 160 octets,
	// which is byte-for-byte the same payload length a 20 ms G.711 frame carries. That is why nothing
	// in the packet path needed a per-codec frame size.
	cases := []struct {
		name       string
		samples    int
		wantOctets int
	}{
		{"one 20 ms frame", 320, 160},
		{"two frames", 640, 320},
		{"a single pair", 2, 1},
		// An odd count drops its last sample rather than inventing a companion for it, which would
		// leave the encoder and every decoder one sample apart for the rest of the call.
		{"an odd count drops the orphan", 321, 160},
		{"nothing", 0, 0},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			octets := audio.NewG722Encoder().Encode(sine(testCase.samples, 1000, 8000, wideRate))
			if len(octets) != testCase.wantOctets {
				t.Errorf("%d samples encoded to %d octets, want %d",
					testCase.samples, len(octets), testCase.wantOctets)
			}
			decoded := audio.NewG722Decoder().Decode(octets)
			if len(decoded) != testCase.wantOctets*2 {
				t.Errorf("%d octets decoded to %d samples, want %d",
					len(octets), len(decoded), testCase.wantOctets*2)
			}
		})
	}
}

func TestG722IsDeterministicFromAResetState(t *testing.T) {
	t.Parallel()

	// The predictors adapt, so the same input has to produce the same octets only from the same
	// start. This is what a Reset has to guarantee, and it is what lets a stream be restarted after
	// a re-negotiation without the far end hearing garbage while the two ends re-converge.
	in := sine(1600, 800, 6000, wideRate)

	first := audio.NewG722Encoder()
	a := first.Encode(in)

	first.Reset()
	b := first.Encode(in)

	c := audio.NewG722Encoder().Encode(in)

	if !bytes.Equal(a, b) {
		t.Error("a reset encoder produced different octets from the same input")
	}
	if !bytes.Equal(a, c) {
		t.Error("a fresh encoder produced different octets from a reset one")
	}
}

func TestG722StateIsPerStream(t *testing.T) {
	t.Parallel()

	// Encoding two streams through one encoder is the mistake this asserts against: the predictor
	// adapts to the INTERLEAVING, so both streams come out as plausible octets that neither decoder
	// can follow. The assertion is that splitting one signal across two encoders does NOT reproduce
	// what one encoder makes of the whole thing — which is the same statement from the other side.
	in := sine(1600, 800, 6000, wideRate)

	whole := audio.NewG722Encoder().Encode(in)
	firstHalf := audio.NewG722Encoder().Encode(in[:800])
	secondHalf := audio.NewG722Encoder().Encode(in[800:])

	if bytes.Equal(whole, append(append([]byte{}, firstHalf...), secondHalf...)) {
		t.Error("two encoders reproduced one encoder's output; the codec is not carrying state, " +
			"which means an endpoint would drift out of step with it")
	}
}

func TestG722SilenceStaysSilent(t *testing.T) {
	t.Parallel()

	// An ADPCM predictor fed silence must converge to silence rather than to a low-level hum, which
	// is what a scale-factor adaptation with a sign error produces — audible on every held line.
	silence := make([]int16, 3200)
	out := audio.NewG722Decoder().Decode(audio.NewG722Encoder().Encode(silence))

	var peak int16
	for _, sample := range out[400:] {
		if sample > peak {
			peak = sample
		} else if -sample > peak {
			peak = -sample
		}
	}
	if peak > 64 {
		t.Errorf("silence decoded to a peak of %d; the codec is generating noise from nothing", peak)
	}
}
