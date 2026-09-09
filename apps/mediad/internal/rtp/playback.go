package rtp

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// PlaybackEndReason is why a playback stopped. The values match the wire contract's
// `MediaPlaybackFinishedReason` (packages/events/src/schemas/media-events.ts) exactly.
type PlaybackEndReason string

// Every way a playback can end.
const (
	// PlaybackCompleted means the last frame was sent. The far end heard the whole prompt.
	PlaybackCompleted PlaybackEndReason = "completed"
	// PlaybackStopped means `rpc.media.v1.stop-playback`, a superseding playback, or the session
	// ending underneath it.
	PlaybackStopped PlaybackEndReason = "stopped"
	// PlaybackError means a frame could not be put on the wire.
	PlaybackError PlaybackEndReason = "error"
)

// ErrNoRemote is returned by StartPlayback when the session has not learned a far end yet.
// Symmetric RTP learns the address from the first inbound packet (see Session.latch), so until then
// a playback would report success and send nothing.
var ErrNoRemote = errors.New("rtp: the session has not learned a far end, so there is nowhere to play")

// ErrPlaybackPayloadType is returned when a clip's law does not match the session's.
var ErrPlaybackPayloadType = errors.New("rtp: the clip is not in the codec this session negotiated")

// PlaybackSummary is a finished playback's facts, flattened for a Lifecycle implementation.
type PlaybackSummary struct {
	Ref      string
	Reason   PlaybackEndReason
	PlayedMs int
	Detail   string
	// Kind is what the audio was. Diagnostic and not on the wire; see PlaybackKind.
	Kind PlaybackKind
}

// PlaybackOptions is one prompt, already decoded and cut into frames.
type PlaybackOptions struct {
	// Ref is the engine-assigned playback reference. Required, and unique across the instance:
	// `rpc.media.v1.stop-playback` carries nothing else.
	Ref string
	// Frames are 20 ms G.711 payloads in the session's negotiated law. See internal/audio.
	Frames [][]byte
	// Encoding is the law Frames are in. Checked against the session's: a µ-law prompt on an A-law
	// leg is a loud rasp.
	Encoding audio.Encoding
	// Loop makes the frames repeat until something stops the playback: music on hold, a ringback
	// cadence. A looping playback never ends `completed`, only `stopped`, so PlayedMs is the only
	// measure of how long a caller heard it.
	Loop bool
	// Kind labels what the audio IS, for the log line and for the summary. See PlaybackKind.
	Kind PlaybackKind
}

// PlaybackKind is what a playback is for. Diagnostic only: the packet path treats all three
// identically, and the wire contract carries a reference rather than a kind.
type PlaybackKind string

// The three things a playback can be.
const (
	// PlaybackPrompt is a file the engine asked for.
	PlaybackPrompt PlaybackKind = "prompt"
	// PlaybackMusicOnHold is a hold loop, started by a hold or by a music command.
	PlaybackMusicOnHold PlaybackKind = "moh"
	// PlaybackTone is a generated call-progress tone.
	PlaybackTone PlaybackKind = "tone"
)

// Playback is one prompt in flight on one session.
//
// A playback REPLACES the peer's audio rather than interleaving with it: a session has one SSRC and
// one sequence space, and two sources with unrelated timestamp clocks sharing them is exactly what
// a receiver's jitter buffer cannot untangle. Suppression applies only to what is written OUT of
// this socket, so DTMF arriving INTO the session still relays — which is what makes barge-in work.
type Playback struct {
	ref     string
	frames  [][]byte
	loop    bool
	kind    PlaybackKind
	session *Session

	// sent counts frames actually written, which is what PlayedMs is derived from — not the clip
	// length.
	sent atomic.Int64

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}

	// finishOnce guards the summary, because two paths race to end a playback: the stop channel and
	// the frame loop running out of frames.
	finishOnce sync.Once
	summary    PlaybackSummary
}

// Ref is the engine-assigned reference this playback answers to.
func (p *Playback) Ref() string { return p.ref }

// Done is closed when the playback has ended and its summary is final.
func (p *Playback) Done() <-chan struct{} { return p.done }

// Sent is how many frames have reached the socket.
func (p *Playback) Sent() int { return int(p.sent.Load()) }

// Summary is the finished playback's facts. Only meaningful once Done is closed.
func (p *Playback) Summary() PlaybackSummary { return p.summary }

// Stop interrupts the playback. Idempotent, and a stop of a finished playback does nothing.
func (p *Playback) Stop() {
	p.stopOnce.Do(func() { close(p.stop) })
}

// StartPlayback begins sourcing frames from a clip instead of from the peer. It returns as soon as
// the playback is running, never when it has finished. A second playback on a session supersedes
// the first, which finishes `stopped`.
func (s *Session) StartPlayback(opts PlaybackOptions) (*Playback, error) {
	switch {
	case opts.Ref == "":
		return nil, errors.New("rtp: a playback reference is required")
	case len(opts.Frames) == 0:
		return nil, errors.New("rtp: a playback needs at least one frame")
	}
	if encodingOf(s.AudioPayloadType()) != opts.Encoding {
		return nil, fmt.Errorf("%w: the clip is %s and the session answered %s",
			ErrPlaybackPayloadType, opts.Encoding, encodingOf(s.AudioPayloadType()))
	}
	if s.Remote() == nil {
		return nil, ErrNoRemote
	}
	if s.isClosed() {
		return nil, ErrUnknownSession
	}

	kind := opts.Kind
	if kind == "" {
		kind = PlaybackPrompt
	}
	playback := &Playback{
		ref:     opts.Ref,
		frames:  opts.Frames,
		loop:    opts.Loop,
		kind:    kind,
		session: s,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}

	if superseded := s.swapPlayback(playback); superseded != nil {
		superseded.Stop()
	}

	go playback.run()
	return playback, nil
}

// StopPlayback interrupts the session's active playback when it matches ref. Matching on the
// reference fences a late stop off from a prompt that started after the one it names.
func (s *Session) StopPlayback(ref string) bool {
	playback := s.ActivePlayback()
	if playback == nil || playback.ref != ref {
		return false
	}
	playback.Stop()
	return true
}

// ActivePlayback is the prompt currently playing, or nil.
func (s *Session) ActivePlayback() *Playback { return s.playback.Load() }

// swapPlayback installs a playback and returns whichever it displaced.
func (s *Session) swapPlayback(next *Playback) *Playback {
	return s.playback.Swap(next)
}

// clearPlayback removes a playback if it is still the active one.
func (s *Session) clearPlayback(playback *Playback) {
	s.playback.CompareAndSwap(playback, nil)
}

// run paces the clip onto the wire, one frame every 20 ms, until it runs out or is stopped.
//
// A ticker rather than a sleep: a per-frame sleep accumulates each write's cost as drift, which the
// far end's jitter buffer absorbs by discarding audio. A ticker keeps the schedule absolute.
func (p *Playback) run() {
	defer close(p.done)
	defer p.session.clearPlayback(p)

	ticks, stopTicker := p.session.newTicker(audio.FrameDurationMs * time.Millisecond)
	defer stopTicker()

	// `first` and not `index == 0`: a loop returns to index 0 on every wrap, and the marker belongs
	// to the one moment the stream changed clocks.
	first := true
	// Not range-over-int: the wrap below rewinds index, which a range loop would ignore.
	for index := 0; index < len(p.frames); index++ {
		select {
		case <-p.stop:
			p.finish(PlaybackStopped, "")
			return
		case <-p.session.done:
			// The leg went away; nothing failed, so `stopped` rather than `error`.
			p.finish(PlaybackStopped, "the session ended")
			return
		case <-ticks:
		}

		// RFC 3550's start-of-talkspurt marker on the first frame. The outbound timestamps switch from
		// the peer's clock to ours here, and without the marker a receiver reads that discontinuity
		// inside one SSRC as catastrophic loss.
		sent, err := p.session.sendPlaybackFrame(p.frames[index], first)
		if err != nil {
			p.finish(PlaybackError, err.Error())
			return
		}
		first = false
		if sent {
			p.sent.Add(1)
		}

		if p.loop && index == len(p.frames)-1 {
			// The wrap. Same SSRC, sequence counter and timestamp step, so the far end cannot tell it
			// from any other frame boundary; whether it SOUNDS seamless is a property of the clip.
			index = -1
		}
	}
	p.finish(PlaybackCompleted, "")
}

func (p *Playback) finish(reason PlaybackEndReason, detail string) {
	p.finishOnce.Do(func() {
		p.summary = PlaybackSummary{
			Ref:      p.ref,
			Reason:   reason,
			PlayedMs: p.Sent() * audio.FrameDurationMs,
			Detail:   detail,
			Kind:     p.kind,
		}
		// The next relayed packet carries a marker: the stream switches back to the peer's clock.
		p.session.markNextForward.Store(true)
	})
}

// sendPlaybackFrame writes one prompt frame out of this session's socket, sharing the session's
// SSRC and sequence counter with the relay so the endpoint sees one continuous sender.
//
// It reports whether the frame reached the socket: a DTMF injection owns the outbound clock for its
// span (see DtmfInjection), and the playback's schedule is not paused across it, so an overlapped
// prompt is clipped rather than stretched.
func (s *Session) sendPlaybackFrame(payload []byte, marker bool) (bool, error) {
	if s.dtmfActive() {
		s.count(func(st *Stats) { st.SuppressedByDtmf++ })
		return false, nil
	}

	to := s.Remote()
	if to == nil {
		return false, ErrNoRemote
	}

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    s.AudioPayloadType(),
			SequenceNumber: s.nextSequence(),
			Timestamp:      s.nextPlaybackTimestamp(),
			SSRC:           s.SSRC,
			Marker:         marker,
		},
		Payload: payload,
	}

	encoded, scratch, err := marshalOutbound(&out)
	if err != nil {
		return false, fmt.Errorf("rtp: marshalling a playback frame: %w", err)
	}
	_, err = s.writeRTP(encoded, to)
	releaseOutbound(scratch)
	if err != nil {
		// Unlike a relayed frame, a failed playback write is not swallowed: it will fail for the next
		// frame too, and the caller needs a reason on the finished event.
		return false, fmt.Errorf("rtp: sending a playback frame to %s: %w", to, err)
	}
	s.countSent(uint32(len(payload)))

	// The send half of a `both` recording: a prompt played AT the recorded party belongs in it.
	if recorder := s.recording.Load(); recorder != nil {
		recorder.Sent(payload)
	}
	return true, nil
}

// nextPlaybackTimestamp advances the outbound clock by one frame, continuing from the last
// timestamp sent: a backwards jump makes some endpoints flush their buffer and clip the prompt.
func (s *Session) nextPlaybackTimestamp() uint32 {
	return s.lastTimestamp.Add(audio.FrameTimestampStep)
}

// encodingOf maps a negotiated G.711 payload type to the companding law internal/audio speaks.
func encodingOf(payloadType uint8) audio.Encoding {
	if payloadType == PayloadTypePCMA {
		return audio.EncodingALaw
	}
	return audio.EncodingULaw
}

// EncodingFor is encodingOf, exported so callers can decode a clip into the law a session answered.
func EncodingFor(payloadType uint8) audio.Encoding { return encodingOf(payloadType) }
