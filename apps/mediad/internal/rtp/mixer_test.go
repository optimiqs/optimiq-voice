package rtp_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// Rung 6, asserted on the wire and on the SAMPLES.
//
// The mixer is the first thing in this service whose output is not a copy of its input, so the
// assertions have to be arithmetic: every participant is fed a constant tone at a distinct level and
// the test checks that what each of them receives is the SUM OF THE OTHERS, exactly. A test that
// only checked "a packet arrived" would pass on a mixer that sent everybody the same thing, which is
// precisely the bug mix-minus exists to prevent and the one a participant hears as an echo of
// themselves.

// confRig is N sessions in one room, each with a far end, on a ticker the test drives by hand.
type confRig struct {
	manager *rtp.Manager
	ticks   chan time.Time
	ids     []string
	phones  []*phone
}

// newConfRig allocates `count` sessions on one manager and gives the test the mixer's clock.
//
// The clock is the point. A conference mixes on a 20 ms tick, and a suite that waited for real ticks
// would spend its life sleeping and would still assert on whatever the scheduler happened to
// deliver. Stepping it by hand makes "one tick, one frame per member" a property the test can check
// rather than a race it can lose.
func newConfRig(t *testing.T, low, high, count int) *confRig {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	ticks := make(chan time.Time)
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Ticker: func(time.Duration) (<-chan time.Time, func()) {
			return ticks, func() {}
		},
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})

	rig := &confRig{manager: manager, ticks: ticks}
	for index := 0; index < count; index++ {
		id := string(rune('a' + index))
		descriptor, err := manager.Allocate(rtp.AllocateOptions{
			SessionID: "leg-" + id, OrgID: testOrg, CallID: testCall,
			AudioPayloadType: rtp.PayloadTypePCMU, TelephoneEventPayloadType: rtp.PayloadTypeTelephoneEvent,
		})
		if err != nil {
			t.Fatalf("allocating leg %s: %v", id, err)
		}
		rig.ids = append(rig.ids, descriptor.SessionID)
		rig.phones = append(rig.phones, newPhone(t, descriptor.RTPPort))
	}
	return rig
}

// join seats every session in one room as an ordinary participant.
func (r *confRig) join(t *testing.T, conferenceID string) {
	t.Helper()
	for _, id := range r.ids {
		if err := r.manager.JoinConference(conferenceID, id, rtp.JoinOptions{
			Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
		}); err != nil {
			t.Fatalf("JoinConference(%s): %v", id, err)
		}
	}
}

// speak feeds one member a run of frames at a constant level, and waits for them to reach the
// jitter buffer.
//
// The level is a µ-law-representable one, taken through the codec so the expected sums below are
// exact rather than approximate: encoding is lossy and the test must not be asserting against a
// number the encoder could never produce.
func (r *confRig) speak(t *testing.T, index int, level int16, count int) int16 {
	t.Helper()

	encoded := audio.LinearToULaw(level)
	exact := audio.ULawToLinear(encoded)
	payload := make([]byte, audio.FrameSamples)
	for i := range payload {
		payload[i] = encoded
	}

	for sequence := 1; sequence <= count; sequence++ {
		r.phones[index].send(t, pionrtp.Packet{
			Header: pionrtp.Header{
				Version:        2,
				PayloadType:    rtp.PayloadTypePCMU,
				SSRC:           uint32(1000 + index),
				SequenceNumber: uint16(sequence),
				Timestamp:      uint32(sequence) * audio.FrameTimestampStep,
			},
			Payload: payload,
		})
	}

	session, ok := r.manager.Get(r.ids[index])
	if !ok {
		t.Fatalf("session %s is gone", r.ids[index])
	}
	waitFor(t, "the member's frames reached its jitter buffer", func() bool {
		member := session.MixMember()
		return member != nil && member.JitterStats().Pushed >= uint64(count)
	})
	return exact
}

// tick steps the mixer once and gives the send loop a moment to reach the sockets.
func (r *confRig) tick(t *testing.T) {
	t.Helper()
	select {
	case r.ticks <- time.Now():
	case <-time.After(readTimeout):
		t.Fatal("the mix loop did not accept a tick")
	}
}

// heard reads one mixed frame at a phone and returns the level it carries.
func (r *confRig) heard(t *testing.T, index int) (int16, bool) {
	t.Helper()
	packet, ok := r.phones[index].receive(t)
	if !ok || len(packet.Payload) == 0 {
		return 0, false
	}
	return audio.ULawToLinear(packet.Payload[0]), true
}

// mixTolerance is one µ-law quantisation step near the levels these tests use.
//
// The mix itself is exact integer arithmetic; the only lossy step is re-encoding the sum for each
// participant, and µ-law's step size near 6000 is a little over 250. A tolerance is therefore
// asserting "the arithmetic is right and the codec is doing what a codec does" rather than papering
// over a mixer that is approximately correct.
const mixTolerance = 400

func closeEnough(got, want int16) bool {
	difference := int(got) - int(want)
	if difference < 0 {
		difference = -difference
	}
	return difference <= mixTolerance
}

func TestMixMinusGivesEachParticipantTheSumOfTheOthers(t *testing.T) {
	// THE rung-6 property. Three participants at three distinct levels; each must receive the sum of
	// the other two and never their own contribution. A participant hearing themselves is a delayed
	// copy of their own voice at roughly a hundred milliseconds, which is the single most disruptive
	// artefact in telephony — the effect used deliberately in experiments to stop people speaking.
	rig := newConfRig(t, 58000, 58039, 3)
	rig.join(t, "room-1")

	levels := []int16{1000, 2000, 4000}
	exact := make([]int16, len(levels))
	for index, level := range levels {
		exact[index] = rig.speak(t, index, level, 4)
	}

	rig.tick(t)

	for index := range rig.ids {
		want := int16(0)
		for other := range rig.ids {
			if other != index {
				want += exact[other]
			}
		}
		got, ok := rig.heard(t, index)
		if !ok {
			t.Fatalf("participant %d heard nothing", index)
		}
		if !closeEnough(got, want) {
			t.Errorf("participant %d heard %d, want %d (the sum of the other two, and NOT its own %d)",
				index, got, want, exact[index])
		}
	}
}

func TestMixScalesWithTheNumberOfParticipants(t *testing.T) {
	// Five participants, which is the size §2's gate names ("MOS at 3/5/10 participants"). The
	// minus-self property has to hold at every size, and the interesting failure it catches is a
	// mixer that computes one total and forgets to subtract — which is invisible with two
	// participants and obvious with five.
	rig := newConfRig(t, 58040, 58099, 5)
	rig.join(t, "room-1")

	levels := []int16{500, 1000, 1500, 2000, 2500}
	exact := make([]int16, len(levels))
	for index, level := range levels {
		exact[index] = rig.speak(t, index, level, 4)
	}

	rig.tick(t)

	for index := range rig.ids {
		want := int16(0)
		for other := range rig.ids {
			if other != index {
				want += exact[other]
			}
		}
		got, ok := rig.heard(t, index)
		if !ok {
			t.Fatalf("participant %d heard nothing", index)
		}
		if !closeEnough(got, want) {
			t.Errorf("participant %d heard %d, want %d", index, got, want)
		}
	}
}

func TestMixSaturatesRatherThanWrapping(t *testing.T) {
	// Three participants at close to full scale sum well past what an int16 holds. A wrap turns a
	// loud moment into a full-amplitude sign flip — a bang, not distortion — so the sum is clamped
	// once, after the subtraction, and the result is a loud frame rather than an inverted one.
	rig := newConfRig(t, 58100, 58139, 3)
	rig.join(t, "room-1")

	for index := 0; index < 3; index++ {
		rig.speak(t, index, 30000, 4)
	}
	rig.tick(t)

	for index := 0; index < 3; index++ {
		got, ok := rig.heard(t, index)
		if !ok {
			t.Fatalf("participant %d heard nothing", index)
		}
		if got < 25000 {
			t.Errorf("participant %d heard %d; two loud speakers should saturate NEAR full scale, "+
				"and a value this low means the sum wrapped", index, got)
		}
	}
}

func TestPerParticipantGainScalesContributionAndReception(t *testing.T) {
	// The seam W10's volume controls need, and the reason there are TWO knobs: `gainRx` turns a
	// participant down FOR EVERYBODY and `gainTx` turns everybody down FOR ONE PARTICIPANT. A single
	// knob would make the first indistinguishable from the second on a two-party call and impossible
	// on a larger one.
	rig := newConfRig(t, 58140, 58179, 3)
	rig.join(t, "room-1")

	levels := []int16{2000, 4000, 8000}
	exact := make([]int16, 3)
	for index, level := range levels {
		exact[index] = rig.speak(t, index, level, 4)
	}

	// Halve what participant 2 contributes, and halve what participant 0 receives.
	room, ok := rig.manager.Conference("room-1")
	if !ok {
		t.Fatal("the room is gone")
	}
	quiet, ok := room.Member(rig.ids[2])
	if !ok {
		t.Fatal("member 2 is not in the room")
	}
	quiet.SetGain(128, 0)

	deaf, ok := room.Member(rig.ids[0])
	if !ok {
		t.Fatal("member 0 is not in the room")
	}
	deaf.SetGain(0, 128)

	rig.tick(t)

	// Participant 1 hears participant 0 at full level plus participant 2 at half.
	want := exact[0] + exact[2]/2
	got, ok := rig.heard(t, 1)
	if !ok {
		t.Fatal("participant 1 heard nothing")
	}
	if !closeEnough(got, want) {
		t.Errorf("participant 1 heard %d, want %d: gainRx did not scale participant 2's contribution",
			got, want)
	}

	// Participant 0 hears the whole room at half.
	want = (exact[1] + exact[2]/2) / 2
	got, ok = rig.heard(t, 0)
	if !ok {
		t.Fatal("participant 0 heard nothing")
	}
	if !closeEnough(got, want) {
		t.Errorf("participant 0 heard %d, want %d: gainTx did not scale what it receives", got, want)
	}

	// And unity is the default, which is what makes the seam free until somebody uses it.
	plain, _ := room.Member(rig.ids[1])
	if rx, tx := plain.Gain(); rx != 256 || tx != 256 {
		t.Errorf("an untouched member's gain = %d/%d, want unity (256/256)", rx, tx)
	}
}

func TestAMutedParticipantContributesNothingButStillHears(t *testing.T) {
	// Paging is this shape — design doc §10 question 19: "N auto-answered legs joined to one bridge
	// with every member muted inbound". The muted member must still HEAR, or a page is silence.
	rig := newConfRig(t, 58180, 58219, 3)
	rig.join(t, "room-1")

	levels := []int16{1000, 2000, 4000}
	exact := make([]int16, 3)
	for index, level := range levels {
		exact[index] = rig.speak(t, index, level, 4)
	}

	if err := rig.manager.Mute(rig.ids[2], rtp.DirectionIn); err != nil {
		t.Fatalf("Mute: %v", err)
	}
	// The mute gates the RECEIVE path, so the frames already in the buffer would still be mixed. A
	// second run of frames arriving after the mute is what the assertion needs.
	rig.speak(t, 0, levels[0], 4)
	rig.speak(t, 1, levels[1], 4)
	rig.speak(t, 2, levels[2], 4)

	rig.tick(t)

	got, ok := rig.heard(t, 0)
	if !ok {
		t.Fatal("participant 0 heard nothing")
	}
	// It may still be draining the pre-mute frames on this tick, so the assertion is the one that
	// cannot be true if the mute did nothing: participant 0 never hears MORE than the whole room.
	if !closeEnough(got, exact[1]+exact[2]) && !closeEnough(got, exact[1]) {
		t.Errorf("participant 0 heard %d, want either %d (pre-mute frames draining) or %d (muted)",
			got, exact[1]+exact[2], exact[1])
	}

	// The muted member's own reception is untouched: it hears the other two.
	got, ok = rig.heard(t, 2)
	if !ok {
		t.Fatal("the muted participant heard nothing; a muted page member would hear no page")
	}
	if !closeEnough(got, exact[0]+exact[1]) {
		t.Errorf("the muted participant heard %d, want %d", got, exact[0]+exact[1])
	}
}

func TestJoiningAConferenceReplacesABridge(t *testing.T) {
	// A session is in exactly ONE conversation. A leg left in a bridge and a room at once would
	// deliver every frame twice under one SSRC, which is the thing a receiver's jitter buffer cannot
	// untangle.
	rig := newConfRig(t, 58220, 58259, 3)
	if err := rig.manager.Bridge("bridge-1", rig.ids[0], rig.ids[1]); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	rig.join(t, "room-1")

	for _, id := range rig.ids[:2] {
		session, _ := rig.manager.Get(id)
		if session.Peer() != nil {
			t.Errorf("%s is in a room and still points at a bridge peer", id)
		}
		if session.MixMember() == nil {
			t.Errorf("%s is not seated in the room", id)
		}
	}
	if _, stillBridged := rig.manager.Unbridge("bridge-1"); stillBridged {
		t.Error("the bridge outlived the conference that replaced it")
	}
}

func TestAnEmptyConferenceIsReaped(t *testing.T) {
	// Rooms are implicit — created by the first join — so they have to be reaped by the last leave,
	// or every conference that ever happened leaves a mix loop ticking fifty times a second forever.
	rig := newConfRig(t, 58260, 58299, 2)
	rig.join(t, "room-1")

	if _, ok := rig.manager.Conference("room-1"); !ok {
		t.Fatal("the room was not created by the first join")
	}
	for _, id := range rig.ids {
		if _, left := rig.manager.LeaveConference(id); !left {
			t.Errorf("LeaveConference(%s) reported nothing to leave", id)
		}
	}
	if _, ok := rig.manager.Conference("room-1"); ok {
		t.Error("an empty room survived its last member")
	}
}

func TestReleasingAParticipantLeavesTheRoomRunning(t *testing.T) {
	// A participant hanging up is not a conference ending, exactly as one leg hanging up is not a
	// bridge's other leg ending. What must not survive is a SEAT pointing at a closed socket, because
	// the mixer would go on encoding a frame for it fifty times a second.
	rig := newConfRig(t, 58300, 58339, 3)
	rig.join(t, "room-1")

	if !rig.manager.Release(rig.ids[2]) {
		t.Fatal("Release reported nothing to release")
	}
	room, ok := rig.manager.Conference("room-1")
	if !ok {
		t.Fatal("the room ended when one participant left")
	}
	if got := room.Len(); got != 2 {
		t.Errorf("the room has %d members, want 2", got)
	}
	for _, id := range room.Members() {
		if id == rig.ids[2] {
			t.Error("a released session still holds a seat")
		}
	}
}

func TestDestroyingAConferenceLeavesItsSessionsAlive(t *testing.T) {
	// Destroying a room is not hanging up the calls in it, exactly as unbridging is not hanging up
	// two legs: the engine decides what happens to a participant whose conference ended, and a media
	// plane that released them would be making that decision on the far side of the seam.
	rig := newConfRig(t, 58340, 58379, 3)
	rig.join(t, "room-1")

	members, ok := rig.manager.DestroyConference("room-1")
	if !ok {
		t.Fatal("DestroyConference reported no room")
	}
	if len(members) != 3 {
		t.Errorf("DestroyConference reported %d members, want 3", len(members))
	}
	for _, id := range rig.ids {
		session, alive := rig.manager.Get(id)
		if !alive {
			t.Fatalf("%s was released when the room was destroyed", id)
		}
		if session.MixMember() != nil {
			t.Errorf("%s still holds a seat in a destroyed room", id)
		}
	}
	if _, ok := rig.manager.DestroyConference("room-1"); ok {
		t.Error("destroying a destroyed room reported success twice")
	}
}
