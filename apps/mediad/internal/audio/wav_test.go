package audio_test

import (
	"encoding/binary"
	"errors"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// buildWAV writes a RIFF/WAVE file with the given fmt fields and data body.
//
// Hand-built rather than fixture files on disk, for the same reason the sdp suite builds its offers
// in-process: a truncated file and a 44.1 kHz file are inputs a test must be able to state, and a
// binary fixture makes "what exactly is wrong with this one" invisible in review.
func buildWAV(tag, channels uint16, sampleRate uint32, bits uint16, data []byte, extra ...wavChunk) []byte {
	fmtChunk := make([]byte, 16)
	binary.LittleEndian.PutUint16(fmtChunk[0:2], tag)
	binary.LittleEndian.PutUint16(fmtChunk[2:4], channels)
	binary.LittleEndian.PutUint32(fmtChunk[4:8], sampleRate)
	blockAlign := uint32(channels) * uint32(bits) / 8
	binary.LittleEndian.PutUint32(fmtChunk[8:12], sampleRate*blockAlign)
	binary.LittleEndian.PutUint16(fmtChunk[12:14], uint16(blockAlign))
	binary.LittleEndian.PutUint16(fmtChunk[14:16], bits)

	chunks := []wavChunk{{id: "fmt ", body: fmtChunk}}
	chunks = append(chunks, extra...)
	chunks = append(chunks, wavChunk{id: "data", body: data})

	var body []byte
	for _, chunk := range chunks {
		header := make([]byte, 8)
		copy(header, chunk.id)
		size := chunk.declaredSize
		if size == 0 {
			size = uint32(len(chunk.body))
		}
		binary.LittleEndian.PutUint32(header[4:8], size)
		body = append(body, header...)
		body = append(body, chunk.body...)
		if len(chunk.body)%2 == 1 {
			body = append(body, 0)
		}
	}

	out := make([]byte, 12)
	copy(out, "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(4+len(body)))
	copy(out[8:12], "WAVE")
	return append(out, body...)
}

type wavChunk struct {
	id   string
	body []byte
	// declaredSize overrides the header's size field, so a test can claim more bytes than it wrote.
	declaredSize uint32
}

// pcm16 builds n samples of a value, little-endian.
func pcm16(sample int16, count int) []byte {
	out := make([]byte, count*2)
	for index := 0; index < count; index++ {
		binary.LittleEndian.PutUint16(out[index*2:index*2+2], uint16(sample))
	}
	return out
}

func TestDecodeWAVLinearPCM(t *testing.T) {
	// Exactly two frames of silence, so the framing is asserted without any padding involved.
	raw := buildWAV(1, 1, 8000, 16, pcm16(0, audio.FrameSamples*2))

	clip, err := audio.DecodeWAV(raw, audio.EncodingULaw)
	if err != nil {
		t.Fatalf("DecodeWAV: %v", err)
	}
	if len(clip.Frames) != 2 {
		t.Fatalf("frames = %d, want 2", len(clip.Frames))
	}
	if clip.DurationMs() != 40 {
		t.Errorf("DurationMs = %d, want 40", clip.DurationMs())
	}
	for index, frame := range clip.Frames {
		if len(frame) != audio.FrameSamples {
			t.Fatalf("frame %d is %d bytes, want %d", index, len(frame), audio.FrameSamples)
		}
		// A zero linear sample encodes to 0xFF in µ-law, never to 0x00. Asserting the value rather
		// than the length is what catches an encoder that "works" by emitting zeros.
		for _, encoded := range frame {
			if encoded != 0xFF {
				t.Fatalf("frame %d holds %#02x, want µ-law silence 0xFF", index, encoded)
			}
		}
	}
}

func TestDecodeWAVEncodesToTheLegsLaw(t *testing.T) {
	raw := buildWAV(1, 1, 8000, 16, pcm16(0, audio.FrameSamples))

	clip, err := audio.DecodeWAV(raw, audio.EncodingALaw)
	if err != nil {
		t.Fatalf("DecodeWAV: %v", err)
	}
	if clip.Encoding != audio.EncodingALaw {
		t.Fatalf("Encoding = %v, want PCMA", clip.Encoding)
	}
	if got := clip.Frames[0][0]; got != 0xD5 {
		t.Errorf("A-law silence = %#02x, want 0xD5", got)
	}
}

func TestDecodeWAVPassesG711Through(t *testing.T) {
	// A µ-law WAV played to a µ-law leg must be the SAME BYTES: this is design doc §7's passthrough
	// rule holding for files, and it is what makes a curated library free to serve.
	payload := []byte{0x01, 0x7F, 0xFF, 0x80}
	raw := buildWAV(7, 1, 8000, 8, payload)

	clip, err := audio.DecodeWAV(raw, audio.EncodingULaw)
	if err != nil {
		t.Fatalf("DecodeWAV: %v", err)
	}
	if len(clip.Frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(clip.Frames))
	}
	for index, want := range payload {
		if got := clip.Frames[0][index]; got != want {
			t.Errorf("byte %d = %#02x, want %#02x (passthrough)", index, got, want)
		}
	}
	// The remainder of the short frame is padding, and padding is silence rather than zero.
	if got := clip.Frames[0][len(payload)]; got != 0xFF {
		t.Errorf("pad byte = %#02x, want µ-law silence 0xFF", got)
	}
}

func TestDecodeWAVRecodesBetweenCompandingLaws(t *testing.T) {
	// An A-law file on a µ-law leg. Refusing this would mean a library stored in one law is unusable
	// on half the world's trunks; see the package doc for why it is not the transcoding §7 refuses.
	raw := buildWAV(6, 1, 8000, 8, []byte{audio.LinearToALaw(0)})

	clip, err := audio.DecodeWAV(raw, audio.EncodingULaw)
	if err != nil {
		t.Fatalf("DecodeWAV: %v", err)
	}
	// NOT byte-equal to µ-law silence, and that is correct rather than a bug worth papering over:
	// A-law has no exact zero — its smallest magnitude is 8 — so A-law silence decodes to +8 and
	// re-encodes to the µ-law step next to silence. The assertion is therefore on the AUDIO, which
	// is what a caller hears: the recoded sample is inaudibly close to zero.
	if magnitude := audio.ULawToLinear(clip.Frames[0][0]); magnitude < -16 || magnitude > 16 {
		t.Errorf("recoded A-law silence decodes to %d, want a sample next to zero", magnitude)
	}

	// A full-scale sample must survive the same trip with its sign and rough magnitude intact,
	// which is what catches an inverted mask in either direction of the conversion.
	loud := buildWAV(6, 1, 8000, 8, []byte{audio.LinearToALaw(-20000)})
	loudClip, err := audio.DecodeWAV(loud, audio.EncodingULaw)
	if err != nil {
		t.Fatalf("DecodeWAV(loud): %v", err)
	}
	if got := audio.ULawToLinear(loudClip.Frames[0][0]); got > -18000 || got < -22000 {
		t.Errorf("recoded -20000 decodes to %d, want it near -20000", got)
	}
}

func TestDecodeWAVSkipsUnknownChunks(t *testing.T) {
	// LIST/INFO from a tagging tool and `fact` from sox both sit between `fmt ` and `data`. A parser
	// that assumed the canonical 44-byte header would read the tag as audio.
	raw := buildWAV(7, 1, 8000, 8, []byte{0xFF},
		wavChunk{id: "LIST", body: []byte("INFOISFT\x05\x00\x00\x00sox\x00")},
		wavChunk{id: "fact", body: []byte{1, 0, 0, 0}},
	)

	clip, err := audio.DecodeWAV(raw, audio.EncodingULaw)
	if err != nil {
		t.Fatalf("DecodeWAV: %v", err)
	}
	if len(clip.Frames) != 1 {
		t.Errorf("frames = %d, want 1", len(clip.Frames))
	}
}

func TestDecodeWAVReadsExtensibleFormat(t *testing.T) {
	// WAVE_FORMAT_EXTENSIBLE: the real tag lives in the first two bytes of the subformat GUID.
	extension := make([]byte, 24)
	binary.LittleEndian.PutUint16(extension[0:2], 22) // cbSize
	binary.LittleEndian.PutUint16(extension[8:10], 1) // KSDATAFORMAT_SUBTYPE_PCM

	fmtBody := make([]byte, 16)
	binary.LittleEndian.PutUint16(fmtBody[0:2], 0xFFFE)
	binary.LittleEndian.PutUint16(fmtBody[2:4], 1)
	binary.LittleEndian.PutUint32(fmtBody[4:8], 8000)
	binary.LittleEndian.PutUint16(fmtBody[14:16], 16)

	raw := append([]byte{}, "RIFF"...)
	body := append([]byte("fmt "), make([]byte, 4)...)
	fmtBody = append(fmtBody, extension...)
	binary.LittleEndian.PutUint32(body[4:8], uint32(len(fmtBody)))
	body = append(body, fmtBody...)
	data := pcm16(0, audio.FrameSamples)
	dataHeader := append([]byte("data"), make([]byte, 4)...)
	binary.LittleEndian.PutUint32(dataHeader[4:8], uint32(len(data)))
	body = append(body, dataHeader...)
	body = append(body, data...)

	raw = append(raw, make([]byte, 4)...)
	binary.LittleEndian.PutUint32(raw[4:8], uint32(4+len(body)))
	raw = append(raw, "WAVE"...)
	raw = append(raw, body...)

	if _, err := audio.DecodeWAV(raw, audio.EncodingULaw); err != nil {
		t.Fatalf("DecodeWAV(extensible): %v", err)
	}
}

func TestDecodeWAVRefusals(t *testing.T) {
	tests := []struct {
		name string
		raw  []byte
		want error
	}{
		{
			name: "not a RIFF container",
			raw:  []byte(strings.Repeat("nope", 16)),
			want: audio.ErrNotRIFF,
		},
		{
			name: "shorter than any header",
			raw:  []byte("RIFF"),
			want: audio.ErrNotRIFF,
		},
		{
			// 44.1 kHz is what a prompt exported from a desktop tool looks like, and it is the single
			// most likely thing to be dropped into a prompt directory by mistake.
			name: "wrong sample rate",
			raw:  buildWAV(1, 1, 44100, 16, pcm16(0, 160)),
			want: audio.ErrUnsupportedRate,
		},
		{
			name: "stereo",
			raw:  buildWAV(1, 2, 8000, 16, pcm16(0, 320)),
			want: audio.ErrUnsupportedChannels,
		},
		{
			name: "8-bit linear PCM",
			raw:  buildWAV(1, 1, 8000, 8, make([]byte, 160)),
			want: audio.ErrUnsupportedFormat,
		},
		{
			name: "IMA ADPCM",
			raw:  buildWAV(0x0011, 1, 8000, 4, make([]byte, 160)),
			want: audio.ErrUnsupportedFormat,
		},
		{
			// The interrupted-upload shape: the data header says 4000 bytes and the file stops.
			name: "data chunk claims more than the file holds",
			raw: buildWAV(7, 1, 8000, 8, make([]byte, 16),
				wavChunk{id: "junk", body: make([]byte, 2), declaredSize: 4000}),
			want: audio.ErrTruncated,
		},
		{
			name: "odd byte count of 16-bit PCM",
			raw:  buildWAV(1, 1, 8000, 16, make([]byte, 161)),
			want: audio.ErrTruncated,
		},
		{
			name: "no audio at all",
			raw:  buildWAV(7, 1, 8000, 8, nil),
			want: audio.ErrEmpty,
		},
		{
			name: "over the size cap",
			raw:  make([]byte, audio.MaxClipBytes+1),
			want: audio.ErrTooLarge,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := audio.DecodeWAV(test.raw, audio.EncodingULaw)
			if !errors.Is(err, test.want) {
				t.Fatalf("DecodeWAV error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestDecodeWAVTruncatedFmtChunk(t *testing.T) {
	raw := append([]byte("RIFF"), make([]byte, 8)...)
	copy(raw[8:12], "WAVE")
	header := append([]byte("fmt "), make([]byte, 4)...)
	binary.LittleEndian.PutUint32(header[4:8], 8)
	raw = append(raw, header...)
	raw = append(raw, make([]byte, 8)...)
	raw = append(raw, []byte("data")...)
	raw = append(raw, make([]byte, 4)...)
	raw = append(raw, make([]byte, 20)...)

	if _, err := audio.DecodeWAV(raw, audio.EncodingULaw); !errors.Is(err, audio.ErrTruncated) {
		t.Fatalf("DecodeWAV error = %v, want ErrTruncated", err)
	}
}

func TestG711RoundTripIsMonotonic(t *testing.T) {
	// Not an equality round trip — G.711 is lossy by construction — but the ordering must survive,
	// because an encoder with a sign or segment bug fails this and passes a "decodes to something"
	// assertion.
	previous := audio.ULawToLinear(audio.LinearToULaw(-32000))
	for sample := int32(-31000); sample <= 32000; sample += 1000 {
		got := audio.ULawToLinear(audio.LinearToULaw(int16(sample)))
		if got < previous {
			t.Fatalf("µ-law round trip of %d = %d, below the previous %d", sample, got, previous)
		}
		previous = got
	}

	previous = audio.ALawToLinear(audio.LinearToALaw(-32000))
	for sample := int32(-31000); sample <= 32000; sample += 1000 {
		got := audio.ALawToLinear(audio.LinearToALaw(int16(sample)))
		if got < previous {
			t.Fatalf("A-law round trip of %d = %d, below the previous %d", sample, got, previous)
		}
		previous = got
	}
}

func TestG711RoundTripStaysCloseToTheOriginal(t *testing.T) {
	// G.711's quantisation error is bounded relative to the magnitude. A loose bound is enough to
	// catch a table transcription error, which is the failure this guards.
	for sample := int32(-30000); sample <= 30000; sample += 137 {
		got := int32(audio.ULawToLinear(audio.LinearToULaw(int16(sample))))
		if delta := abs(got - sample); delta > abs(sample)/8+256 {
			t.Fatalf("µ-law round trip of %d = %d, off by %d", sample, got, delta)
		}
		got = int32(audio.ALawToLinear(audio.LinearToALaw(int16(sample))))
		if delta := abs(got - sample); delta > abs(sample)/8+256 {
			t.Fatalf("A-law round trip of %d = %d, off by %d", sample, got, delta)
		}
	}
}

func abs(value int32) int32 {
	if value < 0 {
		return -value
	}
	return value
}
