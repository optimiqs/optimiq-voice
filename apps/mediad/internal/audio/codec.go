package audio

import (
	"errors"
	"fmt"
)

// The linear bus is 8 kHz: a FrameDecoder always answers FrameSamples samples of 8 kHz linear PCM
// whatever the codec's own sample rate is, and a FrameEncoder always takes them, so the mixer and
// recorder never branch on a codec.

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
	// Negotiable and relayable; NOT transcodable. See Transcodable.
	FormatOpus
)

// String names a format the way SDP does.
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
// NOT the RTP clock rate: they differ for G.722, where RFC 3551 §4.5.2 keeps the erroneous 8000
// clock rate. Anything needing the clock rate must ask SDP for it.
func (f Format) SampleRate() int {
	switch f {
	case FormatG722:
		return 16000
	case FormatOpus:
		return 48000
	default:
		return SampleRate
	}
}

// Transcodable reports whether this build can convert the format to and from linear samples.
//
// Opus is the one false: decoding it would require a cgo binding to libopus, so Opus is negotiated
// and passed through, and any request needing it decoded is refused by name.
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

// FormatOf returns the format a companding law corresponds to.
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
// Stateful by contract (G.722's predictor, the resampler's filter history): use one decoder per
// inbound stream, for the life of that stream.
type FrameDecoder interface {
	// DecodeFrame answers exactly FrameSamples samples; a short, long or corrupt payload is still
	// padded to a full frame, because a short frame at a mixer on a clock is a gap in everyone's
	// audio rather than in one participant's.
	DecodeFrame(payload []byte) []int16
	// Reset returns the decoder to its start state, for a stream that has restarted.
	Reset()
}

// FrameEncoder turns 20 ms of 8 kHz linear PCM into one payload. Stateful; see FrameDecoder.
type FrameEncoder interface {
	// EncodeFrame answers this instance's OWN buffer, valid only until the next EncodeFrame on the
	// same encoder; a caller that keeps the bytes must copy them. One encoder belongs to one
	// direction of one bridge or one seat in one room, so there is no second consumer to race.
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

// g711FrameCodec is both halves for a companding law, which is stateless.
//
// The scratch buffers avoid a per-frame allocation: an instance belongs to one direction of one
// bridge or one seat in one room, and callers consume a frame before calling again.
type g711FrameCodec struct {
	encoding Encoding
	decoded  []int16
	padded   []int16
	encoded  []byte
}

func (c *g711FrameCodec) DecodeFrame(payload []byte) []int16 {
	if c.decoded == nil {
		c.decoded = make([]int16, FrameSamples)
		c.padded = make([]int16, FrameSamples)
	}
	return padFrameInto(c.padded, decodeLinearInto(c.decoded, payload, c.encoding))
}

// EncodeFrame reuses this instance's output buffer; see the FrameEncoder contract for the lifetime
// that makes that safe.
func (c *g711FrameCodec) EncodeFrame(samples []int16) []byte {
	if c.padded == nil {
		c.decoded = make([]int16, FrameSamples)
		c.padded = make([]int16, FrameSamples)
		c.encoded = make([]byte, FrameSamples)
	}
	return encodeLinearInto(c.encoded, padFrameInto(c.padded, samples), c.encoding)
}

func (c *g711FrameCodec) Reset() {}

// g722FrameDecoder decodes to 16 kHz and resamples down onto the mix bus.
type g722FrameDecoder struct {
	decoder *G722Decoder
	down    Resampler16to8

	wide   []int16
	narrow []int16
	padded []int16
}

func (d *g722FrameDecoder) DecodeFrame(payload []byte) []int16 {
	if d.padded == nil {
		d.wide = make([]int16, 0, FrameSamples*2)
		d.narrow = make([]int16, 0, FrameSamples)
		d.padded = make([]int16, FrameSamples)
	}
	d.wide = d.decoder.decodeInto(d.wide, payload)
	d.narrow = d.down.resampleInto(d.narrow, d.wide)
	return padFrameInto(d.padded, d.narrow)
}

func (d *g722FrameDecoder) Reset() {
	d.decoder.Reset()
	d.down = Resampler16to8{}
}

// g722FrameEncoder resamples up off the mix bus and encodes.
type g722FrameEncoder struct {
	encoder *G722Encoder
	up      Resampler8to16

	// Scratch; see the FrameEncoder contract for the lifetime that makes reusing the output safe.
	padded  []int16
	wide    []int16
	encoded []byte
}

func (e *g722FrameEncoder) EncodeFrame(samples []int16) []byte {
	if e.padded == nil {
		e.padded = make([]int16, FrameSamples)
		e.wide = make([]int16, 0, FrameSamples*2)
		e.encoded = make([]byte, 0, FrameSamples)
	}
	e.wide = e.up.resampleInto(e.wide, padFrameInto(e.padded, samples))
	e.encoded = e.encoder.encodeInto(e.encoded, e.wide)
	return e.encoded
}

func (e *g722FrameEncoder) Reset() {
	e.encoder.Reset()
	e.up = Resampler8to16{}
}

// padFrame makes a slice exactly one frame long, truncating what is too long and padding what is
// too short with LINEAR silence, which is zero (unlike a companded byte — see Encoding.Silence).
func padFrame(samples []int16) []int16 {
	return padFrameInto(nil, samples)
}

// padFrameInto is padFrame writing into a caller-supplied FrameSamples-long buffer. An exact or
// over-long input needs no buffer and is returned as a view.
func padFrameInto(dst, samples []int16) []int16 {
	if len(samples) >= FrameSamples || len(dst) != FrameSamples {
		return padFrameAlloc(samples)
	}
	copy(dst, samples)
	for index := len(samples); index < FrameSamples; index++ {
		dst[index] = 0
	}
	return dst
}

func padFrameAlloc(samples []int16) []int16 {
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
