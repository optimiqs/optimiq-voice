package rtp

import (
	"sync"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// The jitter buffer, and the ONE place in this service that is allowed to have one.
//
// plans/mediad-design.md §6.3 states the rule this file has to live inside, and it is worth
// restating because it is the opposite of what a naive media server does:
//
//	Rungs 2-5 are RELAY paths. Packets are forwarded, not decoded. A jitter buffer on a relay adds
//	latency to fix jitter the receiving endpoint's OWN buffer is already going to fix — every SIP
//	phone has one — and two buffers in series make the call worse.
//
//	Rung 6 is where one becomes MANDATORY: a mixer must align frames from N sources on a common
//	clock, and without a buffer the mix is garbage.
//
// So this buffer is reachable only from a conference MEMBER. A bridged call never constructs one,
// and that is asserted by the suite rather than left to a reviewer to notice.
//
// # What "garbage" means, concretely
//
// A mixer takes one frame per participant per 20 ms tick. Without a buffer, "the frame that has
// arrived" is whatever the network happened to deliver in the last 20 ms: sometimes two frames
// (one is dropped or the mix runs fast), sometimes none (a hole), and reordered pairs come out
// backwards. Each of those is a discontinuity in ONE participant's audio that every OTHER
// participant hears, because they are all listening to the same sum. That is why a conference is
// the rung where a buffer stops being harmful and starts being the difference between a room that
// works and one nobody will use.

// The depth bounds, in 20 ms frames, and the reasoning for each number.
const (
	// jitterMinFrames is the floor: two frames, 40 ms.
	//
	// One frame is not a buffer at all — it is a slot, and a single packet arriving 1 ms late
	// underruns it. Two is the smallest depth that can absorb one frame of network variation, which
	// is the variation a LAN actually produces. Going below this to save latency would mean a
	// conference that sounds broken on a perfect network.
	jitterMinFrames = 2

	// jitterStartFrames is where a new member starts: three frames, 60 ms.
	//
	// Between the floor and a typical WAN's requirement, so a well-connected participant converges
	// DOWN to the floor within a couple of seconds and a poorly-connected one converges UP without
	// the first two seconds of the call being audibly broken. Starting at the floor would make every
	// remote participant's join sound bad; starting at the ceiling would put 200 ms of latency on
	// every LAN participant for the same two seconds.
	jitterStartFrames = 3

	// jitterMaxFrames is the ceiling: ten frames, 200 ms.
	//
	// A BOUND rather than a target, and it is chosen against a human constraint rather than a
	// network one. ITU-T G.114 puts the limit of comfortable interactive conversation at about
	// 150 ms of one-way mouth-to-ear delay and the limit of usability at 400 ms; the mixer's own
	// buffer is only one contributor to that budget, alongside two endpoint buffers and the network
	// itself. Past 200 ms here, adding depth stops buying intelligibility and starts buying the
	// experience where two people talk over each other because neither can tell the other has
	// started. A network that needs more than this is one where the honest answer is that the
	// conference will have gaps, and the gaps are counted (see JitterStats.Lost) so somebody can
	// see that rather than guess.
	jitterMaxFrames = 10
)

// jitterShrinkTicks is how many consecutive comfortable ticks it takes to give a frame back.
//
// ASYMMETRIC adaptation, deliberately: depth is added IMMEDIATELY on an underrun and released only
// after two seconds of not needing it. That asymmetry is the whole of the policy, and it is the
// right way round because the two mistakes are not equally bad — being one frame too shallow is an
// audible gap in everybody's audio right now, and being one frame too deep is 20 ms of latency
// nobody can perceive. A symmetric controller would oscillate around the threshold and produce a
// gap every time it guessed low.
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
	// Late counts packets that arrived after their slot had already been played out. Distinct from
	// Lost because they are the same event seen from the two ends — one says "there was a hole", the
	// other says "the thing that should have filled it turned up afterwards" — and the ratio is what
	// says whether the buffer is too shallow or the network is actually dropping packets.
	Late uint64
	// Reordered counts packets that arrived out of sequence and were still played in order. The
	// buffer's whole reason for existing, and the number that says it is earning its latency.
	Reordered uint64
	// Overflowed counts packets discarded because the buffer was already full at its ceiling —
	// a sender running fast, or a mixer tick that stalled.
	Overflowed uint64
	// DepthFrames is the current target depth.
	DepthFrames int
	// MaxDepthFrames is the deepest the buffer ever had to go.
	MaxDepthFrames int
}

// JitterBuffer reorders one inbound stream onto the mixer's clock.
//
// One per conference member per direction, and it holds RAW payloads rather than decoded samples:
// decoding happens once, at playout, on the mixer's goroutine. Decoding at arrival would move the
// codec's work onto the read loop and — for a stateful codec like G.722 — would decode packets in
// ARRIVAL order, which is exactly the order the buffer exists to correct.
type JitterBuffer struct {
	mu sync.Mutex

	// pending holds payloads by sequence number. A map rather than a ring because the interesting
	// operations are "is sequence N here" and "drop everything before N", and a ring sized for the
	// ceiling would have to handle a sequence space that wraps at 65536 anyway.
	pending map[uint16][]byte

	// next is the sequence number the next Pop will play out.
	next uint16
	// primed is false until enough frames have arrived to start; see Pop.
	primed bool
	// started is false until the first Pop actually delivered something.
	started bool

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

// Push accepts one arrived packet.
//
// The payload is COPIED, and not defensively: the session's read loop reuses one buffer for every
// packet, so a payload held past the call would be overwritten by the next arrival — the same reason
// the recorder copies.
func (j *JitterBuffer) Push(sequence uint16, timestamp uint32, payload []byte, arrived time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.stats.Pushed++
	j.estimator.observe(timestamp, arrived, j.clockRate)

	if j.started && !sequenceAfterOrEqual(sequence, j.next) {
		// Its slot has already been played out. There is nothing useful to do with it — inserting it
		// would either play it out of order or require rewinding a mix that has already been sent —
		// so it is counted as the evidence it is: the buffer was too shallow for this network, or
		// this packet took a path the rest did not.
		j.stats.Late++
		j.adaptOnLateLocked()
		return
	}

	if _, duplicate := j.pending[sequence]; duplicate {
		// A retransmission or a duplicated datagram. Dropped silently rather than counted as loss:
		// nothing is missing and nothing is late.
		return
	}
	if len(j.pending) >= jitterMaxFrames*2 {
		// The ceiling, doubled — the buffer holds more than it plays out from so that a burst is
		// absorbed rather than truncated, but not without limit. A sender that is genuinely faster
		// than the mixer's clock (a broken endpoint, or clock drift over a long call) would otherwise
		// grow this map until the process died.
		j.stats.Overflowed++
		return
	}

	if !j.primed {
		if len(j.pending) == 0 {
			j.next = sequence
		} else if !sequenceAfterOrEqual(sequence, j.next) {
			// Still filling, and something older than what we planned to start from arrived. Start
			// from IT instead: nothing has been played yet, so there is no ordering to violate, and
			// the alternative is discarding the first packet of the call.
			j.next = sequence
		}
	}

	if sequence != j.next {
		j.stats.Reordered++
	}
	frame := make([]byte, len(payload))
	copy(frame, payload)
	j.pending[sequence] = frame

	if !j.primed && len(j.pending) >= j.target {
		j.primed = true
	}
}

// Pop takes the next frame for the mixer's tick, or reports that there is nothing to play.
//
// A `false` is SILENCE for this participant on this tick, which is what the mixer contributes for
// them. It is deliberately not "reuse the last frame": repeating a 20 ms frame produces a buzz at
// 50 Hz that every other participant hears, and packet-loss concealment that sounds better than
// silence is a real technique with a real cost and belongs behind its own decision rather than as a
// side effect of a buffer's control flow.
func (j *JitterBuffer) Pop() ([]byte, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()

	if !j.primed {
		// Still filling. Not an underrun and not counted as loss: nobody has been promised audio yet,
		// which is the difference between a member who has just joined and one whose network fell over.
		return nil, false
	}

	frame, ok := j.pending[j.next]
	if !ok {
		// The slot is empty at playout time. THIS is the number a participant hears.
		j.stats.Lost++
		j.next++
		j.adaptOnLossLocked()
		if len(j.pending) == 0 {
			// Everything has drained. Re-prime rather than keep stepping the sequence forward through
			// nothing, so a member whose network came back does not have to wait for the counter to
			// catch up to their new packets.
			j.primed = false
			j.started = false
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

// Depth is how many frames are waiting. Exported for the diagnostics and for the suite.
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

// adaptOnLossLocked deepens the buffer, immediately.
//
// One frame at a time rather than a jump to the measured jitter, because a single lost packet is not
// evidence of a worse network — it is evidence of ONE lost packet, and a buffer that jumped to the
// ceiling on the first one would put 200 ms on a conference because a switch hiccupped.
func (j *JitterBuffer) adaptOnLossLocked() {
	j.comfort = 0
	if j.target < jitterMaxFrames {
		j.target++
		if j.target > j.stats.MaxDepthFrames {
			j.stats.MaxDepthFrames = j.target
		}
	}
}

// adaptOnLateLocked deepens the buffer when a packet arrived after its slot.
//
// The measurement that says the depth was WRONG rather than that the network dropped something, so
// it is the strongest signal available — and it is still one frame at a time, for the same reason.
func (j *JitterBuffer) adaptOnLateLocked() { j.adaptOnLossLocked() }

// comfortTickLocked counts a tick that needed no help, and gives a frame back after enough of them.
//
// The estimator is consulted here rather than driving the depth directly: the measured arrival
// jitter is what says how shallow the buffer is ALLOWED to get, and the tick counter is what stops
// it moving on every frame. A buffer whose depth tracked a jitter estimate sample by sample would
// change the playout delay continuously, which is heard as a wobble in pitch.
func (j *JitterBuffer) comfortTickLocked() {
	j.comfort++
	if j.comfort < jitterShrinkTicks {
		return
	}
	j.comfort = 0

	floor := jitterMinFrames
	// Two standard deviations of measured arrival jitter, expressed in frames and rounded up, plus
	// one frame of slack. RFC 3550's estimator is a smoothed mean deviation, so twice it is the
	// conventional stand-in for a confidence bound on a distribution nobody has measured the shape
	// of — the same rule every published adaptive playout controller uses.
	if needed := int(2*j.estimator.jitterMs(j.clockRate))/audio.FrameDurationMs + 1; needed > floor {
		floor = needed
	}
	if floor > jitterMaxFrames {
		floor = jitterMaxFrames
	}
	if j.target > floor {
		j.target--
	}
}

// sequenceAfterOrEqual compares two RTP sequence numbers across the 16-bit wrap.
//
// Subtraction in the unsigned domain and a signed reinterpretation, which is the standard trick and
// the only correct one: a call lasting twenty-two minutes at 50 packets a second wraps the sequence
// space, and a naive `a >= b` would declare every packet after the wrap ancient and discard the rest
// of the conference.
func sequenceAfterOrEqual(a, b uint16) bool { return int16(a-b) >= 0 }

// jitterEstimator is RFC 3550 §6.4.1's interarrival jitter, J.
//
// One implementation used by two callers — the adaptive buffer above, and the RTCP receiver report
// in rtcp.go — because they must not be able to disagree about what this leg's jitter is. It is a
// smoothed mean deviation of the difference between packet spacing at the sender and at the
// receiver, in TIMESTAMP units, which is why every caller has to hand it the clock rate.
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

	// The difference of differences, D(i-1,i), in timestamp units. Signed: reordered packets and
	// silence-suppression gaps both produce negative values and the absolute value is what counts.
	arrivalTicks := int64(arrived.Sub(e.lastArrival).Seconds() * float64(clockRate))
	sentTicks := int64(int32(timestamp - e.lastTS))
	deviation := arrivalTicks - sentTicks
	if deviation < 0 {
		deviation = -deviation
	}

	// J += (|D| - J)/16, the RFC's own gain. 1/16 is a first-order filter with a time constant of
	// about sixteen packets — a third of a second at 20 ms — which tracks a network that has changed
	// without reacting to a network that has hiccupped.
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

// jitterMs is J in milliseconds, which is what a human reads and what the buffer's depth policy
// works in.
func (e *jitterEstimator) jitterMs(clockRate uint32) float64 {
	if clockRate == 0 {
		return 0
	}
	return e.jitter * 1000 / float64(clockRate)
}
