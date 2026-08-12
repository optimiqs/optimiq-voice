package audio

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Call-progress tone synthesis: the piece two shipped features have been waiting on.
//
// plans/mediad-design.md §10 question 11 names it exactly — "there is no tone generator, and two
// features name it": `tone://` at `start-playback` and `beep` at `start-recording`. Both were
// refused `not_supported` with the capability named, which routed voicemail and inband ringback to
// Asterisk. This file is that capability, and it is deliberately the SMALLEST thing that closes
// both: a sum of sinusoids, cut into the same 20 ms frames a WAV clip produces, handed to the same
// playback path. Nothing below Clip knows a tone from a prompt.
//
// # Why generated rather than shipped as WAV files
//
// A tone is eight numbers — two frequencies and a cadence — and a file is a deployment dependency.
// MEDIAD_SOUNDS_DIR has no default precisely because a prompt store is something an operator mounts;
// making ringback need one would mean an instance that can bridge a call cannot tell the caller the
// far end is ringing. Synthesis has no mount, no invalidation question and no per-deployment drift,
// and it is the same reason Asterisk generates its tone zones rather than shipping them as audio.
//
// # Where the numbers come from
//
// The North American Precise Tone Plan (Bellcore TR-TSY-000181) for the default zone, and ITU-T
// E.180/Q.35 for the alternates. They are not arbitrary and they are not interchangeable: a caller
// hears "busy" because 480+620 Hz interrupted twice a second is what a century of telephony taught
// them busy sounds like, and a phone's own tone detector — the thing that lights "line busy" on a
// desk set — is a filter bank keyed on those exact pairs. Inventing frequencies would produce a
// sound a person recognises as "something" and a handset recognises as nothing.
//
// # The cadences are whole numbers of cycles, and that is why there are no clicks
//
// Every segment below starts its oscillators at phase zero. That is only click-free because the
// standard cadences are integer multiples of the standard periods: 440 Hz across 2000 ms is exactly
// 880 cycles, 480 Hz is 960, and 480/620 Hz across 500 ms are 240 and 310. A tone that ended
// mid-cycle would step to silence from a non-zero sample, which is a broadband click on every
// repetition — audible, and exactly what a caller reports as "the ringing crackles". The property is
// asserted by the suite rather than assumed, because a custom `tone:` ref can break it and should
// then be the caller's problem rather than a silent defect.

// ToneSegment is one interval of a cadence: either a sum of frequencies, or silence.
type ToneSegment struct {
	// Freqs are the sinusoid frequencies in hertz, summed. Empty means SILENCE, which is what makes
	// a cadence a cadence rather than a continuous tone.
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
	// Loop says the cadence repeats until something stops it.
	//
	// True for every SIGNAL — ringback, busy, congestion — because those describe a state that
	// persists, and a ringback that played once and stopped would tell a caller the far end had
	// stopped ringing. False for a one-shot MARKER: a beep says "now", and repeating it would talk
	// over the message it exists to introduce.
	Loop bool
}

// toneAmplitude is the peak amplitude of ONE frequency component, as a fraction of full scale.
//
// 0.25 per component, so a two-frequency tone peaks at half of full scale and can never clip
// whatever the phase relationship between the two happens to be at a given sample. That headroom is
// the point: two sinusoids at 0.5 each would sum past int16 on every beat, and a clipped call-
// progress tone is a buzz rather than a tone — which is precisely what a handset's detector fails to
// recognise.
//
// It also lands the level in the right band. -12 dBFS per component is a conventional rendering of
// the -13 to -19 dBm0 the tone plans specify, loud enough to be heard over a noisy line and quiet
// enough that a caller does not flinch when the menu that follows it plays at speech level.
const toneAmplitude = 0.25

// MaxToneDurationMs bounds one generated cadence, for the same reason MaxClipBytes bounds a file: a
// `tone:` ref names its own length and this process allocates it. Sixty seconds is longer than any
// cadence a tone plan defines and far shorter than a memory problem.
const MaxToneDurationMs = 60_000

var (
	// ErrUnknownTone means a `tone:` reference naming no tone this build defines.
	ErrUnknownTone = errors.New("audio: unknown tone")
	// ErrBadToneSpec means a `tone:` reference whose inline spec could not be read.
	ErrBadToneSpec = errors.New("audio: malformed tone specification")
)

// The tones this build defines, by the name a `tone:` reference uses.
//
// One map rather than a switch so the set is enumerable — a refusal names what IS available, which
// is the difference between "unknown tone" and a support ticket.
var standardTones = map[string]Tone{
	// Dial tone: continuous 350+440 Hz. Continuous rather than cadenced, which is the whole signal —
	// "the line is yours and nothing is happening yet".
	"dial": {
		Name:     "dial",
		Segments: []ToneSegment{{Freqs: []float64{350, 440}, DurationMs: 1000}},
		Loop:     true,
	},
	// Audible ringback, North America: 440+480 Hz, two seconds on and four off.
	//
	// This is the one that matters most for a PBX, because it is what a caller hears for the whole
	// of the far end's alerting. Getting the cadence wrong is not cosmetic: a caller uses the gap
	// length to decide whether the call is progressing or has stalled.
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
	// Congestion, the "fast busy"/reorder: the same pair at twice the rate.
	//
	// A SEPARATE tone from busy and not a nicety: busy means "that person is on the phone" and
	// congestion means "the network could not carry your call". A PBX that played busy for a trunk
	// failure would send every caller to voicemail instead of to an operator.
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
	// The record beep: one 1000 Hz burst, once.
	//
	// 1000 Hz rather than a tone-plan pair because it is not a call-progress signal at all — no
	// handset detects it and no standard defines it. It is a MARKER for a person: "the greeting is
	// over, speak now". A single mid-band frequency is the clearest possible version of that, it is
	// what every voicemail system on earth uses, and 250 ms is long enough to be unmistakable and
	// short enough that a caller who starts talking over its tail loses nothing.
	"beep": {
		Name:     "beep",
		Segments: []ToneSegment{{Freqs: []float64{1000}, DurationMs: 250}},
		Loop:     false,
	},
	// Silence, generated. The MOH fallback for an instance with no music configured, and the honest
	// one: a held caller hearing nothing is bad, and a held caller hearing a repeating 400 ms of
	// whatever happened to be in the buffer is worse.
	"silence": {
		Name:     "silence",
		Segments: []ToneSegment{{DurationMs: 1000}},
		Loop:     true,
	},
}

// StandardToneNames lists every tone this build defines, for a refusal message.
func StandardToneNames() []string {
	names := make([]string, 0, len(standardTones))
	for name := range standardTones {
		names = append(names, name)
	}
	// Sorted so a refusal message is stable, which matters because it is asserted by tests and read
	// by operators comparing two instances.
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}
	return names
}

// LookupTone returns a named standard tone.
func LookupTone(name string) (Tone, bool) {
	tone, ok := standardTones[strings.ToLower(strings.TrimSpace(name))]
	return tone, ok
}

// ParseTone reads a `tone:` reference into a Tone.
//
// Two forms, and the second exists because a deployment's tone plan is not this file's to guess:
//
//	tone:ringback              a name from StandardToneNames
//	tone:480+620/500,/500      an inline cadence — frequencies, a slash, milliseconds, comma-separated
//
// The inline form's empty-frequency element (`/500`) is silence, which is how a cadence is written
// at all. It loops, because every reason to write a cadence by hand is a signal rather than a
// marker; a caller who wants a one-shot writes one segment and stops it when it ends.
func ParseTone(ref string) (Tone, error) {
	// `tone://ring` and `tone:ring` are the same reference. Both spellings are in the wild — the
	// design doc writes `tone://` and Asterisk writes `tone:` — and the slashes carry no information
	// either way, so accepting both costs nothing and refusing one would be refusing a caller over
	// punctuation.
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
	for _, element := range strings.Split(spec, ",") {
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
		// Silence. The element that turns a tone into a cadence.
		return segment, nil
	}
	for _, raw := range strings.Split(freqPart, "+") {
		hertz, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		// Above the Nyquist frequency a sinusoid is not the tone that was asked for, it is an alias
		// of a different one — refused rather than generated, because a request for 5 kHz that came
		// back as 3 kHz is a defect nobody would look for in a tone table.
		if err != nil || hertz <= 0 || hertz >= SampleRate/2 {
			return ToneSegment{}, fmt.Errorf(
				"%w: %q is not a frequency between 0 and %d Hz", ErrBadToneSpec, raw, SampleRate/2)
		}
		segment.Freqs = append(segment.Freqs, hertz)
	}
	return segment, nil
}

// Generate renders a tone into 20 ms frames in one companding law.
//
// Each segment is rounded UP to a whole frame, deliberately. The frame is the unit the packet path
// schedules on, so a 510 ms segment would otherwise leave half a frame of one segment sharing a
// packet with half of the next — which puts a tone edge inside a packet and makes the cadence
// dependent on where the frame boundaries happen to fall. Rounding up costs at most 19 ms on a
// segment measured in hundreds, and it makes a looped cadence's period exactly reproducible.
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
		// Phase starts at zero for every segment. See the package note on why that is click-free for
		// the standard cadences, and why a hand-written one is the caller's responsibility.
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
