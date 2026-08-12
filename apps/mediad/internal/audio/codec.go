package audio

import (
	"errors"
	"fmt"
)

// The codec layer: one vocabulary for "what is in this payload", and the two operations anything
// that MIXES needs from it.
//
// # Why this exists only now
//
// Rungs 0-4 never needed it. A relay forwards bytes and a recorder decodes G.711 with a table
// lookup, so `Encoding` — the companding law, µ-law or A-law — was the whole vocabulary. Rung 6
// changes that: a mixer must decode every participant to a common linear representation, sum, and
// re-encode per participant. Once that path exists, rung 7's transcoding is the same path with the
// input and output formats differing, which is exactly why the ladder puts codecs AFTER mixing.
//
// # The linear bus is 8 kHz, and every format converts to it
//
// A FrameDecoder always answers FrameSamples samples of 8 kHz linear PCM, whatever the codec's own
// sample rate is, and a FrameEncoder always takes them. That is the seam: everything above it — the
// mixer, the recorder, the gain hooks — works in one representation and never branches on a codec.
// See resample.go for why 8 kHz is the bus rate and what a wideband leg pays for it.

// Format is a payload format mediad can put on the wire.
type Format uint8

const (
	// FormatULaw is G.711 µ-law, RFC 3551 static payload type 0.
	FormatULaw Format = iota
	// FormatALaw is G.711 A-law, RFC 3551 static payload type 8.
	FormatALaw
	// FormatG722 is ITU-T G.722 at 64 kbit/s, RFC 3551 static payload type 9.
	FormatG722
	// FormatOpus is RFC 6716 Opus, always a DYNAMIC payload type.
	//
	// Negotiable and relayable; NOT transcodable. See the note on NewFrameDecoder.
	FormatOpus
)

// String names a format the way SDP does, which is also how a refusal message should read.
func (f Format) String() string {
	switch f {
	case FormatALaw:
		return "PCMA"
	case FormatG722:
		return "G722"
	case FormatOpus:
		return "opus"
	default:
		return "PCMU"
	}
}

// SampleRate is the rate the codec itself works at, in hertz.
//
// NOT the RTP clock rate, and the two differ for G.722: RFC 3551 §4.5.2 records the 8000 clock rate
// as an error in the original specification that shipped anyway. Anything that needs the clock rate
// must ask SDP for it; this number is for DSP.
func (f Format) SampleRate() int {
	switch f {
	case FormatG722:
		return 16000
	case FormatOpus:
		// Opus is internally 48 kHz. Stated for completeness — nothing decodes it here.
		return 48000
	default:
		return SampleRate
	}
}

// Transcodable reports whether this build can convert the format to and from linear samples.
//
// The one `false` is Opus, and the reason is written down rather than discovered: the only complete
// Opus implementation reachable from Go is a cgo binding to libopus, and taking a C toolchain into
// this service's build to serve a codec no endpoint here negotiates yet is a cost with no caller.
// Opus is therefore NEGOTIATED and PASSED THROUGH — two Opus legs bridge with no codec at all,
// which is the fast path anyway — and a request that would require decoding it is refused by name.
func (f Format) Transcodable() bool { return f != FormatOpus }

// Encoding maps the two G.711 formats onto the companding law the rest of this package speaks.
func (f Format) Encoding() (Encoding, bool) {
	switch f {
	case FormatULaw:
		return EncodingULaw, true
	case FormatALaw:
		return EncodingALaw, true
	default:
		return 0, false
	}
}

// FormatOf is the inverse: the format a companding law is.
func FormatOf(encoding Encoding) Format {
	if encoding == EncodingALaw {
		return FormatALaw
	}
	return FormatULaw
}

// ErrNotTranscodable is returned when a codec has to be decoded and this build cannot.
var ErrNotTranscodable = errors.New("audio: this build cannot decode or encode that codec")

// FrameDecoder turns one payload into 20 ms of 8 kHz linear PCM.
//
// STATEFUL by contract, because two of the three implementations are: G.722's predictor and the
// resampler's filter history both make a frame's output depend on every frame before it. One
// decoder per inbound stream, for the life of the stream.
type FrameDecoder interface {
	// DecodeFrame answers exactly FrameSamples samples. A payload that is short, long or corrupt
	// still answers a full frame — padded with silence — because the caller is a mixer on a clock
	// and a short frame there is a gap in everybody's audio rather than in one participant's.
	DecodeFrame(payload []byte) []int16
	// Reset returns the decoder to its start state, for a stream that has restarted.
	Reset()
}

// FrameEncoder turns 20 ms of 8 kHz linear PCM into one payload. Stateful; see FrameDecoder.
type FrameEncoder interface {
	EncodeFrame(samples []int16) []byte
	Reset()
}

// NewFrameDecoder builds a decoder for a format, or refuses one it cannot decode.
func NewFrameDecoder(format Format) (FrameDecoder, error) {
	switch format {
	case FormatULaw, FormatALaw:
		encoding, _ := format.Encoding()
		return &g711FrameCodec{encoding: encoding}, nil
	case FormatG722:
		return &g722FrameDecoder{decoder: NewG722Decoder()}, nil
	default:
		return nil, fmt.Errorf("%w: %s", ErrNotTranscodable, format)
	}
}

// NewFrameEncoder builds an encoder for a format, or refuses one it cannot produce.
func NewFrameEncoder(format Format) (FrameEncoder, error) {
	switch format {
	case FormatULaw, FormatALaw:
		encoding, _ := format.Encoding()
		return &g711FrameCodec{encoding: encoding}, nil
	case FormatG722:
		return &g722FrameEncoder{encoder: NewG722Encoder()}, nil
	default:
		return nil, fmt.Errorf("%w: %s", ErrNotTranscodable, format)
	}
}

// g711FrameCodec is both halves for a companding law, which is stateless — the whole point of G.711.
type g711FrameCodec struct{ encoding Encoding }

func (c *g711FrameCodec) DecodeFrame(payload []byte) []int16 {
	return padFrame(DecodeLinear(payload, c.encoding))
}

func (c *g711FrameCodec) EncodeFrame(samples []int16) []byte {
	return encodeLinear(padFrame(samples), c.encoding)
}

func (c *g711FrameCodec) Reset() {}

// g722FrameDecoder decodes to 16 kHz and resamples down onto the mix bus.
type g722FrameDecoder struct {
	decoder *G722Decoder
	down    Resampler16to8
}

func (d *g722FrameDecoder) DecodeFrame(payload []byte) []int16 {
	return padFrame(d.down.Resample(d.decoder.Decode(payload)))
}

func (d *g722FrameDecoder) Reset() {
	d.decoder.Reset()
	d.down = Resampler16to8{}
}

// g722FrameEncoder resamples up off the mix bus and encodes.
type g722FrameEncoder struct {
	encoder *G722Encoder
	up      Resampler8to16
}

func (e *g722FrameEncoder) EncodeFrame(samples []int16) []byte {
	return e.encoder.Encode(e.up.Resample(padFrame(samples)))
}

func (e *g722FrameEncoder) Reset() {
	e.encoder.Reset()
	e.up = Resampler8to16{}
}

// padFrame makes a slice exactly one frame long: truncating what is too long, and padding what is
// too short with LINEAR silence, which really is zero (unlike a companded byte — see Encoding.Silence).
func padFrame(samples []int16) []int16 {
	switch {
	case len(samples) == FrameSamples:
		return samples
	case len(samples) > FrameSamples:
		return samples[:FrameSamples]
	default:
		padded := make([]int16, FrameSamples)
		copy(padded, samples)
		return padded
	}
}
