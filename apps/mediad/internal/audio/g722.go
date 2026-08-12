package audio

// ITU-T G.722: 7 kHz wideband speech in 64 kbit/s, sub-band ADPCM. Rung 7 of
// plans/mediad-design.md §2, and the FIRST real DSP in this service.
//
// # Why G.722 is written here rather than pulled in
//
// The repo's Go dependencies are `pion/rtp`, `pion/sdp`, `nats.go` and `x/crypto`, and every one of
// them is a WIRE FORMAT or a protocol — a thing whose definition lives outside this repo and whose
// implementation must match everybody else's byte for byte. A codec is arithmetic. G.722 is two
// hundred lines of integer operations over tables printed in the standard, it has no security
// surface, no network behaviour and no version drift, and the same argument already applied to
// G.711: `g711.go` implements the companding tables in-repo rather than importing them.
//
// The alternative that was considered and rejected is `hraban/opus`, which is the only complete Opus
// binding for Go and is **cgo**. That would put a C toolchain and libopus into every build of this
// service — including the static, scratch-based container image the rest of the data plane produces
// — to serve a codec no endpoint in this deployment negotiates yet. Opus's own position is recorded
// in `codec.go`: it is NEGOTIATED and PASSED THROUGH, which needs no codec at all, and transcoding
// it is refused by name. That refusal is honest and reversible; a cgo dependency is neither.
//
// # What this implementation is
//
// The 64 kbit/s mode (mode 1): a QMF splits 16 kHz input into two 8 kHz sub-bands, the lower band is
// ADPCM-coded at 6 bits and the upper at 2, and the two pack into one octet per input SAMPLE PAIR.
// So 20 ms of G.722 is 320 input samples and 160 octets — the same 160-byte payload a 20 ms G.711
// frame carries, which is why the framing above this file needed no change at all.
//
// Modes 2 and 3 (56 and 48 kbit/s) are NOT implemented. They exist to steal bandwidth from the
// lower band for an auxiliary data channel that no VoIP endpoint has ever used, RFC 3551 says the
// RTP payload is the 64 kbit/s stream, and an endpoint that offered one would be doing something
// this deployment has no way to have asked for.
//
// # The clock-rate trap, stated where it can be seen
//
// G.722 samples at 16 kHz and its RTP clock rate is 8000. That is not a mistake here: RFC 3551 §4.5.2
// records it as an error in the original specification that was left standing because implementations
// had already shipped, and an `a=rtpmap:9 G722/16000` is the single most common G.722 interop bug in
// the industry. `internal/sdp` writes 8000 and this file works in samples; the two must not be
// confused, so neither one converts.

// g722QMFCoeffs is the 24-tap quadrature mirror filter, expressed as its 12 distinct coefficients.
//
// From the standard. The filter is what splits the band, and its symmetry is what lets the analysis
// and synthesis halves share one table.
var g722QMFCoeffs = [12]int32{3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11}

// The quantiser and scale-factor tables from ITU-T G.722, verbatim. They are normative data in
// exactly the way the G.711 segment tables next door are: a value changed here does not produce
// slightly different audio, it produces a decoder somewhere else that cannot follow this encoder.
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

// g722Band is one sub-band's adaptive predictor state.
//
// Six zeros and two poles, which is the ADPCM predictor G.721 established and G.722 reuses per band.
// The whole reason a codec state object exists — and the reason a G.722 stream cannot be cut into
// pieces and reassembled — is that these coefficients are ADAPTED from the signal, so an encoder and
// a decoder stay in step only by seeing the same octets in the same order from the same start.
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

// block4 is the standard's adaptive-predictor update, run once per sub-band per sample pair.
//
// Named for the block number in the specification's own diagram rather than for what it does,
// deliberately: every published G.722 implementation uses these names, and a reader checking this
// against the standard needs the labels to line up.
func (b *g722Band) block4(d int32) {
	// RECONS / PARREC.
	b.d[0] = d
	b.r[0] = g722Saturate(b.s + d)
	b.p[0] = g722Saturate(b.sz + d)

	// UPPOL2 — the second-order pole coefficient.
	for i := 0; i < 3; i++ {
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

// G722Encoder turns 16 kHz linear samples into G.722 octets.
//
// STATEFUL, and that is the property every caller has to respect: one encoder per outbound stream,
// for the life of the stream. Encoding two legs' audio through one encoder produces two streams of
// plausible octets that neither decoder can follow, because the predictor has been adapting to the
// interleaving of both.
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

// Encode converts 16 kHz samples to octets, one octet per PAIR of samples.
//
// An odd-length input drops its final sample rather than padding: a half sample pair is half a QMF
// step, and inventing a companion for it would put a sample the caller never supplied into the
// stream and leave the two sides one sample apart for the rest of the call.
func (e *G722Encoder) Encode(samples []int16) []byte {
	out := make([]byte, 0, len(samples)/2)
	for index := 0; index+1 < len(samples); index += 2 {
		copy(e.x[:22], e.x[2:24])
		e.x[22] = int32(samples[index])
		e.x[23] = int32(samples[index+1])

		var sumOdd, sumEven int32
		for i := 0; i < 12; i++ {
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

	// INVQAL — the encoder decodes its own choice, because the predictor must adapt to what the
	// DECODER will see rather than to what came in. This is what keeps the two ends in step.
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
	out := make([]int16, 0, len(payload)*2)
	for _, octet := range payload {
		low := d.decodeLow(int32(octet) & 0x3F)
		high := d.decodeHigh((int32(octet) >> 6) & 0x03)

		copy(d.x[:22], d.x[2:24])
		d.x[22] = low + high
		d.x[23] = low - high

		var sumOdd, sumEven int32
		for i := 0; i < 12; i++ {
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

	// The 6-bit code reconstructs the sample; its top four bits drive the scale factor, which is why
	// a decoder that only used the wide table would drift out of step with the encoder.
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

// g722Scale is the standard's SCALEL/SCALEH step: a log-domain scale factor turned into a linear
// one through the ILB table and a shift. The two bands differ only by that shift's offset.
func g722Scale(nb, offset int32) int32 {
	index := (nb >> 6) & 31
	shift := offset - (nb >> 11)
	if shift < 0 {
		return g722ILB[index] << -shift
	}
	return g722ILB[index] >> shift
}
