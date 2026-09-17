package rtp

import (
	"sync"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// A jitter buffer belongs only on the mixing path: on a relay it adds latency to fix jitter the
// receiving endpoint's own buffer already fixes, and two buffers in series make the call worse. A
// mixer must align frames from N sources on a common clock, so there it is mandatory.

// The depth bounds, in 20 ms frames.
const (
	// jitterMinFrames is the floor: two frames, 40 ms — the smallest depth that can absorb one
	// frame of network variation.
	jitterMinFrames = 2

	// jitterStartFrames is where a new member starts: three frames, 60 ms, between the floor and a
	// typical WAN's requirement so convergence in either direction is not audible.
	jitterStartFrames = 3

	// jitterMaxFrames is the ceiling: ten frames, 200 ms. A bound chosen against ITU-T G.114's
	// 150 ms comfortable / 400 ms usable one-way delay budget, of which this buffer is one part.
	jitterMaxFrames = 10
)

// jitterShrinkTicks is how many consecutive comfortable ticks it takes to give a frame back.
//
// Adaptation is deliberately asymmetric: depth is added immediately on an underrun and released
// only after two seconds. Being a frame too shallow is an audible gap; a frame too deep is 20 ms
// nobody perceives. A symmetric controller would oscillate and gap every time it guessed low.
const jitterShrinkTicks = 100

// JitterStats is what a buffer did, for the leg's diagnostics and for a test to assert on.
type JitterStats struct {
	// Pushed is every packet handed in, including the ones that were dropped below.
	Pushed uint64
	// Popped is the frames the mixer actually consumed.
	Popped uint64
	// Lost counts playout slots with no packet: a frame that never arrived, or arrived too late to
	// use. The number a participant HEARS as a gap.
	Lost uint64
	// Late counts packets that arrived after their slot had been played out. Its ratio to Lost says
	// whether the buffer is too shallow or the network is genuinely dropping packets.
	Late uint64
	// Reordered counts packets that arrived BEHIND a sequence already seen and were still played in
	// order. Measured against arrival order, not against the playout cursor: a packet ahead of the
	// cursor is the ordinary case, not a reordering.
	Reordered uint64
	// Overflowed counts packets discarded because the buffer was already full at its ceiling —
	// a sender running fast, or a mixer tick that stalled.
	Overflowed uint64
	// Resynced counts the times playout jumped to the oldest buffered frame. See resyncLocked.
	Resynced uint64
	// Stretched counts playout ticks held back to grow the buffer to a deepened target, and Shrunk
	// counts frames skipped to give depth back. Together they are how a target change reaches live
	// playout rather than only a later re-prime.
	Stretched uint64
	Shrunk    uint64
	// DepthFrames is the current target depth.
	DepthFrames int
	// MaxDepthFrames is the deepest the buffer ever had to go.
	MaxDepthFrames int
}

// JitterBuffer reorders one inbound stream onto the mixer's clock, one per conference member per
// direction. It holds RAW payloads: decoding happens at playout on the mixer's goroutine, because a
// stateful codec decoded at arrival would run in the arrival order this buffer exists to correct.
type JitterBuffer struct {
	mu sync.Mutex

	// pending holds payloads by sequence number.
	pending map[uint16][]byte

	// next is the sequence number the next Pop will play out.
	next uint16
	// primed is false until enough frames have arrived to start; see Pop.
	primed bool
	// started is false until the first Pop actually delivered something.
	started bool

	// highest is the highest sequence yet PUSHED, tracked separately from the playout cursor so
	// arrival order and playout order cannot be confused. Valid once seen is true.
	highest uint16
	seen    bool

	// grow and shrink are the frames playout still owes the target: a deepened target holds a tick
	// back, a released one skips a frame. Both are bounded by the depth bounds.
	grow   int
	shrink int

	// free is the frame free list: buffers Recycle handed back after the mixer decoded them. Bounded
	// by the same ceiling as pending, so a stalled room cannot grow it.
	free [][]byte

	target    int
	comfort   int
	estimator jitterEstimator
	clockRate uint32

	stats JitterStats
}

// NewJitterBuffer builds a buffer at the starting depth.
func NewJitterBuffer(clockRate uint32) *JitterBuffer {
	if clockRate == 0 {
		clockRate = audio.SampleRate
	}
	return &JitterBuffer{
		pending:   make(map[uint16][]byte, jitterMaxFrames*2),
		target:    jitterStartFrames,
		clockRate: clockRate,
		stats:     JitterStats{DepthFrames: jitterStartFrames, MaxDepthFrames: jitterStartFrames},
	}
}

// Push accepts one arrived packet. The payload MUST be copied: the session's read loop reuses one
// buffer per packet, so a retained payload would be overwritten by the next arrival.
func (j *JitterBuffer) Push(sequence uint16, timestamp uint32, payload []byte, arrived time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.stats.Pushed++
	j.estimator.observe(timestamp, arrived, j.clockRate)

	if j.started && !sequenceAfterOrEqual(sequence, j.next) {
		// Its slot has already been played out; inserting it would play it out of order.
		j.stats.Late++
		j.adaptOnLateLocked()
		return
	}

	if _, duplicate := j.pending[sequence]; duplicate {
		// A retransmission or duplicated datagram: nothing is missing and nothing is late.
		return
	}
	if len(j.pending) >= jitterMaxFrames*2 {
		// The ceiling doubled, so a burst is absorbed rather than truncated but a sender faster than
		// the mixer's clock cannot grow this map without bound.
		j.stats.Overflowed++
		return
	}

	if !j.primed {
		if len(j.pending) == 0 {
			j.next = sequence
		} else if !sequenceAfterOrEqual(sequence, j.next) {
			// Still filling: nothing has been played, so starting from the older packet violates no
			// ordering and avoids discarding the first packet of the call.
			j.next = sequence
		}
	}

	if !j.seen || sequenceAfterOrEqual(sequence, j.highest) {
		j.highest, j.seen = sequence, true
	} else {
		j.stats.Reordered++
	}
	frame := j.takeFrameLocked(len(payload))
	copy(frame, payload)
	j.pending[sequence] = frame

	if !j.primed && len(j.pending) >= j.target {
		j.primed = true
	}
}

// takeFrameLocked hands back a payload-sized buffer, reusing a recycled one when it fits.
func (j *JitterBuffer) takeFrameLocked(size int) []byte {
	if last := len(j.free) - 1; last >= 0 {
		frame := j.free[last]
		j.free = j.free[:last]
		if cap(frame) >= size {
			return frame[:size]
		}
	}
	return make([]byte, size)
}

// Recycle gives a frame that Pop returned back to the buffer. The caller MUST be finished reading
// it — the next arrival copies into it — and must not recycle a frame referenced elsewhere.
func (j *JitterBuffer) Recycle(frame []byte) {
	if cap(frame) == 0 {
		return
	}
	j.mu.Lock()
	j.recycleLocked(frame)
	j.mu.Unlock()
}

func (j *JitterBuffer) recycleLocked(frame []byte) {
	if cap(frame) == 0 {
		return
	}
	if len(j.free) < jitterMaxFrames*2 {
		j.free = append(j.free, frame[:cap(frame)])
	}
}

// Pop takes the next frame for the mixer's tick. A false means silence for this participant on this
// tick, deliberately not a repeat of the last frame — that would buzz at 50 Hz for everyone.
func (j *JitterBuffer) Pop() ([]byte, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()

	if !j.primed {
		// Still filling: not an underrun, so not counted as loss.
		return nil, false
	}

	if j.shrink > 0 && len(j.pending) > j.target {
		// Giving depth back: one frame is skipped so playout catches up to the shallower target.
		j.shrink--
		if frame, buffered := j.pending[j.next]; buffered {
			delete(j.pending, j.next)
			j.recycleLocked(frame)
		}
		j.next++
		j.stats.Shrunk++
	} else if j.grow > 0 && len(j.pending) > 0 {
		// Taking depth: this tick is silence, which is what puts the extra frame between arrival and
		// playout. Not an underrun, so not counted as loss.
		j.grow--
		j.stats.Stretched++
		return nil, false
	}

	frame, ok := j.pending[j.next]
	if !ok {
		j.stats.Lost++
		j.next++
		j.adaptOnLossLocked()
		if len(j.pending) == 0 {
			// Everything has drained. Re-prime so a member whose network came back does not wait for
			// the sequence counter to walk up to their new packets.
			j.primed = false
			j.started = false
		} else {
			j.resyncLocked()
		}
		return nil, false
	}

	delete(j.pending, j.next)
	j.next++
	j.started = true
	j.stats.Popped++
	j.comfortTickLocked()
	return frame, true
}

// resyncLocked jumps playout to the oldest buffered frame when the gap to it is too wide to walk.
//
// After a sequence discontinuity (a re-INVITE, an endpoint that jumps) the buffer never drains, so
// next would step towards the new sequence one frame per 20 ms tick — a thousand-sequence gap is
// twenty seconds of silence. Gaps within the ceiling are still walked: that is ordinary loss.
func (j *JitterBuffer) resyncLocked() {
	nearest, distance := uint16(0), 0
	first := true
	for sequence := range j.pending {
		// Push refuses anything older than next, so the unsigned difference is the real distance.
		gap := int(sequence - j.next)
		if first || gap < distance {
			nearest, distance, first = sequence, gap, false
		}
	}
	if first || distance <= jitterMaxFrames*2 {
		return
	}
	j.next = nearest
	j.stats.Resynced++
}

// Depth is how many frames are waiting.
func (j *JitterBuffer) Depth() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return len(j.pending)
}

// Target is the current adaptive depth, in frames.
func (j *JitterBuffer) Target() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.target
}

// Stats copies the counters out.
func (j *JitterBuffer) Stats() JitterStats {
	j.mu.Lock()
	defer j.mu.Unlock()
	stats := j.stats
	stats.DepthFrames = j.target
	return stats
}

// deepenLocked adds one frame of target depth: a single lost packet is not evidence of a worse
// network, and jumping to the ceiling would cost 200 ms over one hiccup.
//
// applyToPlayout asks for the extra frame to be taken from live playout, by holding one tick back.
func (j *JitterBuffer) deepenLocked(applyToPlayout bool) {
	j.comfort = 0
	if j.target >= jitterMaxFrames {
		return
	}
	j.target++
	if j.target > j.stats.MaxDepthFrames {
		j.stats.MaxDepthFrames = j.target
	}
	if applyToPlayout && j.started {
		j.grow++
	}
}

// adaptOnLossLocked deepens the buffer after an underrun. The missed tick IS the extra frame of
// delay, so playout owes nothing further.
func (j *JitterBuffer) adaptOnLossLocked() { j.deepenLocked(false) }

// adaptOnLateLocked deepens the buffer when a packet arrived after its slot — the signal that the
// depth was wrong rather than that the network dropped something. Playout was not interrupted, so
// the extra frame has to be taken from it.
func (j *JitterBuffer) adaptOnLateLocked() { j.deepenLocked(true) }

// comfortTickLocked counts a tick that needed no help, and gives a frame back after enough of them.
// The estimator sets the floor rather than driving the depth directly: a depth that tracked the
// estimate sample by sample would move the playout delay continuously, heard as a pitch wobble.
func (j *JitterBuffer) comfortTickLocked() {
	j.comfort++
	if j.comfort < jitterShrinkTicks {
		return
	}
	j.comfort = 0

	floor := jitterMinFrames
	// Twice the measured arrival jitter in frames, plus a frame of slack — the conventional bound
	// for RFC 3550's smoothed mean deviation.
	if needed := int(2*j.estimator.jitterMs(j.clockRate))/audio.FrameDurationMs + 1; needed > floor {
		floor = needed
	}
	if floor > jitterMaxFrames {
		floor = jitterMaxFrames
	}
	if j.target > floor {
		j.target--
		if j.started {
			j.shrink++
		}
	}
}

// sequenceAfterOrEqual compares two RTP sequence numbers across the 16-bit wrap. A call of about
// twenty-two minutes wraps the sequence space, where a naive a >= b would discard everything after.
func sequenceAfterOrEqual(a, b uint16) bool { return int16(a-b) >= 0 }

// jitterEstimator is RFC 3550 §6.4.1's interarrival jitter J: a smoothed mean deviation of sender
// versus receiver packet spacing, in TIMESTAMP units, so every caller must supply the clock rate.
// Shared by the buffer above and rtcp.go so the two cannot disagree about a leg's jitter.
type jitterEstimator struct {
	jitter      float64
	lastTS      uint32
	lastArrival time.Time
	primed      bool
}

func (e *jitterEstimator) observe(timestamp uint32, arrived time.Time, clockRate uint32) {
	if !e.primed {
		e.lastTS, e.lastArrival, e.primed = timestamp, arrived, true
		return
	}

	// D(i-1,i) in timestamp units. Signed: reordering and silence-suppression gaps both go negative.
	arrivalTicks := int64(arrived.Sub(e.lastArrival).Seconds() * float64(clockRate))
	sentTicks := int64(int32(timestamp - e.lastTS))
	deviation := arrivalTicks - sentTicks
	if deviation < 0 {
		deviation = -deviation
	}

	// J += (|D| - J)/16, the RFC's own gain: a first-order filter over about sixteen packets.
	e.jitter += (float64(deviation) - e.jitter) / 16
	e.lastTS, e.lastArrival = timestamp, arrived
}

// jitterTicks is J in RTP timestamp units, which is what an RTCP receiver report carries.
func (e *jitterEstimator) jitterTicks() uint32 {
	if e.jitter < 0 {
		return 0
	}
	return uint32(e.jitter)
}

// jitterMs is J in milliseconds, the unit the buffer's depth policy works in.
func (e *jitterEstimator) jitterMs(clockRate uint32) float64 {
	if clockRate == 0 {
		return 0
	}
	return e.jitter * 1000 / float64(clockRate)
}
