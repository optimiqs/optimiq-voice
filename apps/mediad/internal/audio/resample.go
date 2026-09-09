package audio

import "math"

// The 8 kHz ↔ 16 kHz boundary, the only rate conversion this service performs.
//
// The mix bus is 8 kHz linear PCM and G.722 is resampled at its own edge, so the cost falls on the
// wideband leg rather than on every G.711 participant. The price is that a G.722 leg in a
// conference is band-limited to 4 kHz; a two-party passthrough bridge never decodes and keeps full
// bandwidth.
//
// A 31-tap Hamming-windowed sinc rather than linear interpolation: linear upsampling leaves the
// 4-8 kHz image only ~13 dB down (audible as a metallic edge on sibilants) and unfiltered
// decimation aliases speech energy above 4 kHz back into band. This gives ~40 dB of stopband
// rejection for 31 multiply-accumulates per output sample.

// resampleTaps is the FIR length. Odd, so the group delay is an exact integer (taps-1)/2 samples
// and can be compensated by priming the history rather than by a fractional-delay correction.
// 31 taps at 16 kHz is ~1.9 ms, under a tenth of a frame.
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
	for i := range resampleTaps {
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
	// Normalised to unity DC gain, so a resample changes the band and never the level.
	for i := range kernel {
		kernel[i] /= sum
	}
	return kernel
}

// Resampler8to16 upsamples narrowband audio to the wideband rate. Stateful: a filter restarted per
// frame discards the previous tail, giving a discontinuity every 20 ms — a 50 Hz buzz under the
// speech.
type Resampler8to16 struct {
	history [resampleTaps]float64
}

// Resample converts 8 kHz samples to 16 kHz.
func (r *Resampler8to16) Resample(in []int16) []int16 {
	return r.resampleInto(make([]int16, 0, len(in)*2), in)
}

// resampleInto is Resample writing into a caller-supplied buffer, for the packet path. `dst` is
// expected zero-length with capacity; it is appended to and returned, so an undersized one works.
func (r *Resampler8to16) resampleInto(dst, in []int16) []int16 {
	out := dst[:0]
	for _, sample := range in {
		// Zero-stuffing doubles the rate and mirrors the signal above 4 kHz, which the kernel then
		// removes. The factor of two restores the level the stuffed zeros halved.
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
	// phase alternates so exactly every second filtered sample is kept. Held across calls so an
	// odd-length frame does not drop or duplicate a sample.
	phase int
}

// Resample converts 16 kHz samples to 8 kHz.
func (r *Resampler16to8) Resample(in []int16) []int16 {
	return r.resampleInto(make([]int16, 0, (len(in)+1)/2), in)
}

// resampleInto is Resample writing into a caller-supplied buffer.
func (r *Resampler16to8) resampleInto(dst, in []int16) []int16 {
	out := dst[:0]
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
	for i := range resampleTaps {
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
