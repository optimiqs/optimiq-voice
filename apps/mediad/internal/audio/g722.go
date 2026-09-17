package audio

// ITU-T G.722: 7 kHz wideband speech at 64 kbit/s (mode 1), sub-band ADPCM.
//
// A QMF splits 16 kHz input into two 8 kHz sub-bands; the lower band is ADPCM-coded at 6 bits and
// the upper at 2, packing into one octet per input sample PAIR. So 20 ms is 320 input samples and
// 160 octets, the same payload size a 20 ms G.711 frame carries.
//
// Modes 2 and 3 (56 and 48 kbit/s) are not implemented: RFC 3551 defines the RTP payload as the
// 64 kbit/s stream.
//
// Clock-rate trap: G.722 samples at 16 kHz but its RTP clock rate is 8000. RFC 3551 §4.5.2 records
// this as a specification error left standing because implementations had shipped. internal/sdp
// writes 8000 and this file works in samples; neither converts.

// g722QMFCoeffs is the 24-tap quadrature mirror filter, expressed as its 12 distinct coefficients.
// Its symmetry lets the analysis and synthesis halves share one table.
var g722QMFCoeffs = [12]int32{3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11}

// Quantiser and scale-factor tables from ITU-T G.722, verbatim. Normative data: a changed value
// does not shift the audio slightly, it makes every other decoder unable to follow this encoder.
var (
	g722Q6 = [32]int32{
		0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714,
		786, 858, 940, 1023, 1121, 1219, 1339, 1458, 1612, 1765, 1980, 2195, 2557, 2919, 0, 0,
	}
	g722ILN = [32]int32{
		0, 63, 62, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19,
		18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 0,
	}
	g722ILP = [32]int32{
		0, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47,
		46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 0,
	}
	g722WL   = [8]int32{-60, -30, 58, 172, 334, 538, 1198, 3042}
	g722RL42 = [16]int32{0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0}
	g722ILB  = [32]int32{
		2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383,
		2435, 2489, 2543, 2599, 2656, 2714, 2774, 2834,
		2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371,
		3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008,
	}
	g722QM2 = [4]int32{-7408, -1616, 7408, 1616}
	g722QM4 = [16]int32{
		0, -20456, -12896, -8968, -6288, -4240, -2584, -1200,
		20456, 12896, 8968, 6288, 4240, 2584, 1200, 0,
	}
	g722QM6 = [64]int32{
		-136, -136, -136, -136, -24808, -21904, -19008, -16704,
		-14984, -13512, -12280, -11192, -10232, -9360, -8576, -7856,
		-7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576,
		-3168, -2776, -2400, -2032, -1688, -1360, -1040, -728,
		24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192,
		10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456,
		4944, 4464, 4008, 3576, 3168, 2776, 2400, 2032,
		1688, 1360, 1040, 728, 432, 136, -432, -136,
	}
	g722IHN = [3]int32{0, 1, 0}
	g722IHP = [3]int32{0, 3, 2}
	g722WH  = [3]int32{0, -214, 798}
	g722RH2 = [4]int32{2, 1, 2, 1}
)

// g722Band is one sub-band's adaptive predictor state: six zeros and two poles. The coefficients
// adapt to the signal, so encoder and decoder stay in step only by seeing the same octets in the
// same order from the same start; a stream cannot be cut up and reassembled.
type g722Band struct {
	s, sp, sz int32
	r         [3]int32
	a         [3]int32
	ap        [3]int32
	p         [3]int32
	d         [7]int32
	b         [7]int32
	bp        [7]int32
	sg        [7]int32
	nb        int32
	det       int32
}

func (b *g722Band) reset() {
	*b = g722Band{det: 32}
}

// g722Saturate clamps to the 16-bit range the standard's arithmetic is defined over.
func g722Saturate(value int32) int32 {
	switch {
	case value > 32767:
		return 32767
	case value < -32768:
		return -32768
	default:
		return value
	}
}

// block4 is the standard's adaptive-predictor update, run once per sub-band per sample pair. It and
// the labels inside it are named for the specification's own diagram so the code can be checked
// against it.
func (b *g722Band) block4(d int32) {
	// RECONS / PARREC.
	b.d[0] = d
	b.r[0] = g722Saturate(b.s + d)
	b.p[0] = g722Saturate(b.sz + d)

	// UPPOL2 — the second-order pole coefficient.
	for i := range 3 {
		b.sg[i] = b.p[i] >> 15
	}
	wd1 := g722Saturate(b.a[1] << 2)
	wd2 := -wd1
	if b.sg[0] != b.sg[1] {
		wd2 = wd1
	}
	if wd2 > 32767 {
		wd2 = 32767
	}
	wd3 := (wd2 >> 7) - 128
	if b.sg[0] == b.sg[2] {
		wd3 = (wd2 >> 7) + 128
	}
	wd3 += (b.a[2] * 32512) >> 15
	switch {
	case wd3 > 12288:
		wd3 = 12288
	case wd3 < -12288:
		wd3 = -12288
	}
	b.ap[2] = wd3

	// UPPOL1 — the first-order pole coefficient.
	b.sg[0] = b.p[0] >> 15
	b.sg[1] = b.p[1] >> 15
	wd1 = -192
	if b.sg[0] == b.sg[1] {
		wd1 = 192
	}
	wd2 = (b.a[1] * 32640) >> 15
	b.ap[1] = g722Saturate(wd1 + wd2)
	wd3 = g722Saturate(15360 - b.ap[2])
	switch {
	case b.ap[1] > wd3:
		b.ap[1] = wd3
	case b.ap[1] < -wd3:
		b.ap[1] = -wd3
	}

	// UPZERO — the six zero coefficients.
	wd1 = 128
	if d == 0 {
		wd1 = 0
	}
	b.sg[0] = d >> 15
	for i := 1; i < 7; i++ {
		b.sg[i] = b.d[i] >> 15
		wd2 = -wd1
		if b.sg[i] == b.sg[0] {
			wd2 = wd1
		}
		wd3 = (b.b[i] * 32640) >> 15
		b.bp[i] = g722Saturate(wd2 + wd3)
	}

	// DELAYA.
	for i := 6; i > 0; i-- {
		b.d[i] = b.d[i-1]
		b.b[i] = b.bp[i]
	}
	for i := 2; i > 0; i-- {
		b.r[i] = b.r[i-1]
		b.p[i] = b.p[i-1]
		b.a[i] = b.ap[i]
	}

	// FILTEP.
	wd1 = g722Saturate(b.r[1] + b.r[1])
	wd1 = (b.a[1] * wd1) >> 15
	wd2 = g722Saturate(b.r[2] + b.r[2])
	wd2 = (b.a[2] * wd2) >> 15
	b.sp = g722Saturate(wd1 + wd2)

	// FILTEZ.
	b.sz = 0
	for i := 6; i > 0; i-- {
		wd1 = g722Saturate(b.d[i] + b.d[i])
		b.sz += (b.b[i] * wd1) >> 15
	}
	b.sz = g722Saturate(b.sz)

	// PREDIC.
	b.s = g722Saturate(b.sp + b.sz)
}

// G722Encoder turns 16 kHz linear samples into G.722 octets. Stateful: one encoder per outbound
// stream, for the life of the stream. Interleaving two streams through one encoder produces octets
// no decoder can follow.
type G722Encoder struct {
	bands [2]g722Band
	x     [24]int32
}

// NewG722Encoder starts a stream.
func NewG722Encoder() *G722Encoder {
	encoder := &G722Encoder{}
	encoder.Reset()
	return encoder
}

// Reset returns the encoder to its start state.
func (e *G722Encoder) Reset() {
	e.bands[0].reset()
	e.bands[1].reset()
	e.x = [24]int32{}
}

// Encode converts 16 kHz samples to octets, one octet per PAIR of samples. An odd-length input
// drops its final sample rather than padding, which would leave the two sides one sample apart for
// the rest of the call.
func (e *G722Encoder) Encode(samples []int16) []byte {
	return e.encodeInto(make([]byte, 0, len(samples)/2), samples)
}

// encodeInto is Encode writing into a caller-supplied buffer, for the packet path.
func (e *G722Encoder) encodeInto(dst []byte, samples []int16) []byte {
	out := dst[:0]
	for index := 0; index+1 < len(samples); index += 2 {
		copy(e.x[:22], e.x[2:24])
		e.x[22] = int32(samples[index])
		e.x[23] = int32(samples[index+1])

		var sumOdd, sumEven int32
		for i := range 12 {
			sumOdd += e.x[2*i] * g722QMFCoeffs[i]
			sumEven += e.x[2*i+1] * g722QMFCoeffs[11-i]
		}
		low := (sumEven + sumOdd) >> 14
		high := (sumEven - sumOdd) >> 14

		out = append(out, byte(e.encodeHigh(high)<<6|e.encodeLow(low)))
	}
	return out
}

// encodeLow runs the 6-bit lower-band quantiser and its scale-factor adaptation.
func (e *G722Encoder) encodeLow(low int32) int32 {
	band := &e.bands[0]

	// SUBTRA / QUANTL.
	el := g722Saturate(low - band.s)
	magnitude := el
	if el < 0 {
		magnitude = -(el + 1)
	}
	index := 1
	for ; index < 30; index++ {
		if magnitude < (g722Q6[index]*band.det)>>12 {
			break
		}
	}
	code := g722ILP[index]
	if el < 0 {
		code = g722ILN[index]
	}

	// INVQAL — the encoder decodes its own choice: the predictor must adapt to what the decoder
	// will see, not to what came in.
	ril := code >> 2
	d := (band.det * g722QM4[ril]) >> 15

	// LOGSCL / SCALEL.
	band.nb = ((band.nb * 127) >> 7) + g722WL[g722RL42[ril]]
	switch {
	case band.nb < 0:
		band.nb = 0
	case band.nb > 18432:
		band.nb = 18432
	}
	band.det = g722Scale(band.nb, 8) << 2

	band.block4(d)
	return code & 0x3F
}

// encodeHigh runs the 2-bit upper-band quantiser and its scale-factor adaptation.
func (e *G722Encoder) encodeHigh(high int32) int32 {
	band := &e.bands[1]

	eh := g722Saturate(high - band.s)
	magnitude := eh
	if eh < 0 {
		magnitude = -(eh + 1)
	}
	mih := int32(1)
	if magnitude >= (564*band.det)>>12 {
		mih = 2
	}
	code := g722IHP[mih]
	if eh < 0 {
		code = g722IHN[mih]
	}

	d := (band.det * g722QM2[code]) >> 15

	band.nb = ((band.nb * 127) >> 7) + g722WH[g722RH2[code]]
	switch {
	case band.nb < 0:
		band.nb = 0
	case band.nb > 22528:
		band.nb = 22528
	}
	band.det = g722Scale(band.nb, 10) << 2

	band.block4(d)
	return code & 0x03
}

// G722Decoder turns G.722 octets back into 16 kHz linear samples. Stateful; see G722Encoder.
type G722Decoder struct {
	bands [2]g722Band
	x     [24]int32
}

// NewG722Decoder starts a stream.
func NewG722Decoder() *G722Decoder {
	decoder := &G722Decoder{}
	decoder.Reset()
	return decoder
}

// Reset returns the decoder to its start state.
func (d *G722Decoder) Reset() {
	d.bands[0].reset()
	d.bands[1].reset()
	d.x = [24]int32{}
}

// Decode converts octets to 16 kHz samples, two samples per octet.
func (d *G722Decoder) Decode(payload []byte) []int16 {
	return d.decodeInto(make([]int16, 0, len(payload)*2), payload)
}

// decodeInto is Decode writing into a caller-supplied buffer.
func (d *G722Decoder) decodeInto(dst []int16, payload []byte) []int16 {
	out := dst[:0]
	for _, octet := range payload {
		low := d.decodeLow(int32(octet) & 0x3F)
		high := d.decodeHigh((int32(octet) >> 6) & 0x03)

		copy(d.x[:22], d.x[2:24])
		d.x[22] = low + high
		d.x[23] = low - high

		var sumOdd, sumEven int32
		for i := range 12 {
			sumOdd += d.x[2*i] * g722QMFCoeffs[i]
			sumEven += d.x[2*i+1] * g722QMFCoeffs[11-i]
		}
		out = append(out,
			int16(g722Saturate(sumEven>>11)),
			int16(g722Saturate(sumOdd>>11)))
	}
	return out
}

func (d *G722Decoder) decodeLow(code int32) int32 {
	band := &d.bands[0]

	// The 6-bit code reconstructs the sample; its top four bits drive the scale factor.
	wide := (band.det * g722QM6[code]) >> 15
	reconstructed := band.s + wide
	switch {
	case reconstructed > 16383:
		reconstructed = 16383
	case reconstructed < -16384:
		reconstructed = -16384
	}

	ril := code >> 2
	dlow := (band.det * g722QM4[ril]) >> 15

	band.nb = ((band.nb * 127) >> 7) + g722WL[g722RL42[ril]]
	switch {
	case band.nb < 0:
		band.nb = 0
	case band.nb > 18432:
		band.nb = 18432
	}
	band.det = g722Scale(band.nb, 8) << 2

	band.block4(dlow)
	return reconstructed
}

func (d *G722Decoder) decodeHigh(code int32) int32 {
	band := &d.bands[1]

	dhigh := (band.det * g722QM2[code]) >> 15
	reconstructed := band.s + dhigh
	switch {
	case reconstructed > 16383:
		reconstructed = 16383
	case reconstructed < -16384:
		reconstructed = -16384
	}

	band.nb = ((band.nb * 127) >> 7) + g722WH[g722RH2[code]]
	switch {
	case band.nb < 0:
		band.nb = 0
	case band.nb > 22528:
		band.nb = 22528
	}
	band.det = g722Scale(band.nb, 10) << 2

	band.block4(dhigh)
	return reconstructed
}

// g722Scale is the standard's SCALEL/SCALEH step: a log-domain scale factor turned linear through
// the ILB table and a shift. The two bands differ only by that shift's offset.
func g722Scale(nb, offset int32) int32 {
	index := (nb >> 6) & 31
	shift := offset - (nb >> 11)
	if shift < 0 {
		return g722ILB[index] << -shift
	}
	return g722ILB[index] >> shift
}
