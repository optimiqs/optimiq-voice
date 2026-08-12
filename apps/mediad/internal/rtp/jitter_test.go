package rtp_test

import (
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The jitter buffer suite drives Push and Pop directly, with no sockets and no clock.
//
// That is the whole reason the buffer takes an arrival TIME rather than reading one: every property
// worth asserting here — reordering, loss, lateness, depth adaptation, sequence wrap — is a function
// of the order things arrive in, and a test that had to produce those orders by racing real packets
// would assert them by luck.

// jitterFrame builds a payload whose first byte identifies the sequence it belongs to, so an
// out-of-order delivery is visible in the DATA rather than only in a counter.
func jitterFrame(sequence uint16) []byte {
	return []byte{byte(sequence), 0x55, 0x55}
}

// pushRun feeds a contiguous run of frames.
func pushRun(buffer *rtp.JitterBuffer, from uint16, count int, at time.Time) time.Time {
	for index := 0; index < count; index++ {
		sequence := from + uint16(index)
		buffer.Push(sequence, uint32(sequence)*audio.FrameTimestampStep, jitterFrame(sequence), at)
		at = at.Add(audio.FrameDurationMs * time.Millisecond)
	}
	return at
}

func TestJitterBufferPrimesBeforeItPlays(t *testing.T) {
	t.Parallel()

	// A buffer that played its first frame the instant one arrived would have no depth at all, which
	// is the state it exists to leave. Until it has primed, a Pop is SILENCE and is not counted as
	// loss: nobody has been promised audio yet, which is the difference between a participant who has
	// just joined and one whose network fell over.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	if _, ok := buffer.Pop(); ok {
		t.Fatal("an empty buffer played a frame")
	}
	if stats := buffer.Stats(); stats.Lost != 0 {
		t.Errorf("Lost = %d before priming; a buffer that has not started cannot have lost anything",
			stats.Lost)
	}

	pushRun(buffer, 100, 2, now)
	if _, ok := buffer.Pop(); ok {
		t.Error("the buffer started at a depth of two when its target is three")
	}

	pushRun(buffer, 102, 1, now)
	frame, ok := buffer.Pop()
	if !ok {
		t.Fatal("the buffer did not start once it reached its target depth")
	}
	if frame[0] != 100 {
		t.Errorf("played sequence %d first, want 100", frame[0])
	}
}

func TestJitterBufferPlaysReorderedPacketsInOrder(t *testing.T) {
	t.Parallel()

	// The buffer's whole reason for existing. Three frames arrive as 3, 1, 2 — which is what a
	// network with two paths produces routinely — and all three must play as 1, 2, 3.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	for _, sequence := range []uint16{3, 1, 2} {
		buffer.Push(sequence, uint32(sequence)*audio.FrameTimestampStep, jitterFrame(sequence), now)
		now = now.Add(audio.FrameDurationMs * time.Millisecond)
	}

	for _, want := range []byte{1, 2, 3} {
		frame, ok := buffer.Pop()
		if !ok {
			t.Fatalf("no frame where sequence %d should have been", want)
		}
		if frame[0] != want {
			t.Fatalf("played sequence %d, want %d: the buffer did not reorder", frame[0], want)
		}
	}
	if stats := buffer.Stats(); stats.Reordered == 0 {
		t.Error("Reordered = 0 after an out-of-order arrival; the counter that justifies the latency " +
			"is not moving")
	}
}

func TestJitterBufferReportsAHoleAsLossRatherThanSkippingIt(t *testing.T) {
	t.Parallel()

	// A missing frame is SILENCE at its own slot and the following frames keep their places. The
	// alternative — playing the next arrival early — shortens everybody's audio by 20 ms per lost
	// packet, which is a mixer that drifts steadily ahead of the conversation.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	for _, sequence := range []uint16{1, 2, 4, 5} {
		buffer.Push(sequence, uint32(sequence)*audio.FrameTimestampStep, jitterFrame(sequence), now)
		now = now.Add(audio.FrameDurationMs * time.Millisecond)
	}

	got := []int{}
	for tick := 0; tick < 5; tick++ {
		if frame, ok := buffer.Pop(); ok {
			got = append(got, int(frame[0]))
		} else {
			got = append(got, -1)
		}
	}

	want := []int{1, 2, -1, 4, 5}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("playout = %v, want %v (-1 is silence at the lost frame's own slot)", got, want)
		}
	}
	if stats := buffer.Stats(); stats.Lost != 1 {
		t.Errorf("Lost = %d, want 1", stats.Lost)
	}
}

func TestJitterBufferCountsAndDiscardsLatePackets(t *testing.T) {
	t.Parallel()

	// A packet whose slot has already been played cannot be used: inserting it would either play it
	// out of order or require rewinding a mix that has already been sent. `Late` and `Lost` are the
	// same event seen from two ends, and the RATIO is what says whether the buffer is too shallow or
	// the network is genuinely dropping packets — which need opposite responses.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	pushRun(buffer, 1, 4, now)
	for tick := 0; tick < 4; tick++ {
		buffer.Pop()
	}

	buffer.Push(2, 2*audio.FrameTimestampStep, jitterFrame(2), now.Add(time.Second))
	stats := buffer.Stats()
	if stats.Late != 1 {
		t.Errorf("Late = %d, want 1", stats.Late)
	}
	if frame, ok := buffer.Pop(); ok {
		t.Errorf("the buffer replayed a late packet as sequence %d", frame[0])
	}
}

func TestJitterBufferDeepensOnLossAndReleasesSlowly(t *testing.T) {
	t.Parallel()

	// The asymmetry IS the policy: depth is added immediately on an underrun and released only after
	// two seconds of not needing it. Being one frame too shallow is an audible gap right now; being
	// one frame too deep is 20 ms nobody can perceive. A symmetric controller would oscillate around
	// the threshold and produce a gap every time it guessed low.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	start := buffer.Target()
	pushRun(buffer, 1, 3, now)
	for tick := 0; tick < 4; tick++ {
		buffer.Pop() // the fourth Pop underruns
	}
	if deepened := buffer.Target(); deepened <= start {
		t.Fatalf("target = %d after an underrun, want deeper than %d", deepened, start)
	}

	// It does NOT give the frame back on the next comfortable tick.
	next := pushRun(buffer, 100, 6, now.Add(time.Second))
	for tick := 0; tick < 3; tick++ {
		buffer.Pop()
	}
	if released := buffer.Target(); released < start+1 {
		t.Errorf("target = %d after three good ticks; the buffer released depth immediately", released)
	}
	_ = next
}

func TestJitterBufferNeverExceedsItsBounds(t *testing.T) {
	t.Parallel()

	// The ceiling is a HUMAN constraint rather than a network one: ITU-T G.114 puts comfortable
	// interactive conversation at about 150 ms of one-way delay, and the mixer's buffer is only one
	// contributor alongside two endpoint buffers. Past the bound, more depth buys silence instead of
	// intelligibility — so the gaps are counted and the depth stops.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	// Fifty consecutive underruns, which is a leg that has stopped sending entirely.
	pushRun(buffer, 1, 3, now)
	for tick := 0; tick < 60; tick++ {
		buffer.Pop()
	}

	if target := buffer.Target(); target > 10 {
		t.Errorf("target = %d frames (%d ms); the ceiling is meant to bound it",
			target, target*audio.FrameDurationMs)
	}
	if stats := buffer.Stats(); stats.MaxDepthFrames > 10 {
		t.Errorf("MaxDepthFrames = %d, want no more than the ceiling", stats.MaxDepthFrames)
	}
}

func TestJitterBufferDiscardsAFloodRatherThanGrowing(t *testing.T) {
	t.Parallel()

	// A sender genuinely faster than the mixer's clock — a broken endpoint, or clock drift over a
	// long call — would otherwise grow the pending map until the process died. Bounded, and counted,
	// because a conference with one participant missing frames is a support ticket and a media plane
	// that ran out of memory is an outage.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	pushRun(buffer, 1, 200, now)
	if stats := buffer.Stats(); stats.Overflowed == 0 {
		t.Error("Overflowed = 0 after two hundred frames were pushed with no ticks")
	}
	if depth := buffer.Depth(); depth > 20 {
		t.Errorf("Depth = %d; the buffer is not bounded", depth)
	}
}

func TestJitterBufferSurvivesTheSequenceWrap(t *testing.T) {
	t.Parallel()

	// A call lasting twenty-two minutes at fifty packets a second wraps the 16-bit sequence space. A
	// naive `a >= b` would declare every packet after the wrap ancient and discard the rest of the
	// conference — which is a conference that works perfectly for twenty-two minutes and then dies.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	pushRun(buffer, 65533, 6, now)

	want := []uint16{65533, 65534, 65535, 0, 1, 2}
	for _, sequence := range want {
		frame, ok := buffer.Pop()
		if !ok {
			t.Fatalf("no frame at sequence %d across the wrap", sequence)
		}
		if frame[0] != byte(sequence) {
			t.Fatalf("played %d, want %d: the sequence comparison does not wrap", frame[0], byte(sequence))
		}
	}
	if stats := buffer.Stats(); stats.Lost != 0 {
		t.Errorf("Lost = %d across a clean wrap", stats.Lost)
	}
}

func TestJitterBufferDropsDuplicatesSilently(t *testing.T) {
	t.Parallel()

	// A retransmission or a duplicated datagram. Nothing is missing and nothing is late, so it counts
	// as neither — a buffer that filed duplicates as loss would report a network fault on a network
	// that was merely being generous.
	buffer := rtp.NewJitterBuffer(audio.SampleRate)
	now := time.Now()

	pushRun(buffer, 1, 3, now)
	buffer.Push(2, 2*audio.FrameTimestampStep, jitterFrame(2), now)

	stats := buffer.Stats()
	if stats.Lost != 0 || stats.Late != 0 {
		t.Errorf("a duplicate was counted as Lost=%d Late=%d", stats.Lost, stats.Late)
	}
	if depth := buffer.Depth(); depth != 3 {
		t.Errorf("Depth = %d after a duplicate, want 3", depth)
	}
}
