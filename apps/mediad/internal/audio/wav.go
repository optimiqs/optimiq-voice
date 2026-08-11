package audio

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// The one sample rate v1 plays, and the frame geometry that follows from it.
//
// 8 kHz because G.711 is 8 kHz: rung 7 is where wideband arrives, and a resampler in front of a
// passthrough codec would be the first DSP on the call path for no benefit anybody can hear.
const (
	// SampleRate is the only rate a clip may be stored at. A file at 44.1 kHz is REFUSED rather
	// than resampled — see ErrUnsupportedRate.
	SampleRate = 8000
	// FrameSamples is 20 ms at 8 kHz, and therefore also the byte length of one G.711 frame.
	//
	// 20 ms is the ptime every SIP endpoint on earth defaults to. A media server that sent 30 ms
	// frames would work and would add 10 ms of one-way latency to every prompt for nothing.
	FrameSamples = 160
	// FrameDurationMs is how much audio one frame carries.
	FrameDurationMs = 20
	// FrameTimestampStep is how far an RTP timestamp advances per frame: one tick per sample at
	// 8 kHz (RFC 3551), so it equals FrameSamples.
	FrameTimestampStep = FrameSamples
)

// MaxClipBytes bounds one decoded clip at roughly 17 minutes of G.711.
//
// A limit rather than no limit because a playback request names a path and the process reads
// whatever is at it: a 2 GB file left in the prompt directory by a backup job must fail as a
// refusal on one call, not as an out-of-memory on every call the instance is carrying.
const MaxClipBytes = 8 << 20

// WAVE format tags this parser recognises, from the RIFF specification.
const (
	waveFormatPCM        = 0x0001
	waveFormatALaw       = 0x0006
	waveFormatULaw       = 0x0007
	waveFormatExtensible = 0xFFFE
)

// Why each refusal is its own sentinel: the control surface maps them onto the wire's
// machine-readable `reason`, and they do not all mean the same thing to the engine. A malformed
// file is `bad_request` for the operator who installed it; a rate this build cannot serve is
// `not_supported`, which is the honest per-capability answer and routes the leg to Asterisk.
var (
	// ErrNotRIFF means the bytes are not a RIFF/WAVE container at all.
	ErrNotRIFF = errors.New("audio: not a RIFF/WAVE file")
	// ErrTruncated means a chunk claims more bytes than the file holds, or the audio data does not
	// contain a whole number of samples. Almost always an interrupted upload.
	ErrTruncated = errors.New("audio: the file is truncated")
	// ErrUnsupportedFormat means a valid WAV this build cannot decode — IMA ADPCM, GSM, MP3 in a
	// RIFF wrapper, or PCM at a bit depth other than 16.
	ErrUnsupportedFormat = errors.New("audio: unsupported WAV sample format")
	// ErrUnsupportedRate means a valid WAV at a rate other than 8 kHz. v1 does not resample.
	ErrUnsupportedRate = errors.New("audio: unsupported sample rate")
	// ErrUnsupportedChannels means a valid WAV that is not mono. v1 does not downmix.
	ErrUnsupportedChannels = errors.New("audio: unsupported channel count")
	// ErrTooLarge means the file is over MaxClipBytes.
	ErrTooLarge = errors.New("audio: the file is too large to play")
	// ErrEmpty means a well-formed WAV whose data chunk holds no audio. Refused rather than played,
	// because a playback that reports success and sends nothing is the silent failure this whole
	// service is built to avoid.
	ErrEmpty = errors.New("audio: the file contains no audio")
)

// Clip is decoded audio, already in one companding law and already cut into frames.
//
// The conversion happens ONCE, here, at playback start. The packet path receives a slice of
// ready-to-send payloads and does nothing per frame but copy a header onto one — which is what
// keeps a 50-times-a-second goroutine free of anything that could take a lock or allocate.
type Clip struct {
	// Encoding is the law the frames are in. It always matches what the leg negotiated.
	Encoding Encoding
	// Frames are FrameSamples bytes each. The last one is padded with silence when the source did
	// not end on a frame boundary.
	Frames [][]byte
}

// DurationMs is how much audio the clip carries, including the final frame's padding.
func (c *Clip) DurationMs() int { return len(c.Frames) * FrameDurationMs }

// DecodeWAV parses a RIFF/WAVE file and returns its audio in the requested companding law.
//
// # Why the parser walks chunks instead of assuming the canonical 44-byte header
//
// Because real files are not canonical. Anything that has been through a tagging tool carries a
// `LIST`/`INFO` chunk, µ-law files written by sox carry a `fact` chunk the standard requires for
// non-PCM formats, and a WAV written by a Windows tool may be WAVE_FORMAT_EXTENSIBLE with the real
// format tag buried in a GUID. A parser that seeks to byte 44 works on the files a developer makes
// and fails on the ones a customer uploads.
func DecodeWAV(raw []byte, encoding Encoding) (*Clip, error) {
	if len(raw) > MaxClipBytes {
		return nil, fmt.Errorf("%w: %d bytes, limit %d", ErrTooLarge, len(raw), MaxClipBytes)
	}
	// 12 bytes of RIFF header, 8+16 of the smallest fmt chunk, 8 of a data header.
	if len(raw) < 44 {
		return nil, fmt.Errorf("%w: %d bytes is shorter than any WAV header", ErrNotRIFF, len(raw))
	}
	if string(raw[0:4]) != "RIFF" || string(raw[8:12]) != "WAVE" {
		return nil, ErrNotRIFF
	}

	var (
		format     wavFormat
		haveFormat bool
		data       []byte
		haveData   bool
	)

	for offset := 12; offset+8 <= len(raw); {
		id := string(raw[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(raw[offset+4 : offset+8]))
		body := offset + 8
		if size < 0 || body+size > len(raw) {
			// A chunk claiming more than the file holds. For `data` this is the interrupted-upload
			// case and is worth naming; for anything else the file is equally unusable.
			return nil, fmt.Errorf("%w: chunk %q claims %d bytes past offset %d", ErrTruncated, id, size, body)
		}

		switch id {
		case "fmt ":
			parsed, err := parseFormatChunk(raw[body : body+size])
			if err != nil {
				return nil, err
			}
			format, haveFormat = parsed, true
		case "data":
			data, haveData = raw[body:body+size], true
		}

		// RIFF pads every chunk to an even length, and the pad byte is NOT counted in the size.
		offset = body + size + (size & 1)
	}

	if !haveFormat {
		return nil, fmt.Errorf("%w: no fmt chunk", ErrNotRIFF)
	}
	if !haveData {
		return nil, fmt.Errorf("%w: no data chunk", ErrNotRIFF)
	}
	if err := format.validate(); err != nil {
		return nil, err
	}

	payload, err := format.toEncoding(data, encoding)
	if err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, ErrEmpty
	}
	return &Clip{Encoding: encoding, Frames: framesOf(payload, encoding)}, nil
}

// wavFormat is the subset of a `fmt ` chunk this service acts on.
type wavFormat struct {
	tag           uint16
	channels      uint16
	sampleRate    uint32
	bitsPerSample uint16
}

func parseFormatChunk(body []byte) (wavFormat, error) {
	if len(body) < 16 {
		return wavFormat{}, fmt.Errorf("%w: fmt chunk is %d bytes, needs 16", ErrTruncated, len(body))
	}
	format := wavFormat{
		tag:           binary.LittleEndian.Uint16(body[0:2]),
		channels:      binary.LittleEndian.Uint16(body[2:4]),
		sampleRate:    binary.LittleEndian.Uint32(body[4:8]),
		bitsPerSample: binary.LittleEndian.Uint16(body[14:16]),
	}

	if format.tag == waveFormatExtensible {
		// WAVE_FORMAT_EXTENSIBLE hides the real tag in the first two bytes of a 16-byte subformat
		// GUID, which starts 8 bytes into the extension. Anything written by a modern Windows tool
		// looks like this, so ignoring it would refuse ordinary 16-bit PCM.
		if len(body) < 40 {
			return wavFormat{}, fmt.Errorf("%w: extensible fmt chunk is %d bytes, needs 40", ErrTruncated, len(body))
		}
		format.tag = binary.LittleEndian.Uint16(body[24:26])
	}
	return format, nil
}

func (f wavFormat) validate() error {
	if f.channels != 1 {
		// Refused rather than downmixed. A stereo prompt is a mistake in the library — every
		// telephony format is mono — and mixing channels would be inventing audio nobody authored.
		return fmt.Errorf("%w: %d channels, mediad plays mono only", ErrUnsupportedChannels, f.channels)
	}
	if f.sampleRate != SampleRate {
		return fmt.Errorf("%w: %d Hz, mediad plays %d Hz only (v1 does not resample)",
			ErrUnsupportedRate, f.sampleRate, SampleRate)
	}
	switch f.tag {
	case waveFormatPCM:
		if f.bitsPerSample != 16 {
			return fmt.Errorf("%w: %d-bit linear PCM, mediad reads 16-bit", ErrUnsupportedFormat, f.bitsPerSample)
		}
	case waveFormatALaw, waveFormatULaw:
		if f.bitsPerSample != 8 {
			return fmt.Errorf("%w: %d-bit G.711, which is 8-bit by definition",
				ErrUnsupportedFormat, f.bitsPerSample)
		}
	default:
		return fmt.Errorf("%w: WAVE format tag 0x%04X", ErrUnsupportedFormat, f.tag)
	}
	return nil
}

// toEncoding turns a validated data chunk into G.711 bytes in the target law.
//
// The passthrough case — a stored law that already matches the leg's — copies nothing and converts
// nothing, which is design doc §7's passthrough rule holding for files as well as for packets.
func (f wavFormat) toEncoding(data []byte, target Encoding) ([]byte, error) {
	switch f.tag {
	case waveFormatULaw:
		return recode(data, EncodingULaw, target), nil
	case waveFormatALaw:
		return recode(data, EncodingALaw, target), nil
	}

	if len(data)%2 != 0 {
		// A 16-bit stream with an odd byte count is a file that stopped mid-sample.
		return nil, fmt.Errorf("%w: %d bytes of 16-bit PCM is not a whole number of samples",
			ErrTruncated, len(data))
	}
	samples := make([]int16, len(data)/2)
	for index := range samples {
		samples[index] = int16(binary.LittleEndian.Uint16(data[index*2 : index*2+2]))
	}
	return encodeLinear(samples, target), nil
}

// framesOf cuts a G.711 stream into 20 ms frames, padding the last one with silence.
//
// Padding rather than truncating: dropping the tail would clip the final consonant off every prompt
// whose length is not a multiple of 20 ms, and a sender that emits a short frame makes some
// receivers' jitter buffers report loss for the samples that were never sent.
func framesOf(payload []byte, encoding Encoding) [][]byte {
	count := (len(payload) + FrameSamples - 1) / FrameSamples
	frames := make([][]byte, 0, count)
	for offset := 0; offset < len(payload); offset += FrameSamples {
		end := offset + FrameSamples
		if end <= len(payload) {
			frames = append(frames, payload[offset:end:end])
			continue
		}
		frame := make([]byte, FrameSamples)
		copied := copy(frame, payload[offset:])
		for index := copied; index < FrameSamples; index++ {
			frame[index] = encoding.Silence()
		}
		frames = append(frames, frame)
	}
	return frames
}
