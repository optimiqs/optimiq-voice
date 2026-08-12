package audio

import "math"

// The 8 kHz ↔ 16 kHz boundary, which is the only rate conversion this service performs.
//
// # Why the mix rate is 8 kHz and not 16
//
// Everything above rung 0 is built on `SampleRate = 8000`: the recorder writes it, the WAV parser
// refuses anything else, the frame geometry is derived from it, and both G.711 laws are native to
// it. Moving the internal rate to 16 kHz to suit one codec would mean resampling every G.711
// participant in every conference — which is every participant on every deployment today — to
// benefit a wideband leg that may not exist. So the MIX BUS is 8 kHz linear PCM and G.722 is
// resampled at its own edge, which puts the cost on the leg that asked for it.
//
// The price is stated plainly: a G.722 leg in a conference is band-limited to 4 kHz by the mix. It
// still gets wideband quality on a two-party PASSTHROUGH bridge, which is where a wideband leg
// actually is almost all of the time, because passthrough never decodes at all. When there is a
// deployment whose conferences are mostly wideband, the answer is a second 16 kHz mix bus for those
// rooms rather than a resample on every narrowband leg — and the seam for it is `Mixer.rate`, which
// is why the mixer takes its frame size from a constant rather than assuming one.
//
// # Why a windowed-sinc half-band rather than linear interpolation
//
// Linear interpolation upsampling leaves the 4-8 kHz image of the original signal in the output at
// only ~13 dB down, which on a wideband leg is heard as a metallic edge on sibilants — the classic
// "narrowband audio played through a wideband codec" sound. Decimating without a filter is worse:
// energy above 4 kHz folds back into the audible band as aliasing, and speech has plenty of it. A
// 31-tap Hamming-windowed sinc is about 40 dB of stopband rejection, costs 31 multiply-accumulates
// per output sample, and is computed once at init rather than carried as a table nobody can check.

// resampleTaps is the FIR length, and it is odd so the filter has an exact integer group delay of
// (taps-1)/2 samples — which is what lets the delay be compensated by priming the history rather
// than by a fractional-delay correction nobody would get right.
//
// 31 taps at 16 kHz is ~1.9 ms of delay on the wideband side, under a tenth of a frame, and it buys
// a transition band narrow enough to leave speech alone. Longer would be better filtering for
// latency that starts to be measurable in a conference; shorter starts to let the image through.
const resampleTaps = 31

// resampleKernel is a Hamming-windowed sinc lowpass at a quarter of the 16 kHz rate — 4 kHz, which
// is exactly the Nyquist frequency of the 8 kHz side and therefore the only correct cutoff for both
// directions.
var resampleKernel = buildResampleKernel()

func buildResampleKernel() [resampleTaps]float64 {
	var kernel [resampleTaps]float64
	center := float64(resampleTaps-1) / 2
	// 0.25 cycles per sample at 16 kHz is 4 kHz.
	const cutoff = 0.25

	var sum float64
	for i := 0; i < resampleTaps; i++ {
		offset := float64(i) - center
		var sinc float64
		if offset == 0 {
			sinc = 2 * cutoff
		} else {
			sinc = math.Sin(2*math.Pi*cutoff*offset) / (math.Pi * offset)
		}
		window := 0.54 - 0.46*math.Cos(2*math.Pi*float64(i)/float64(resampleTaps-1))
		kernel[i] = sinc * window
		sum += kernel[i]
	}
	// Normalised to unity DC gain, so a resample changes the band and never the LEVEL. A filter that
	// quietly attenuated by a decibel would show up as "the wideband phones are quieter", which is
	// the kind of defect that gets blamed on the handset.
	for i := range kernel {
		kernel[i] /= sum
	}
	return kernel
}

// Resampler8to16 upsamples narrowband audio to the wideband rate, keeping filter state across calls.
//
// STATEFUL for the same reason the codec is: a filter restarted per frame discards the tail of the
// previous one, which is a discontinuity every 20 ms — an 50 Hz buzz under the speech, exactly the
// artefact a naive per-packet resampler produces.
type Resampler8to16 struct {
	history [resampleTaps]float64
}

// Resample converts 8 kHz samples to 16 kHz.
func (r *Resampler8to16) Resample(in []int16) []int16 {
	out := make([]int16, 0, len(in)*2)
	for _, sample := range in {
		// Zero-stuffing: one input sample followed by one zero doubles the rate and puts a mirror
		// image of the signal above 4 kHz, which the kernel below then removes. The factor of two
		// restores the level the stuffed zeros halved.
		for _, stuffed := range [2]float64{float64(sample), 0} {
			copy(r.history[:resampleTaps-1], r.history[1:])
			r.history[resampleTaps-1] = stuffed
			out = append(out, clampToInt16(2*convolve(&r.history)))
		}
	}
	return out
}

// Resampler16to8 downsamples wideband audio to the mix rate. Stateful; see Resampler8to16.
type Resampler16to8 struct {
	history [resampleTaps]float64
	// phase alternates so exactly every second filtered sample is kept. Held across calls because a
	// frame of 16 kHz audio is an even number of samples today and need not be tomorrow, and a phase
	// that reset per frame would drop or duplicate a sample whenever it was not.
	phase int
}

// Resample converts 16 kHz samples to 8 kHz.
func (r *Resampler16to8) Resample(in []int16) []int16 {
	out := make([]int16, 0, (len(in)+1)/2)
	for _, sample := range in {
		copy(r.history[:resampleTaps-1], r.history[1:])
		r.history[resampleTaps-1] = float64(sample)
		if r.phase == 0 {
			// Filter FIRST, then decimate. The other order is what aliasing is.
			out = append(out, clampToInt16(convolve(&r.history)))
		}
		r.phase ^= 1
	}
	return out
}

func convolve(history *[resampleTaps]float64) float64 {
	var sum float64
	for i := 0; i < resampleTaps; i++ {
		sum += history[i] * resampleKernel[i]
	}
	return sum
}

func clampToInt16(value float64) int16 {
	switch {
	case value > math.MaxInt16:
		return math.MaxInt16
	case value < math.MinInt16:
		return math.MinInt16
	default:
		return int16(math.Round(value))
	}
}
