// Package audio turns a file on disk into G.711 frames the packet path can put on the wire. It knows
// nothing about sockets, sessions or RTP: it reads bytes, validates them, converts them to the
// companding law a leg negotiated, and cuts them into 20 ms frames.
//
// Converting a stored file once, before playback starts, is off the packet path entirely and is not
// the live relay transcoding the design forbids; a file already in the leg's format is passed through.
package audio

// Encoding is a G.711 companding law — the two payload formats v1 puts on the wire.
type Encoding uint8

const (
	// EncodingULaw is G.711 µ-law, RFC 3551 PCMU (payload type 0). North America and Japan.
	EncodingULaw Encoding = iota
	// EncodingALaw is G.711 A-law, RFC 3551 PCMA (payload type 8). Everywhere else.
	EncodingALaw
)

// String names an encoding for a log line or a refusal message.
func (e Encoding) String() string {
	if e == EncodingALaw {
		return "PCMA"
	}
	return "PCMU"
}

// Silence is the encoded byte for a zero sample.
//
// It is NOT zero in either law: padding a short final frame with 0x00 puts a loud click at the end
// of the prompt.
func (e Encoding) Silence() byte {
	if e == EncodingALaw {
		return 0xD5
	}
	return 0xFF
}

// The ITU-T G.711 segment end points, from the reference implementation (Sun's g711.c). They are the
// upper bound of each of the eight logarithmic segments, so a linear search over them IS the segment.
var (
	uLawSegmentEnd = [8]int32{0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF}
	aLawSegmentEnd = [8]int32{0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF}
)

const (
	// uLawBias is added before segmentation so the smallest segment is not degenerate (G.711).
	uLawBias int32 = 0x84
	// uLawClip is the largest magnitude representable in the 14-bit µ-law domain.
	uLawClip int32 = 8159
)

// segment returns which of the eight logarithmic segments a magnitude falls in, or 8 for overflow.
func segment(value int32, ends *[8]int32) int32 {
	for index, end := range ends {
		if value <= end {
			return int32(index)
		}
	}
	return 8
}

// LinearToULaw encodes one 16-bit linear sample as µ-law.
func LinearToULaw(sample int16) byte {
	value := int32(sample) >> 2 // µ-law works in a 14-bit domain.
	var mask int32 = 0xFF
	if value < 0 {
		value = -value
		mask = 0x7F
	}
	if value > uLawClip {
		value = uLawClip
	}
	value += uLawBias >> 2

	seg := segment(value, &uLawSegmentEnd)
	if seg >= 8 {
		return byte(0x7F ^ mask)
	}
	encoded := (seg << 4) | ((value >> (seg + 1)) & 0x0F)
	return byte(encoded ^ mask)
}

// ULawToLinear decodes one µ-law byte to a 16-bit linear sample.
func ULawToLinear(encoded byte) int16 {
	inverted := int32(^encoded)
	value := ((inverted & 0x0F) << 3) + uLawBias
	value <<= (inverted & 0x70) >> 4
	if inverted&0x80 != 0 {
		return int16(uLawBias - value)
	}
	return int16(value - uLawBias)
}

// LinearToALaw encodes one 16-bit linear sample as A-law.
func LinearToALaw(sample int16) byte {
	value := int32(sample) >> 3 // A-law works in a 13-bit domain.
	// A-law's normative alternating-bit inversion: 0xD5 for a positive sample, 0x55 for a negative
	// one, which keeps the encoded bit stream free of long runs of zeros.
	var mask int32 = 0xD5
	if value < 0 {
		mask = 0x55
		value = -value - 1
	}

	seg := segment(value, &aLawSegmentEnd)
	if seg >= 8 {
		return byte(0x7F ^ mask)
	}
	encoded := seg << 4
	if seg < 2 {
		encoded |= (value >> 1) & 0x0F
	} else {
		encoded |= (value >> seg) & 0x0F
	}
	return byte(encoded ^ mask)
}

// ALawToLinear decodes one A-law byte to a 16-bit linear sample.
func ALawToLinear(encoded byte) int16 {
	inverted := int32(encoded ^ 0x55)
	value := (inverted & 0x0F) << 4
	switch seg := (inverted & 0x70) >> 4; seg {
	case 0:
		value += 8
	case 1:
		value += 0x108
	default:
		value += 0x108
		value <<= seg - 1
	}
	if inverted&0x80 != 0 {
		return int16(value)
	}
	return int16(-value)
}

// encodeLinear converts linear samples to one companding law.
func encodeLinear(samples []int16, encoding Encoding) []byte {
	return encodeLinearInto(nil, samples, encoding)
}

// encodeLinearInto is encodeLinear writing into a caller-supplied buffer; a wrong-sized buffer is
// ignored and a new one allocated, so a caller can pass whatever it has.
func encodeLinearInto(dst []byte, samples []int16, encoding Encoding) []byte {
	out := dst
	if len(out) != len(samples) {
		out = make([]byte, len(samples))
	}
	if encoding == EncodingALaw {
		for index, sample := range samples {
			out[index] = LinearToALaw(sample)
		}
		return out
	}
	for index, sample := range samples {
		out[index] = LinearToULaw(sample)
	}
	return out
}

// recode converts between the two companding laws through the linear domain, and is a no-op when a
// file's stored law already matches the one the leg answered.
func recode(payload []byte, from, to Encoding) []byte {
	if from == to {
		return payload
	}
	out := make([]byte, len(payload))
	for index, encoded := range payload {
		var linear int16
		if from == EncodingALaw {
			linear = ALawToLinear(encoded)
		} else {
			linear = ULawToLinear(encoded)
		}
		if to == EncodingALaw {
			out[index] = LinearToALaw(linear)
		} else {
			out[index] = LinearToULaw(linear)
		}
	}
	return out
}
