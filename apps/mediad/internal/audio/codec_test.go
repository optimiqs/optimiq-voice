package audio_test

import (
	"errors"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

func TestFormatFacts(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		format       audio.Format
		spelled      string
		sampleRate   int
		transcodable bool
	}{
		{"PCMU", audio.FormatULaw, "PCMU", 8000, true},
		{"PCMA", audio.FormatALaw, "PCMA", 8000, true},
		// G.722 is the one format whose sample rate and RTP clock rate differ; SDP owns the clock
		// rate, so the two cannot be confused here.
		{"G722", audio.FormatG722, "G722", 16000, true},
		// Opus is negotiable and relayable but not decodable in this build. See NewFrameDecoder.
		{"opus", audio.FormatOpus, "opus", 48000, false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			if got := testCase.format.String(); got != testCase.spelled {
				t.Errorf("String() = %q, want %q", got, testCase.spelled)
			}
			if got := testCase.format.SampleRate(); got != testCase.sampleRate {
				t.Errorf("SampleRate() = %d, want %d", got, testCase.sampleRate)
			}
			if got := testCase.format.Transcodable(); got != testCase.transcodable {
				t.Errorf("Transcodable() = %v, want %v", got, testCase.transcodable)
			}
		})
	}
}

func TestFrameCodecsAnswerExactlyOneFrame(t *testing.T) {
	t.Parallel()

	// A short frame from one participant would gap everybody's audio, so the length is a contract.
	cases := []struct {
		name    string
		format  audio.Format
		payload []byte
	}{
		{"a full µ-law frame", audio.FormatULaw, make([]byte, audio.FrameSamples)},
		{"a short µ-law payload", audio.FormatULaw, make([]byte, 40)},
		{"an over-long µ-law payload", audio.FormatULaw, make([]byte, 400)},
		{"an empty payload", audio.FormatULaw, nil},
		{"a full A-law frame", audio.FormatALaw, make([]byte, audio.FrameSamples)},
		{"a full G.722 frame", audio.FormatG722, make([]byte, audio.FrameSamples)},
		{"a short G.722 payload", audio.FormatG722, make([]byte, 40)},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			decoder, err := audio.NewFrameDecoder(testCase.format)
			if err != nil {
				t.Fatalf("NewFrameDecoder(%s): %v", testCase.format, err)
			}
			if got := decoder.DecodeFrame(testCase.payload); len(got) != audio.FrameSamples {
				t.Errorf("DecodeFrame answered %d samples, want %d", len(got), audio.FrameSamples)
			}

			encoder, err := audio.NewFrameEncoder(testCase.format)
			if err != nil {
				t.Fatalf("NewFrameEncoder(%s): %v", testCase.format, err)
			}
			if got := encoder.EncodeFrame(make([]int16, audio.FrameSamples)); len(got) != audio.FrameSamples {
				t.Errorf("EncodeFrame answered %d bytes, want %d", len(got), audio.FrameSamples)
			}
		})
	}
}

func TestFrameCodecRoundTripThroughTheMixBus(t *testing.T) {
	t.Parallel()

	// The mix path: decode to 8 kHz linear, mix, re-encode into the destination leg's format. A
	// tone must survive it at the same level, G.722 included (which crosses the resampler twice).
	cases := []struct {
		name   string
		format audio.Format
	}{
		{"PCMU", audio.FormatULaw},
		{"PCMA", audio.FormatALaw},
		{"G722", audio.FormatG722},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			encoder, err := audio.NewFrameEncoder(testCase.format)
			if err != nil {
				t.Fatalf("NewFrameEncoder: %v", err)
			}
			decoder, err := audio.NewFrameDecoder(testCase.format)
			if err != nil {
				t.Fatalf("NewFrameDecoder: %v", err)
			}

			in := sine(audio.FrameSamples*10, 1000, 8000, audio.SampleRate)
			var out []int16
			for offset := 0; offset < len(in); offset += audio.FrameSamples {
				frame := in[offset : offset+audio.FrameSamples]
				out = append(out, decoder.DecodeFrame(encoder.EncodeFrame(frame))...)
			}

			want := goertzel(in[400:], 1000, audio.SampleRate)
			got := goertzel(out[400:], 1000, audio.SampleRate)
			if ratio := got / want; ratio < 0.85 || ratio > 1.15 {
				t.Errorf("a 1 kHz tone survived the mix bus at %.3f×", ratio)
			}
		})
	}
}

func TestOpusIsRefusedRatherThanApproximated(t *testing.T) {
	t.Parallel()

	// Opus is relayed, never decoded; anything that would have to decode it refuses by name rather
	// than producing noise.
	if _, err := audio.NewFrameDecoder(audio.FormatOpus); !errors.Is(err, audio.ErrNotTranscodable) {
		t.Errorf("NewFrameDecoder(opus) = %v, want ErrNotTranscodable", err)
	}
	if _, err := audio.NewFrameEncoder(audio.FormatOpus); !errors.Is(err, audio.ErrNotTranscodable) {
		t.Errorf("NewFrameEncoder(opus) = %v, want ErrNotTranscodable", err)
	}
}

func TestEncodingMapsBothWays(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		format   audio.Format
		encoding audio.Encoding
		isG711   bool
	}{
		{"PCMU is µ-law", audio.FormatULaw, audio.EncodingULaw, true},
		{"PCMA is A-law", audio.FormatALaw, audio.EncodingALaw, true},
		{"G722 is neither", audio.FormatG722, 0, false},
		{"opus is neither", audio.FormatOpus, 0, false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			encoding, ok := testCase.format.Encoding()
			if ok != testCase.isG711 {
				t.Fatalf("Encoding() ok = %v, want %v", ok, testCase.isG711)
			}
			if !ok {
				return
			}
			if encoding != testCase.encoding {
				t.Errorf("Encoding() = %v, want %v", encoding, testCase.encoding)
			}
			if back := audio.FormatOf(encoding); back != testCase.format {
				t.Errorf("FormatOf(%v) = %v, want %v", encoding, back, testCase.format)
			}
		})
	}
}

func TestDecodeAndEncodeKeepTheSampleCountTheyWereGiven(t *testing.T) {
	t.Parallel()

	// 10, 20, 30 and 60 ms at 8 kHz. DecodeFrame/EncodeFrame are the fixed 20 ms views; Decode and
	// Encode are the ones the relay path uses, and they must not invent or discard media time.
	for _, format := range []audio.Format{audio.FormatULaw, audio.FormatALaw, audio.FormatG722} {
		decoder, err := audio.NewFrameDecoder(format)
		if err != nil {
			t.Fatalf("NewFrameDecoder(%s): %v", format, err)
		}
		encoder, err := audio.NewFrameEncoder(format)
		if err != nil {
			t.Fatalf("NewFrameEncoder(%s): %v", format, err)
		}
		for _, samples := range []int{80, 160, 240, 480} {
			payload := make([]byte, samples)
			for index := range payload {
				payload[index] = 0x7f
			}
			if decoded := decoder.Decode(payload); len(decoded) != samples {
				t.Errorf("%s Decode(%d bytes) = %d samples, want %d",
					format, samples, len(decoded), samples)
			}
			if frame := decoder.DecodeFrame(payload); len(frame) != audio.FrameSamples {
				t.Errorf("%s DecodeFrame(%d bytes) = %d samples, want one frame",
					format, samples, len(frame))
			}
			if encoded := encoder.Encode(make([]int16, samples)); len(encoded) != samples {
				t.Errorf("%s Encode(%d samples) = %d bytes, want %d",
					format, samples, len(encoded), samples)
			}
			if frame := encoder.EncodeFrame(make([]int16, samples)); len(frame) != audio.FrameSamples {
				t.Errorf("%s EncodeFrame(%d samples) = %d bytes, want one frame",
					format, samples, len(frame))
			}
		}
	}
}
