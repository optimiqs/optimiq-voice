package rtp

import (
	"errors"
	"fmt"
	"sync"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Translating audio at the boundary between two legs that answered with different codecs.
//
// Passthrough stays the fast path: a *Transcoder is installed only when the two ends of a bridge
// disagree. Otherwise Session.transcode is nil and forward copies the payload byte for byte.
//
// The RTP timestamp survives the translation because every codec transcoded here has an RTP clock
// rate of 8000 — including G.722, whose 16 kHz sampling and 8 kHz clock rate are RFC 3551 §4.5.2's
// erratum — so 20 ms is 160 ticks on both sides. Opus, whose clock rate really is 48000, cannot be
// transcoded on this path: the timestamps would have to be rewritten.
//
// Translation preserves media time rather than assuming 20 ms: a 30 ms packet decodes to 240 samples
// and re-encodes to a 30 ms payload, so the packetisation the sender chose survives and the
// timestamps stay continuous. PCMU, PCMA and G.722 all carry one octet per 8 kHz sample, so no
// repacketisation buffer is needed.

// ErrCannotTranscode is returned when two legs disagree about a codec that cannot be translated.
//
// A mismatch is not itself a refusal: this fires only for a codec this build has no decoder for,
// which today means Opus bridged to anything that is not Opus. The control surface turns it into
// `not_supported` naming the codec.
var ErrCannotTranscode = errors.New(
	"rtp: the two sessions negotiated codecs this build cannot translate between")

// Transcoder translates payloads from one codec into another, in one direction.
//
// One per direction, living on the destination session: both halves are stateful (G.722's predictors
// and the resampler's filter history), so sharing one between directions would interleave two
// conversations through one predictor.
type Transcoder struct {
	from audio.Format
	to   audio.Format

	// mu guards the codec state. Uncontended in steady state (one goroutine per source); it exists
	// for the window where an old peer's read goroutine is still in flight while a re-bridge
	// installs a new transcoder.
	mu      sync.Mutex
	decoder audio.FrameDecoder
	encoder audio.FrameEncoder
}

// NewTranscoder builds a translation, or refuses one it cannot perform. It refuses the identity
// translation too: that would decode and re-encode every frame for no change in the bytes, turning
// the fast path into the slow one invisibly.
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

// Translate converts one payload, keeping its duration. The `false` is a payload that carried no
// audio at all.
func (t *Transcoder) Translate(payload []byte) ([]byte, bool) {
	if len(payload) == 0 {
		return nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.encoder.Encode(t.decoder.Decode(payload)), true
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
// Building and installing are separate steps so Bridge can refuse before mutating anything: a bridge
// that installed one direction and failed on the second would have one party hearing noise.
//
// Two legs that agreed get a pair of nils, and install clears both sessions so a re-bridge onto an
// agreeing peer cannot inherit the previous peer's translation.
func prepareTranscoders(a, b *Session) (transcoderPair, error) {
	aFormat, bFormat := a.Format(), b.Format()
	if aFormat == bFormat {
		return transcoderPair{}, nil
	}
	toB, err := NewTranscoder(aFormat, bFormat)
	if err != nil {
		return transcoderPair{}, err
	}
	toA, err := NewTranscoder(bFormat, aFormat)
	if err != nil {
		return transcoderPair{}, err
	}
	return transcoderPair{toA: toA, toB: toB}, nil
}

// install points each session at the translation it needs. Installed on the destination, because
// forward runs there and translates what it is about to write.
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
