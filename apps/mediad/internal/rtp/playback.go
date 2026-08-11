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
	// ending underneath it. The COMMON outcome: every `gather` stops its own prompt on barge-in.
	PlaybackStopped PlaybackEndReason = "stopped"
	// PlaybackError means a frame could not be put on the wire.
	PlaybackError PlaybackEndReason = "error"
)

// ErrNoRemote is returned by StartPlayback when the session has not learned a far end yet.
//
// A refusal rather than a silent start. Symmetric RTP means the address is LEARNED from the first
// inbound packet (see Session.latch), so a leg that has not sent has taught us nowhere to send. A
// playback that "started" into that would report success, send nothing, and end `completed` — a
// caller in silence and an event stream that says the prompt played.
var ErrNoRemote = errors.New("rtp: the session has not learned a far end, so there is nowhere to play")

// ErrPlaybackPayloadType is returned when a clip's law does not match the session's.
var ErrPlaybackPayloadType = errors.New("rtp: the clip is not in the codec this session negotiated")

// PlaybackSummary is a finished playback's facts, flattened for a Lifecycle implementation.
type PlaybackSummary struct {
	Ref      string
	Reason   PlaybackEndReason
	PlayedMs int
	Detail   string
}

// PlaybackOptions is one prompt, already decoded and cut into frames.
type PlaybackOptions struct {
	// Ref is the engine-assigned playback reference. Required, and unique across the instance:
	// `rpc.media.v1.stop-playback` carries nothing else.
	Ref string
	// Frames are 20 ms G.711 payloads in the session's negotiated law. See internal/audio.
	Frames [][]byte
	// Encoding is the law Frames are in. Checked against the session's, because a µ-law prompt on
	// an A-law leg is a loud rasp rather than a wrong-sounding voice.
	Encoding audio.Encoding
}

// Playback is one prompt in flight on one session.
//
// # Why playback REPLACES the peer's audio rather than mixing with it
//
// A session has ONE outbound RTP stream: one SSRC, one sequence space, one socket. While a prompt
// is playing, the peer's relayed frames are dropped towards this leg rather than interleaved into
// that stream, and the relay resumes untouched the moment the prompt ends.
//
// Interleaving is not the "mixing" alternative it looks like — mixing means summing two decoded
// signals, which needs a decode, a jitter buffer to align them and an encode, i.e. rung 6 and the
// reason rung 6 is late in the ladder. What interleaving would actually produce is two audio
// sources sharing one SSRC with two unrelated timestamp clocks, which is precisely the input a
// jitter buffer cannot untangle: the receiver would hear both, badly, with concealment noise
// between them.
//
// # What replace does NOT interrupt, and why that is the point
//
// The direction that carries DTMF out of the played-to leg. A caller pressing 1 while the menu is
// still talking sends RFC 4733 INTO this session, and that path — handlePacket → relay → the peer's
// forward — is not touched by playback at all. Barge-in works because the digits keep flowing while
// the prompt plays; it is the entire reason `gather` calls `play` and `stopPlayback` around one
// collection. Suppression applies only to what is written OUT of this session's socket.
//
// A peer's own telephone-event packets are dropped along with its audio for the duration, and that
// is a deliberate narrowing rather than an oversight: the party being played a prompt is by
// construction not the party a digit from the far side is aimed at, and admitting one packet from
// the peer's timestamp clock into the prompt's stream would reintroduce exactly the problem the
// paragraph above rejects.
type Playback struct {
	ref     string
	frames  [][]byte
	session *Session

	// sent counts frames actually written, which is what `playedMs` is derived from. It is NOT the
	// clip length: a barge-in one second into a ten-second menu played one second.
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

// StartPlayback begins sourcing frames from a clip instead of from the peer.
//
// It returns as soon as the playback is RUNNING, never when it has finished. That is the contract
// the seam above requires: `MediaPort.play` hands back a handle the moment audio begins, because a
// caller who barges in must be able to interrupt without the engine holding a fiber open for the
// length of the prompt.
//
// A second playback on a session SUPERSEDES the first, which finishes `stopped`. The alternative —
// refusing, or queueing — is worse in both directions: refusing turns a re-prompt into a failed
// call, and queueing would make a caller who pressed a digit listen to the rest of the old menu
// before the new one started.
func (s *Session) StartPlayback(opts PlaybackOptions) (*Playback, error) {
	switch {
	case opts.Ref == "":
		return nil, errors.New("rtp: a playback reference is required")
	case len(opts.Frames) == 0:
		return nil, errors.New("rtp: a playback needs at least one frame")
	}
	if encodingOf(s.audioPayloadType) != opts.Encoding {
		return nil, fmt.Errorf("%w: the clip is %s and the session answered %s",
			ErrPlaybackPayloadType, opts.Encoding, encodingOf(s.audioPayloadType))
	}
	if s.Remote() == nil {
		return nil, ErrNoRemote
	}
	if s.isClosed() {
		return nil, ErrUnknownSession
	}

	playback := &Playback{
		ref:     opts.Ref,
		frames:  opts.Frames,
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

// StopPlayback interrupts the session's active playback when it matches ref.
//
// Matching on the reference rather than stopping whatever is playing is fencing, and it is the same
// argument `park-handoff` makes about `mediaChannelId`: a stop that arrived late, after the prompt
// it names finished and a second one started, must not silence the new prompt.
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
// # Why a ticker rather than a sleep
//
// A sleep of 20 ms per frame accumulates every frame's send cost as drift: at 50 frames a second a
// 200 µs write makes a ten-second prompt play eleven seconds, and the far end's jitter buffer
// absorbs the difference by discarding audio. A ticker keeps the schedule absolute. If a tick is
// missed entirely — a heavily loaded box — the frame after it is sent immediately, which is what a
// receiver's buffer is designed to smooth over.
func (p *Playback) run() {
	defer close(p.done)
	defer p.session.clearPlayback(p)

	ticks, stopTicker := p.session.newTicker(audio.FrameDurationMs * time.Millisecond)
	defer stopTicker()

	for index := range p.frames {
		select {
		case <-p.stop:
			p.finish(PlaybackStopped, "")
			return
		case <-p.session.done:
			// The session was released or reaped under a live prompt. `stopped` rather than `error`:
			// nothing failed, the leg went away, and the `session.ended` event carries the real story.
			p.finish(PlaybackStopped, "the session ended")
			return
		case <-ticks:
		}

		// The marker bit on the FIRST frame is RFC 3550's start-of-talkspurt flag, and it is
		// load-bearing here rather than decorative: the outbound stream's timestamps come from the
		// peer's clock while relaying and from ours while playing, so a prompt starting mid-call is
		// a timestamp discontinuity inside one SSRC. Marker is exactly how a sender tells a receiver
		// "reset your expectation, a new talkspurt begins here" instead of letting the jitter buffer
		// read the jump as catastrophic loss.
		if err := p.session.sendPlaybackFrame(p.frames[index], index == 0); err != nil {
			p.finish(PlaybackError, err.Error())
			return
		}
		p.sent.Add(1)
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
		}
		// The next relayed packet carries a marker for the same reason the first played one did:
		// the stream is about to switch back to the peer's timestamp clock.
		p.session.markNextForward.Store(true)
	})
}

// sendPlaybackFrame writes one prompt frame out of this session's socket.
//
// It shares the session's SSRC and sequence counter with the relay deliberately. A prompt is not a
// second stream — it is the same leg's audio, sourced from a file for a while — and giving it its
// own SSRC would make the endpoint see a new sender start and stop around every prompt, which is
// the audible click the relay's header rewrite exists to avoid.
func (s *Session) sendPlaybackFrame(payload []byte, marker bool) error {
	to := s.Remote()
	if to == nil {
		return ErrNoRemote
	}

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    s.audioPayloadType,
			SequenceNumber: s.nextSequence(),
			Timestamp:      s.nextPlaybackTimestamp(),
			SSRC:           s.SSRC,
			Marker:         marker,
		},
		Payload: payload,
	}

	encoded, err := out.Marshal()
	if err != nil {
		return fmt.Errorf("rtp: marshalling a playback frame: %w", err)
	}
	if _, err := s.ports.RTP.WriteToUDP(encoded, to); err != nil {
		// Unlike a relayed frame, a failed playback write is NOT swallowed. A relay drops one frame
		// of a conversation that is still going; a playback that cannot reach the socket will not
		// reach it for the next frame either, and reporting `error` is what turns "the caller heard
		// nothing" into an event with a reason on it.
		return fmt.Errorf("rtp: sending a playback frame to %s: %w", to, err)
	}
	s.count(func(st *Stats) { st.PacketsSent++ })
	return nil
}

// nextPlaybackTimestamp advances the outbound clock by one frame.
//
// It continues from the last timestamp this session put on the wire rather than starting at zero,
// so a prompt in the middle of a call does not send the stream's timestamp BACKWARDS — which some
// endpoints treat as a stream restart and answer by flushing their buffer, clipping the first
// syllable of every prompt.
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

// EncodingFor is encodingOf, exported for the control surface, which has to decode a clip into the
// law a session already answered before it can hand the frames over.
func EncodingFor(payloadType uint8) audio.Encoding { return encodingOf(payloadType) }
