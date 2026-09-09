package audio

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
)

// Call-progress tone synthesis: a sum of sinusoids cut into the same 20 ms frames a WAV clip
// produces, so nothing below Clip knows a tone from a prompt. Generated rather than shipped as WAV
// files so ringback does not depend on a mounted prompt store.
//
// The frequencies come from the North American Precise Tone Plan (Bellcore TR-TSY-000181) and
// ITU-T E.180/Q.35. They are not interchangeable: a handset's own tone detector is a filter bank
// keyed on these exact pairs.
//
// Every segment starts its oscillators at phase zero. That is click-free only because the standard
// cadences are integer multiples of the standard periods (440 Hz over 2000 ms is exactly 880
// cycles); a hand-written `tone:` cadence can break it, and then owns the click.

// ToneSegment is one interval of a cadence: either a sum of frequencies, or silence.
type ToneSegment struct {
	// Freqs are the sinusoid frequencies in hertz, summed. Empty means silence.
	Freqs []float64
	// DurationMs is how long the segment lasts. Rounded up to a whole 20 ms frame — see Generate.
	DurationMs int
}

// Tone is a named call-progress signal: a cadence, and whether it repeats.
type Tone struct {
	// Name is the reference this tone answers to, for logs and for `tone:<name>`.
	Name string
	// Segments are played in order.
	Segments []ToneSegment
	// Loop says the cadence repeats until something stops it: true for a persistent signal
	// (ringback, busy, congestion), false for a one-shot marker such as a beep.
	Loop bool
}

// toneAmplitude is the peak amplitude of ONE frequency component, as a fraction of full scale. At
// 0.25 a two-frequency tone peaks at half scale and cannot clip at any phase relationship, and
// -12 dBFS per component renders the -13 to -19 dBm0 the tone plans specify.
const toneAmplitude = 0.25

// MaxToneDurationMs bounds one generated cadence: a `tone:` ref names its own length and this
// process allocates it.
const MaxToneDurationMs = 60_000

var (
	// ErrUnknownTone means a `tone:` reference naming no tone this build defines.
	ErrUnknownTone = errors.New("audio: unknown tone")
	// ErrBadToneSpec means a `tone:` reference whose inline spec could not be read.
	ErrBadToneSpec = errors.New("audio: malformed tone specification")
)

// The tones this build defines, by the name a `tone:` reference uses. A map so the set is
// enumerable and a refusal can name what is available.
var standardTones = map[string]Tone{
	// Dial tone: continuous 350+440 Hz.
	"dial": {
		Name:     "dial",
		Segments: []ToneSegment{{Freqs: []float64{350, 440}, DurationMs: 1000}},
		Loop:     true,
	},
	// Audible ringback, North America: 440+480 Hz, two seconds on and four off.
	"ringback": {
		Name: "ringback",
		Segments: []ToneSegment{
			{Freqs: []float64{440, 480}, DurationMs: 2000},
			{DurationMs: 4000},
		},
		Loop: true,
	},
	// Audible ringback, ITU/UK: 400+450 Hz in the double-ring pattern.
	"ringback-uk": {
		Name: "ringback-uk",
		Segments: []ToneSegment{
			{Freqs: []float64{400, 450}, DurationMs: 400},
			{DurationMs: 200},
			{Freqs: []float64{400, 450}, DurationMs: 400},
			{DurationMs: 2000},
		},
		Loop: true,
	},
	// Busy: 480+620 Hz at 60 interruptions per minute.
	"busy": {
		Name: "busy",
		Segments: []ToneSegment{
			{Freqs: []float64{480, 620}, DurationMs: 500},
			{DurationMs: 500},
		},
		Loop: true,
	},
	// Congestion, the "fast busy"/reorder: the same pair at twice the rate. Distinct from busy —
	// busy means the person is on the phone, congestion means the network could not carry the call.
	"congestion": {
		Name: "congestion",
		Segments: []ToneSegment{
			{Freqs: []float64{480, 620}, DurationMs: 250},
			{DurationMs: 250},
		},
		Loop: true,
	},
	// Confirmation: three short bursts of dial tone's pair. What a feature code answers with.
	"confirmation": {
		Name: "confirmation",
		Segments: []ToneSegment{
			{Freqs: []float64{350, 440}, DurationMs: 100},
			{DurationMs: 100},
			{Freqs: []float64{350, 440}, DurationMs: 100},
			{DurationMs: 100},
			{Freqs: []float64{350, 440}, DurationMs: 100},
		},
		Loop: false,
	},
	// The record beep: one 1000 Hz burst, once. Not a call-progress signal — no handset detects it
	// and no standard defines it — just a marker for a person.
	"beep": {
		Name:     "beep",
		Segments: []ToneSegment{{Freqs: []float64{1000}, DurationMs: 250}},
		Loop:     false,
	},
	// Silence, generated: the MOH fallback for an instance with no music configured.
	"silence": {
		Name:     "silence",
		Segments: []ToneSegment{{DurationMs: 1000}},
		Loop:     true,
	},
}

// StandardToneNames lists every tone this build defines, for a refusal message.
func StandardToneNames() []string {
	// Sorted so a refusal message is stable.
	return slices.Sorted(maps.Keys(standardTones))
}

// LookupTone returns a named standard tone.
func LookupTone(name string) (Tone, bool) {
	tone, ok := standardTones[strings.ToLower(strings.TrimSpace(name))]
	return tone, ok
}

// ParseTone reads a `tone:` reference into a Tone. Two forms:
//
//	tone:ringback              a name from StandardToneNames
//	tone:480+620/500,/500      an inline cadence — frequencies, a slash, milliseconds, comma-separated
//
// An empty-frequency element (`/500`) is silence. The inline form always loops.
func ParseTone(ref string) (Tone, error) {
	// `tone://ring` and `tone:ring` are the same reference; both spellings are in the wild.
	spec := strings.TrimPrefix(strings.TrimSpace(ref), "//")
	if spec == "" {
		return Tone{}, fmt.Errorf("%w: tone: with no name", ErrBadToneSpec)
	}
	if tone, ok := LookupTone(spec); ok {
		return tone, nil
	}
	if !strings.ContainsAny(spec, "/") {
		return Tone{}, fmt.Errorf("%w: %q is not one of %s, and is not a <freqs>/<ms> cadence",
			ErrUnknownTone, spec, strings.Join(StandardToneNames(), ", "))
	}

	tone := Tone{Name: spec, Loop: true}
	total := 0
	for element := range strings.SplitSeq(spec, ",") {
		segment, err := parseToneSegment(strings.TrimSpace(element))
		if err != nil {
			return Tone{}, err
		}
		total += segment.DurationMs
		if total > MaxToneDurationMs {
			return Tone{}, fmt.Errorf("%w: %q is longer than the %d ms a tone may run for",
				ErrBadToneSpec, spec, MaxToneDurationMs)
		}
		tone.Segments = append(tone.Segments, segment)
	}
	if len(tone.Segments) == 0 {
		return Tone{}, fmt.Errorf("%w: %q has no segments", ErrBadToneSpec, spec)
	}
	return tone, nil
}

func parseToneSegment(element string) (ToneSegment, error) {
	freqPart, durationPart, found := strings.Cut(element, "/")
	if !found {
		return ToneSegment{}, fmt.Errorf("%w: %q has no /<milliseconds>", ErrBadToneSpec, element)
	}
	durationMs, err := strconv.Atoi(strings.TrimSpace(durationPart))
	if err != nil || durationMs <= 0 {
		return ToneSegment{}, fmt.Errorf("%w: %q has no positive duration", ErrBadToneSpec, element)
	}

	segment := ToneSegment{DurationMs: durationMs}
	freqPart = strings.TrimSpace(freqPart)
	if freqPart == "" {
		// Silence.
		return segment, nil
	}
	for raw := range strings.SplitSeq(freqPart, "+") {
		hertz, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		// Above the Nyquist frequency a sinusoid is an alias of a different tone, so it is refused
		// rather than generated.
		if err != nil || hertz <= 0 || hertz >= SampleRate/2 {
			return ToneSegment{}, fmt.Errorf(
				"%w: %q is not a frequency between 0 and %d Hz", ErrBadToneSpec, raw, SampleRate/2)
		}
		segment.Freqs = append(segment.Freqs, hertz)
	}
	return segment, nil
}

// Generate renders a tone into 20 ms frames in one companding law. Each segment is rounded UP to a
// whole frame so a tone edge never falls inside a packet and a looped cadence's period is exactly
// reproducible.
func (t Tone) Generate(encoding Encoding) (*Clip, error) {
	if len(t.Segments) == 0 {
		return nil, fmt.Errorf("%w: %q has no segments", ErrBadToneSpec, t.Name)
	}

	clip := &Clip{Encoding: encoding}
	for _, segment := range t.Segments {
		frames := (segment.DurationMs + FrameDurationMs - 1) / FrameDurationMs
		if frames <= 0 {
			continue
		}
		samples := make([]int16, frames*FrameSamples)
		// Phase starts at zero for every segment; see the package note on when that is click-free.
		for index := range samples {
			samples[index] = toneSample(segment.Freqs, index)
		}
		clip.Frames = append(clip.Frames, framesOf(encodeLinear(samples, encoding), encoding)...)
	}
	if len(clip.Frames) == 0 {
		return nil, fmt.Errorf("%w: %q generates no audio", ErrBadToneSpec, t.Name)
	}
	return clip, nil
}

// toneSample sums the segment's sinusoids at one sample index. Silence is the empty sum.
func toneSample(freqs []float64, index int) int16 {
	if len(freqs) == 0 {
		return 0
	}
	var sum float64
	for _, hertz := range freqs {
		sum += toneAmplitude * math.Sin(2*math.Pi*hertz*float64(index)/float64(SampleRate))
	}
	scaled := sum * math.MaxInt16
	switch {
	case scaled > math.MaxInt16:
		scaled = math.MaxInt16
	case scaled < math.MinInt16:
		scaled = math.MinInt16
	}
	return int16(math.Round(scaled))
}
