package rtp

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Rung 4 of plans/mediad-design.md §2: writing a session's audio to a file.
//
// # Why there is no snoop channel here
//
// On Asterisk, recording a conversation means creating a SNOOP channel that spies on `both`
// directions of a leg and recording that. The snoop exists because ARI addresses everything by
// channel id, so a tap needs to be a channel in order to be a thing a command can name.
//
// mediad has no such constraint: a session already IS both directions — what it receives is the far
// party, and what it sends is everything the far party was told — so the choice is an argument on
// the command rather than a second object with its own lifecycle, its own port and its own
// `leg-arrived` event for a leg that does not exist. That is why `MediaPort.snoop` stays refused on
// this driver while `record` does not: the primitive is not missing, it is unnecessary.

// RecordingDirection is which side of a session a recording captures.
type RecordingDirection string

// The two directions, matching the wire contract's `MEDIA_RECORDING_DIRECTIONS` exactly.
const (
	// RecordReceive captures only what the session RECEIVES: the far party speaking.
	//
	// What a voicemail wants. A mailbox message should hold the caller, not the greeting that was
	// played at them, and it is the faithful mirror of ARI's `channels.record` on a plain channel.
	RecordReceive RecordingDirection = "receive"
	// RecordBoth captures both directions, summed. What an on-demand call recording means.
	RecordBoth RecordingDirection = "both"
)

// RecordingEndReason is why a recording stopped. The values match the wire contract's
// `MediaRecordingFinishedReason` (packages/events/src/schemas/media-events.ts) exactly.
type RecordingEndReason string

// Every way a recording can end.
const (
	// RecordingStopped is `rpc.media.v1.stop-recording`. The engine asked.
	RecordingStopped RecordingEndReason = "stopped"
	// RecordingMaxDuration is the hard length limit. A complete file of exactly that length.
	RecordingMaxDuration RecordingEndReason = "max-duration"
	// RecordingMaxSilence is the caller having stopped talking. The NORMAL end of a voicemail.
	RecordingMaxSilence RecordingEndReason = "max-silence"
	// RecordingSessionEnded is the leg going away underneath it — released, reaped or drained.
	// Still a complete file: the recorder finalises on the way down.
	RecordingSessionEnded RecordingEndReason = "session-ended"
	// RecordingError is a file that could not be written or finalised. There is NO usable audio.
	RecordingError RecordingEndReason = "error"
)

// ErrAlreadyRecording is returned when a session already has a recording in flight.
//
// A refusal rather than a supersede, which is the opposite of the playback rule and is the right
// way round for the same reason: superseding a prompt loses audio nobody will miss, while
// superseding a recording throws away a file somebody asked for and is waiting on. Two recordings
// of one leg is also a genuinely different feature (a compliance copy alongside an on-demand one)
// and it should arrive as one, not as a side effect of a race.
var ErrAlreadyRecording = errors.New("rtp: this session is already being recorded")

// recordingQueueFrames is how much jitter each direction's queue absorbs before it drops.
//
// Half a second. The recorder consumes on a 20 ms tick and the network delivers in bursts, so a
// queue is what stops a burst from being truncated to one frame. It is bounded rather than
// unbounded because an unbounded queue turns a stalled writer — a full disk — into memory growth
// that takes the whole media plane down instead of one recording.
const recordingQueueFrames = 25

// silenceThreshold is the mean absolute sample below which a frame counts as quiet.
//
// ~1% of full scale. It has to be above zero because G.711 silence is not zero — the encoding has
// no exact representation of it, line noise exists, and a comfort-noise generator at the far end is
// deliberately not silent — and low enough that a person speaking quietly is never mistaken for one
// who has hung up and left the line open, which is the failure that truncates a voicemail mid-word.
const silenceThreshold = 300

// RecordingOptions is one recording, already resolved to a path by the control surface.
type RecordingOptions struct {
	// Ref is the engine-assigned reference. Required, unique across the instance, and the filename
	// stem: `rpc.media.v1.stop-recording` carries nothing else.
	Ref string
	// Path is the absolute file to write. Derived by the control surface from the recordings root
	// and the session's own org and call — never accepted from the caller.
	Path string
	// ObjectKey is the same file relative to that root, which is what the archive pipeline joins on.
	ObjectKey string
	// Direction is which side of the session to capture.
	Direction RecordingDirection
	// Encoding is the companding law the session negotiated, so frames can be decoded to linear.
	Encoding audio.Encoding
	// MaxDuration stops the recording after this long. Zero means no limit.
	MaxDuration time.Duration
	// MaxSilence stops it after this much continuous quiet. Zero means no limit.
	MaxSilence time.Duration
}

// RecordingSummary is a finished recording's facts, flattened for a Lifecycle implementation.
type RecordingSummary struct {
	Ref        string
	ObjectKey  string
	Direction  RecordingDirection
	Reason     RecordingEndReason
	DurationMs int
	Bytes      int64
	Detail     string
}

// Recording is one file being written from one session.
//
// # Why it runs on its own 20 ms tick rather than writing on arrival
//
// Writing each frame as it arrives is simpler and produces a file whose length is the number of
// PACKETS that turned up rather than the time that passed. That difference is not academic: an
// endpoint doing silence suppression sends nothing while nobody speaks, so a write-on-arrival
// recording of a 30-second voicemail with two pauses in it is 22 seconds long and every word after
// the first pause is early. A ticking recorder writes silence into the gaps, so the file's duration
// is wall-clock duration — which is also what makes `maxSilenceMs` mean anything at all, since a
// direction that has stopped sending is exactly the case it has to detect.
//
// The tick is also what makes `both` affordable. Two directions arriving on two goroutines are
// sampled onto one clock, decoded, summed and written once; the alignment error is bounded by one
// frame, which is inaudible in a recording and would be a defect in a live conference. That is the
// difference between this and rung 6's mixer, and it is why one is here and the other is not.
type Recording struct {
	opts    RecordingOptions
	session *Session
	writer  *audio.WAVWriter

	// received and sent are the two direction queues. Buffered channels rather than slots, so a
	// burst is absorbed rather than truncated — see recordingQueueFrames.
	received chan []byte
	sent     chan []byte

	// dropped counts frames that arrived with the queue full. Counted rather than silent: a
	// recording with a hole in it must be explicable afterwards.
	dropped atomic.Int64

	stopOnce sync.Once
	stop     chan struct{}
	stopWith atomic.Pointer[RecordingEndReason]
	done     chan struct{}

	finishOnce sync.Once
	summary    RecordingSummary
	// announceOnce makes the lifecycle announcement idempotent across the two paths that reach a
	// finished recording — the Manager's watcher, and a session teardown that waited for it. See
	// Manager.announceRecording.
	announceOnce sync.Once
}

// Ref is the engine-assigned reference this recording answers to.
func (r *Recording) Ref() string { return r.opts.Ref }

// ObjectKey is where the audio lands, relative to the recordings root.
func (r *Recording) ObjectKey() string { return r.opts.ObjectKey }

// Done is closed once the file is finalised and the summary is final.
func (r *Recording) Done() <-chan struct{} { return r.done }

// Summary is the finished recording's facts. Only meaningful once Done is closed.
func (r *Recording) Summary() RecordingSummary { return r.summary }

// Dropped is how many frames arrived while a direction's queue was full.
func (r *Recording) Dropped() int { return int(r.dropped.Load()) }

// Stop finalises the recording. Idempotent; a stop of a finished recording does nothing.
func (r *Recording) Stop() { r.stopFor(RecordingStopped) }

func (r *Recording) stopFor(reason RecordingEndReason) {
	r.stopOnce.Do(func() {
		r.stopWith.Store(&reason)
		close(r.stop)
	})
}

// Received queues one frame from the far end. Called on the session's read goroutine.
//
// The payload is COPIED, and that is not defensive: the read loop reuses one buffer for every
// packet, so a queued slice would be overwritten by the next arrival before the recorder woke up.
// The same holds for the send side, whose payload aliases the PEER's read buffer.
func (r *Recording) Received(payload []byte) { r.enqueue(r.received, payload) }

// Sent queues one frame written towards the far end. Ignored unless the direction is `both`.
func (r *Recording) Sent(payload []byte) {
	if r.opts.Direction != RecordBoth {
		return
	}
	r.enqueue(r.sent, payload)
}

func (r *Recording) enqueue(queue chan []byte, payload []byte) {
	if len(payload) == 0 {
		return
	}
	frame := make([]byte, len(payload))
	copy(frame, payload)
	select {
	case queue <- frame:
	default:
		// NON-BLOCKING, always. This runs on the packet path, and a recorder stalled on a full disk
		// must cost a hole in one file rather than back-pressure into the read loop of a live call.
		r.dropped.Add(1)
	}
}

// StartRecording begins writing this session's audio to a file.
//
// It returns once the file EXISTS and its header is written, never when the recording has finished.
// That ordering is what makes the command's reply meaningful: an `ok` means the first frame has
// somewhere to go, where a reply sent before the file was opened would let the opening moments of a
// recording be dropped on the floor and reported as success.
func (s *Session) StartRecording(opts RecordingOptions) (*Recording, error) {
	switch {
	case opts.Ref == "":
		return nil, errors.New("rtp: a recording reference is required")
	case opts.Path == "":
		return nil, errors.New("rtp: a recording path is required")
	}
	if opts.Direction == "" {
		opts.Direction = RecordBoth
	}
	if s.isClosed() {
		return nil, ErrUnknownSession
	}

	recording := &Recording{
		opts:     opts,
		session:  s,
		received: make(chan []byte, recordingQueueFrames),
		sent:     make(chan []byte, recordingQueueFrames),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}

	// Claimed BEFORE the file is opened, so two racing starts cannot both create a partial and one
	// of them silently lose its audio to the other's rename.
	if !s.recording.CompareAndSwap(nil, recording) {
		return nil, ErrAlreadyRecording
	}

	writer, err := audio.CreateWAV(opts.Path)
	if err != nil {
		s.recording.CompareAndSwap(recording, nil)
		return nil, err
	}
	recording.writer = writer

	go recording.run()
	return recording, nil
}

// StopRecording finalises the session's recording when it matches ref.
//
// Matching on the reference rather than stopping whatever is recording is the same fencing
// `StopPlayback` does: a stop that arrived late, after the recording it names finished and another
// started, must not truncate the new one.
func (s *Session) StopRecording(ref string) bool {
	recording := s.ActiveRecording()
	if recording == nil || recording.opts.Ref != ref {
		return false
	}
	recording.Stop()
	return true
}

// ActiveRecording is the recording in flight on this session, or nil.
func (s *Session) ActiveRecording() *Recording { return s.recording.Load() }

// run samples both directions onto one 20 ms clock until something ends the recording.
func (r *Recording) run() {
	defer close(r.done)
	defer r.session.recording.CompareAndSwap(r, nil)

	ticks, stopTicker := r.session.newTicker(audio.FrameDurationMs * time.Millisecond)
	defer stopTicker()

	maxFrames := framesIn(r.opts.MaxDuration)
	maxSilentFrames := framesIn(r.opts.MaxSilence)
	silentFrames := 0

	for {
		select {
		case <-r.stop:
			reason := RecordingStopped
			if requested := r.stopWith.Load(); requested != nil {
				reason = *requested
			}
			r.finish(reason)
			return
		case <-r.session.done:
			// The leg was released, reaped or drained under a live recording. The file is finalised
			// on the way down rather than abandoned, so a caller who hangs up mid-message leaves a
			// playable message instead of a partial nobody can open.
			r.finish(RecordingSessionEnded)
			return
		case <-ticks:
		}

		frame := r.mixOneFrame()
		if err := r.writer.WriteSamples(frame); err != nil {
			r.fail(err)
			return
		}

		if maxSilentFrames > 0 {
			if quiet(frame) {
				silentFrames++
				if silentFrames >= maxSilentFrames {
					r.finish(RecordingMaxSilence)
					return
				}
			} else {
				silentFrames = 0
			}
		}
		if maxFrames > 0 && r.writer.Samples() >= int64(maxFrames)*audio.FrameSamples {
			r.finish(RecordingMaxDuration)
			return
		}
	}
}

// mixOneFrame takes at most one frame from each direction and returns their sum.
//
// A direction with nothing waiting contributes SILENCE rather than being skipped, which is the
// whole reason the recorder ticks: a party who is not speaking is a party the recording has to
// represent with the right amount of nothing, or every word after their pause arrives early.
func (r *Recording) mixOneFrame() []int16 {
	mixed := make([]int16, audio.FrameSamples)

	select {
	case frame := <-r.received:
		audio.MixInto(mixed, audio.DecodeLinear(frame, r.opts.Encoding))
	default:
	}

	if r.opts.Direction == RecordBoth {
		select {
		case frame := <-r.sent:
			audio.MixInto(mixed, audio.DecodeLinear(frame, r.opts.Encoding))
		default:
		}
	}
	return mixed
}

// finish closes the file and records the outcome. Exactly once.
func (r *Recording) finish(reason RecordingEndReason) {
	r.finishOnce.Do(func() {
		durationMs := r.writer.DurationMs()
		bytes, err := r.writer.Close()
		if err != nil {
			// A recording that cannot be finalised has NO usable file — Close removes the partial
			// rather than leaving one the archive pipeline would copy — so the reason becomes
			// `error` whatever asked for the stop. Reporting `stopped` here would tell the engine a
			// file exists that does not.
			r.summary = RecordingSummary{
				Ref:       r.opts.Ref,
				ObjectKey: r.opts.ObjectKey,
				Direction: r.opts.Direction,
				Reason:    RecordingError,
				Detail:    err.Error(),
			}
			return
		}
		detail := ""
		if dropped := r.Dropped(); dropped > 0 {
			// Surfaced rather than buried in a counter nobody reads: a recording with gaps in it is
			// a recording somebody will play back and complain about, and this is the only place
			// that can say the gaps were the writer falling behind rather than the network.
			detail = "frames were dropped while a direction's queue was full"
			r.session.log.Warn("a recording dropped frames; the file has gaps in it",
				"recordingRef", r.opts.Ref, "dropped", dropped)
		}
		r.summary = RecordingSummary{
			Ref:        r.opts.Ref,
			ObjectKey:  r.opts.ObjectKey,
			Direction:  r.opts.Direction,
			Reason:     reason,
			DurationMs: durationMs,
			Bytes:      bytes,
			Detail:     detail,
		}
	})
}

// fail abandons the recording, removing the partial file.
func (r *Recording) fail(cause error) {
	r.finishOnce.Do(func() {
		_ = r.writer.Abort()
		r.session.log.Error("a recording failed; there is no file for this reference",
			"recordingRef", r.opts.Ref, "path", r.opts.Path, "error", cause)
		r.summary = RecordingSummary{
			Ref:       r.opts.Ref,
			ObjectKey: r.opts.ObjectKey,
			Direction: r.opts.Direction,
			Reason:    RecordingError,
			Detail:    cause.Error(),
		}
	})
}

// framesIn converts a duration to whole 20 ms frames, rounding up. Zero stays zero, meaning "no
// limit" rather than "stop immediately".
func framesIn(window time.Duration) int {
	if window <= 0 {
		return 0
	}
	frames := int((window.Milliseconds() + audio.FrameDurationMs - 1) / audio.FrameDurationMs)
	if frames < 1 {
		return 1
	}
	return frames
}

// quiet reports whether a frame's mean absolute amplitude is below the silence threshold.
//
// Mean absolute rather than peak, because a single click in an otherwise dead line would reset a
// silence timer that exists to notice a caller who has stopped speaking. It is a threshold on a
// buffer that has already been decoded for writing, not a signal-processing stage: the samples are
// in hand either way.
func quiet(samples []int16) bool {
	if len(samples) == 0 {
		return true
	}
	var total int64
	for _, sample := range samples {
		if sample < 0 {
			total -= int64(sample)
			continue
		}
		total += int64(sample)
	}
	return total/int64(len(samples)) < silenceThreshold
}
