package rtp

import (
	"errors"
	"fmt"
	"sync"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Rung 7's second half: translating audio at the boundary between two legs that answered
// differently.
//
// # Passthrough stays the fast path, and that is the design rather than an optimisation
//
// A `*Transcoder` is installed on a session ONLY when the two ends of its bridge negotiated
// different codecs. When they agreed — which is nearly always, because both ends of a call inside
// one deployment are configured by the same operator — `Session.transcode` is nil and `forward`
// takes the branch it has taken since rung 2: the payload is copied byte for byte with no decode,
// no allocation and no added latency. Rung 7 does not slow down rung 2; it adds a path rung 2
// refused to take.
//
// The refusal it replaces is worth remembering. `Manager.Bridge` used to answer `ErrCodecMismatch`
// for a µ-law leg bridged to an A-law one, and design doc §7 defended that as the right trade at
// rung 2 — "no DSP, no CPU cliff, no audio-quality regression to argue about against Asterisk".
// That was true when there was no decode path anywhere in the service. Rung 6 built one, so the
// argument's premise is gone, and the refusal with it.
//
// # Why the RTP timestamp survives the translation
//
// Because every codec this service transcodes has an RTP clock rate of 8000 — including G.722,
// whose 16 kHz sampling and 8 kHz clock rate are RFC 3551 §4.5.2's famous erratum. So one 20 ms
// frame advances the timestamp by 160 ticks on every side of every translation, and a relay that
// keeps the sender's timestamp is still telling the truth after transcoding it. That is a
// coincidence of the payload registry rather than a property of transcoding in general, and it is
// exactly why Opus — whose clock rate really is 48000 — cannot be transcoded on this path even if
// there were a codec for it: the timestamps would have to be rewritten, which means inventing a
// clock, which §6 refuses.
//
// # Why the frame sizes line up
//
// PCMU, PCMA and G.722 all produce 160 octets for 20 ms. The first two because 8 kHz × 20 ms × 1
// byte is 160, the third because 16 kHz × 20 ms × 4 bits is also 160. So a translated payload is the
// same length as the one it replaces and no repacketisation is needed — which is why this file has
// no frame-accumulation buffer in it and no decision about what to do with a 30 ms frame.

// ErrCannotTranscode is returned when two legs disagree about a codec that cannot be translated.
//
// The successor to ErrCodecMismatch, and a narrower error: the mismatch itself is no longer a
// refusal, so this fires only for a codec this build has no decoder for — which today means Opus
// bridged to anything that is not Opus. The control surface turns it into `not_supported` naming the
// codec, and the engine routes that leg to Asterisk exactly as it did for every mismatch before.
var ErrCannotTranscode = errors.New(
	"rtp: the two sessions negotiated codecs this build cannot translate between")

// Transcoder translates payloads from one codec into another, in one direction.
//
// # One per DIRECTION, and it lives on the DESTINATION session
//
// Both halves of it are stateful — G.722's predictors and the resampler's filter history each make
// a frame's output depend on every frame before it — so a transcoder shared between the two
// directions of a bridge would interleave two conversations through one predictor and produce
// plausible bytes that neither endpoint can decode. Attaching it to the destination session is what
// makes "one per direction" structural rather than a rule somebody has to remember.
type Transcoder struct {
	from audio.Format
	to   audio.Format

	// mu guards the codec state. The packet path is single-goroutine per source, so this is
	// uncontended in steady state; it exists for the window an attended transfer opens, where the old
	// peer's read goroutine can still be in flight while a re-bridge installs a new transcoder. That
	// is the same window the sequence counter's atomic exists for, and it is exactly what `-race`
	// catches and a production deploy does not.
	mu      sync.Mutex
	decoder audio.FrameDecoder
	encoder audio.FrameEncoder
}

// NewTranscoder builds a translation, or refuses one it cannot perform.
//
// It refuses the IDENTITY translation too, and that is a guard rather than pedantry: a transcoder
// installed for two legs that agreed would decode and re-encode every frame of every call for no
// change in the bytes, turning the fast path into the slow one invisibly. A caller that reaches here
// with two equal formats has a bug, and it is better to see it than to hear it as CPU.
func NewTranscoder(from, to audio.Format) (*Transcoder, error) {
	if from == to {
		return nil, fmt.Errorf("rtp: refusing to transcode %s to itself; passthrough is the fast path",
			from)
	}
	decoder, err := audio.NewFrameDecoder(from)
	if err != nil {
		return nil, fmt.Errorf("%w: %s to %s: %w", ErrCannotTranscode, from, to, err)
	}
	encoder, err := audio.NewFrameEncoder(to)
	if err != nil {
		return nil, fmt.Errorf("%w: %s to %s: %w", ErrCannotTranscode, from, to, err)
	}
	return &Transcoder{from: from, to: to, decoder: decoder, encoder: encoder}, nil
}

// From and To name the translation, for a log line and for a test.
func (t *Transcoder) From() audio.Format { return t.from }
func (t *Transcoder) To() audio.Format   { return t.to }

// Translate converts one payload. The `false` is a payload that carried no audio at all.
func (t *Transcoder) Translate(payload []byte) ([]byte, bool) {
	if len(payload) == 0 {
		return nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.encoder.EncodeFrame(t.decoder.DecodeFrame(payload)), true
}

// Reset restarts both codecs, for a stream that has restarted under the same bridge.
func (t *Transcoder) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.decoder.Reset()
	t.encoder.Reset()
}

// transcoderPair is the two directions of one bridge's translation, or two nils for a passthrough.
type transcoderPair struct {
	toA *Transcoder
	toB *Transcoder
}

// prepareTranscoders builds both directions of a bridge's translation, or neither.
//
// BUILDING and INSTALLING are separate steps on purpose. A bridge that installed one direction and
// then failed on the second would leave a call transcoding one way and passing through the other,
// which is one party hearing noise — worse than a refusal, and much harder to explain. Preparing
// first means `Bridge` can refuse before it has mutated anything at all.
//
// The nil case is the common one: two legs that agreed get a pair of nils, and `install` clears both
// sessions so a re-bridge onto an agreeing peer cannot inherit the previous peer's translation.
func prepareTranscoders(a, b *Session) (transcoderPair, error) {
	if a.format == b.format {
		return transcoderPair{}, nil
	}
	toB, err := NewTranscoder(a.format, b.format)
	if err != nil {
		return transcoderPair{}, err
	}
	toA, err := NewTranscoder(b.format, a.format)
	if err != nil {
		return transcoderPair{}, err
	}
	return transcoderPair{toA: toA, toB: toB}, nil
}

// install points each session at the translation it needs. Installed on the DESTINATION, because
// `forward` runs on the destination session and translates what it is about to write.
func (p transcoderPair) install(a, b *Session) {
	a.transcode.Store(p.toA)
	b.transcode.Store(p.toB)
}

// clearTranscoders takes both translations down, on unbridge.
func clearTranscoders(sessions ...*Session) {
	for _, session := range sessions {
		if session != nil {
			session.transcode.Store(nil)
		}
	}
}
