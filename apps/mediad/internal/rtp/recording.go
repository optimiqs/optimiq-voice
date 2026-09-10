package rtp

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Writing a session's audio to a file.
//
// There is no snoop channel: a session already is both directions, so the direction is an argument
// on the command rather than a second object with its own lifecycle and port.

// RecordingDirection is which side of a session a recording captures.
type RecordingDirection string

// The two directions, matching the wire contract's `MEDIA_RECORDING_DIRECTIONS` exactly.
const (
	// RecordReceive captures only what the session receives: the far party speaking. What a
	// voicemail wants, and the mirror of ARI's `channels.record` on a plain channel.
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
	// RecordingMaxSilence is the caller having stopped talking. The normal end of a voicemail.
	RecordingMaxSilence RecordingEndReason = "max-silence"
	// RecordingSessionEnded is the leg going away underneath it — released, reaped or drained.
	// Still a complete file: the recorder finalises on the way down.
	RecordingSessionEnded RecordingEndReason = "session-ended"
	// RecordingError is a file that could not be written or finalised. There is no usable audio.
	RecordingError RecordingEndReason = "error"
)

// ErrAlreadyRecording is returned when a session already has a recording in flight. A refusal rather
// than a supersede — unlike playback — because superseding would throw away a file somebody is
// waiting on.
var ErrAlreadyRecording = errors.New("rtp: this session is already being recorded")

// recordingQueueFrames is how much jitter each direction's queue absorbs before it drops: half a
// second, since the recorder consumes on a 20 ms tick and the network delivers in bursts. Bounded,
// so a stalled writer costs one recording rather than the whole media plane's memory.
const recordingQueueFrames = 25

// silenceThreshold is the mean absolute sample below which a frame counts as quiet: ~1% of full
// scale. Above zero because G.711 silence is not zero, and low enough that a person speaking quietly
// is never mistaken for an open line.
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
	// TerminateOn is the set of DTMF digits that end the recording, or empty for none. The digits
	// are matched against the detector's output, so one keypress ends the message once however many
	// packets carried it.
	TerminateOn string
}

// RecordingPause is one stretch the recorder wrote silence for, against the file's own timeline.
// Milliseconds from the start of the file, `[StartMs, EndMs)`.
type RecordingPause struct {
	StartMs int
	EndMs   int
}

// RecordingSummary is a finished recording's facts, flattened for a Lifecycle implementation.
type RecordingSummary struct {
	Ref        string
	ObjectKey  string
	Direction  RecordingDirection
	Reason     RecordingEndReason
	DurationMs int
	Bytes      int64
	Pauses     []RecordingPause
	Detail     string
}

// Recording is one file being written from one session.
//
// It runs on its own 20 ms tick rather than writing on arrival, so the file's duration is wall-clock
// duration: an endpoint doing silence suppression sends nothing during a pause, and a write-on-
// arrival file would be short with every word after the pause early. It is also what makes
// `maxSilenceMs` mean anything, and what lets `both` sample two directions onto one clock with an
// alignment error bounded by one frame.
type Recording struct {
	opts    RecordingOptions
	session *Session
	writer  *audio.WAVWriter

	// received and sent are the two direction queues. Buffered channels rather than slots, so a
	// burst is absorbed rather than truncated — see recordingQueueFrames.
	received chan []byte
	sent     chan []byte

	// dropped counts frames that arrived with the queue full, so a hole in the file is explicable.
	dropped atomic.Int64

	// paused is read on the recorder's own tick and written by `pause-recording`. While it is set
	// the tick still runs and still writes a frame — silence — which is the whole difference from a
	// stop: one file, and the audio after the gap still sits at the offset it happened at.
	paused atomic.Bool
	// writtenMs is how much audio the file holds, in whole frames, published by the recorder for
	// the command path to read. The WAVWriter is the recorder goroutine's alone, so a pause that
	// asked IT for the offset would be a data race.
	writtenMs atomic.Int64

	// pauseMu guards the two fields below, which the command path appends to and the recorder reads
	// once, at finish. pauseStartMs is -1 when nothing is paused.
	pauseMu      sync.Mutex
	pauseStartMs int
	pauses       []RecordingPause

	stopOnce sync.Once
	stop     chan struct{}
	stopWith atomic.Pointer[RecordingEndReason]
	// terminator is the digit that ended the recording, when one did. Reported in `detail`.
	terminator atomic.Pointer[string]
	done       chan struct{}

	finishOnce sync.Once
	summary    RecordingSummary
	// announceOnce makes the lifecycle announcement idempotent across the two paths that reach a
	// finished recording: the Manager's watcher, and a session teardown that waited for it.
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

// Paused reports whether the recorder is currently writing silence.
func (r *Recording) Paused() bool { return r.paused.Load() }

// SetPaused pauses or resumes the capture WITHOUT ending the file, and reports the state after.
//
// Idempotent in both directions: pausing a paused recording, or resuming one that was never paused,
// changes nothing and is not an error. A pause is only ever closed here or at finish, so the
// intervals cannot overlap and cannot be left open on a finished artifact.
func (r *Recording) SetPaused(paused bool) bool {
	r.pauseMu.Lock()
	defer r.pauseMu.Unlock()

	if paused == r.paused.Load() {
		return paused
	}
	at := int(r.writtenMs.Load())
	if paused {
		r.pauseStartMs = at
	} else if r.pauseStartMs >= 0 {
		r.pauses = append(r.pauses, RecordingPause{StartMs: r.pauseStartMs, EndMs: at})
		r.pauseStartMs = -1
	}
	r.paused.Store(paused)
	return paused
}

// closePauses returns the intervals, closing an open one at the file's own duration. A pause still
// running when the recording ended has to be closed by something, and an open interval on a
// finished artifact says nothing to the person reading it.
func (r *Recording) closePauses(durationMs int) []RecordingPause {
	r.pauseMu.Lock()
	defer r.pauseMu.Unlock()

	if r.pauseStartMs >= 0 {
		r.pauses = append(r.pauses, RecordingPause{StartMs: r.pauseStartMs, EndMs: durationMs})
		r.pauseStartMs = -1
		r.paused.Store(false)
	}
	return r.pauses
}

// Stop finalises the recording. Idempotent; a stop of a finished recording does nothing.
func (r *Recording) Stop() { r.stopFor(RecordingStopped) }

// terminateOn ends the recording when a detected digit is in its terminator set.
//
// It reports whether it matched. The reason on the wire is `stopped` rather than a sixth
// `MediaRecordingFinishedReason`; which digit ended it goes in `detail`.
func (r *Recording) terminateOn(digit string) bool {
	if r.opts.TerminateOn == "" || !strings.Contains(r.opts.TerminateOn, digit) {
		return false
	}
	r.terminator.Store(&digit)
	r.stopFor(RecordingStopped)
	return true
}

func (r *Recording) stopFor(reason RecordingEndReason) {
	r.stopOnce.Do(func() {
		r.stopWith.Store(&reason)
		close(r.stop)
	})
}

// Received queues one frame from the far end. Called on the session's read goroutine.
//
// The payload is copied because the read loop reuses one buffer per packet, so a queued slice would
// be overwritten before the recorder woke up. The same holds for the send side.
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
		// Never blocking: this runs on the packet path, and a recorder stalled on a full disk must
		// cost a hole in one file rather than back-pressure into a live call's read loop.
		r.dropped.Add(1)
	}
}

// StartRecording begins writing this session's audio to a file.
//
// It returns once the file exists and its header is written, not when the recording has finished, so
// a successful reply means the first frame has somewhere to go.
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

		pauseStartMs: -1,
	}

	// Claimed before the file is opened, so two racing starts cannot both create a partial.
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
// Matching on the reference fences a late stop: one that arrives after the recording it names
// finished and another started must not truncate the new one.
func (s *Session) StopRecording(ref string) bool {
	recording := s.ActiveRecording()
	if recording == nil || recording.opts.Ref != ref {
		return false
	}
	recording.Stop()
	return true
}

// PauseRecording pauses or resumes the session's recording when it matches ref, reporting whether
// there was one to act on and the paused state after. Fenced on the reference exactly as
// StopRecording is, for the same reason: a late pause must not silence a recording it does not name.
func (s *Session) PauseRecording(ref string, paused bool) (bool, bool) {
	recording := s.ActiveRecording()
	if recording == nil || recording.opts.Ref != ref {
		return false, false
	}
	return true, recording.SetPaused(paused)
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
			// The leg went away under a live recording. The file is finalised on the way down, so a
			// caller who hangs up mid-message leaves a playable message.
			r.finish(RecordingSessionEnded)
			return
		case <-ticks:
		}

		frame := r.mixOneFrame()
		if err := r.writer.WriteSamples(frame); err != nil {
			r.fail(err)
			return
		}
		r.writtenMs.Add(audio.FrameDurationMs)

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

// mixOneFrame takes at most one frame from each direction and returns their sum. A direction with
// nothing waiting contributes silence rather than being skipped, or every word after a pause would
// arrive early.
func (r *Recording) mixOneFrame() []int16 {
	mixed := make([]int16, audio.FrameSamples)

	if r.paused.Load() {
		// Still consuming one frame per direction, so the queues drain at the rate they fill: a
		// pause that let them back up would replay the silenced audio the moment it lifted, which
		// is precisely the card number the pause exists to keep out of the file.
		r.discardOneFrame()
		return mixed
	}

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

// discardOneFrame drops at most one frame from each direction the recording captures.
func (r *Recording) discardOneFrame() {
	select {
	case <-r.received:
	default:
	}
	if r.opts.Direction == RecordBoth {
		select {
		case <-r.sent:
		default:
		}
	}
}

// finish closes the file and records the outcome. Exactly once.
func (r *Recording) finish(reason RecordingEndReason) {
	r.finishOnce.Do(func() {
		durationMs := r.writer.DurationMs()
		bytes, err := r.writer.Close()
		if err != nil {
			// A recording that cannot be finalised has no usable file — Close removes the partial —
			// so the reason becomes `error` whatever asked for the stop.
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
		if digit := r.terminator.Load(); digit != nil {
			detail = "terminated on " + *digit
		}
		if dropped := r.Dropped(); dropped > 0 {
			// Surfaced in `detail`: this is the only place that can say the gaps were the writer
			// falling behind rather than the network.
			if detail != "" {
				// Appended, not replaced: a recording both terminated by a digit and short of
				// frames has to report both.
				detail += "; "
			}
			detail += "frames were dropped while a direction's queue was full"
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
			Pauses:     r.closePauses(durationMs),
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
	return max(frames, 1)
}

// quiet reports whether a frame's mean absolute amplitude is below the silence threshold. Mean
// absolute rather than peak, so a single click in an otherwise dead line does not reset the timer.
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
