package rtp_test

import (
	"errors"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The tap suite is the cash-in on design doc §10 question 4's W6 addendum.
//
// The addendum's prediction was that shaping supervision as an ASYMMETRIC BRIDGE PARTICIPANT rather
// than as a snoop channel would let rung 6 serve it "by arriving, not by being extended" — and that
// eavesdrop, whisper and barge would be "three argument combinations rather than three code paths".
// This file is the test of that claim: one table, three rows, one implementation.

// tapRig is a two-party call plus a third session standing in for a supervisor's own leg.
type tapRig struct {
	*confRig
	agent      string
	customer   string
	supervisor string
	// idle is a fourth session in no conversation at all, for the refusal that needs one.
	idle string
}

func newTapRig(t *testing.T, low, high int) *tapRig {
	t.Helper()
	rig := newConfRig(t, low, high, 4)
	// The two parties are bridged as an ordinary call, which is the state every tap starts from.
	if err := rig.manager.Bridge("call-1", rig.ids[0], rig.ids[1]); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	return &tapRig{
		confRig:    rig,
		agent:      rig.ids[0],
		customer:   rig.ids[1],
		supervisor: rig.ids[2],
		idle:       rig.ids[3],
	}
}

func TestTapRoutesTheThreeSupervisionModes(t *testing.T) {
	// The routing matrix, on the wire. Each row is one of the three features in every PBX brochure,
	// and the assertion is about WHO HEARS WHOM rather than about which method was called — because
	// the failure that matters (a customer hearing a supervisor's coaching) is invisible at the
	// method level and obvious at the sample level.
	cases := []struct {
		name    string
		hear    rtp.Side
		speakTo rtp.Side
		// What each party ends up hearing, as a set of the OTHER parties' levels.
		agentHears      []int
		customerHears   []int
		supervisorHears []int
	}{
		{
			// The supervisor is present and inaudible.
			name: "eavesdrop", hear: rtp.SideBoth, speakTo: rtp.SideNone,
			agentHears: []int{1}, customerHears: []int{0}, supervisorHears: []int{0, 1},
		},
		{
			// Coaching. The customer must NOT hear it, and that is the row where a naive "add the
			// supervisor to the bridge" implementation fails.
			name: "whisper", hear: rtp.SideBoth, speakTo: rtp.SideA,
			agentHears: []int{1, 2}, customerHears: []int{0}, supervisorHears: []int{0, 1},
		},
		{
			// A third party in the conversation.
			name: "barge", hear: rtp.SideBoth, speakTo: rtp.SideBoth,
			agentHears: []int{1, 2}, customerHears: []int{0, 2}, supervisorHears: []int{0, 1},
		},
	}

	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			base := 59000 + index*60
			rig := newTapRig(t, base, base+49)

			result, err := rig.manager.Tap(rtp.TapOptions{
				TapID:           "tap-1",
				TapSessionID:    rig.supervisor,
				TargetSessionID: rig.agent,
				Hear:            testCase.hear,
				SpeakTo:         testCase.speakTo,
				Mode:            testCase.name,
			})
			if err != nil {
				t.Fatalf("Tap: %v", err)
			}
			// A tap on a two-party relay CONVERTS it into a mix, and the room keeps the bridge's id so
			// the engine can still tear down what it created under the name it created it with.
			if !result.Converted {
				t.Error("tapping a bridged call did not report the conversion to a mix")
			}
			if result.ConferenceID != "call-1" {
				t.Errorf("the room is %q, want the bridge's own id", result.ConferenceID)
			}

			levels := []int16{1000, 2000, 4000}
			exact := make([]int16, 3)
			for member, level := range levels {
				exact[member] = rig.speak(t, member, level, 4)
			}
			rig.tick(t)

			for member, want := range [][]int{
				testCase.agentHears, testCase.customerHears, testCase.supervisorHears,
			} {
				expected := int16(0)
				for _, contributor := range want {
					expected += exact[contributor]
				}
				got, ok := rig.heard(t, member)
				if !ok {
					t.Fatalf("party %d heard nothing", member)
				}
				if !closeEnough(got, expected) {
					t.Errorf("party %d heard %d, want %d (the sum of parties %v)",
						member, got, expected, want)
				}
			}
		})
	}
}

func TestTapCanBeRepointedWithoutRejoining(t *testing.T) {
	// A supervisor escalating from whisper to barge is a re-tap, and it must not take the member out
	// of the room and put them back: that would drop their jitter buffer and reset their codec
	// mid-sentence, which the coached agent hears as a gap in the middle of being coached.
	rig := newTapRig(t, 59200, 59249)

	if _, err := rig.manager.Tap(rtp.TapOptions{
		TapID: "tap-1", TapSessionID: rig.supervisor, TargetSessionID: rig.agent,
		Hear: rtp.SideBoth, SpeakTo: rtp.SideNone, Mode: "eavesdrop",
	}); err != nil {
		t.Fatalf("Tap: %v", err)
	}
	room, _ := rig.manager.Conference("call-1")
	before, _ := room.Member(rig.supervisor)

	if _, err := rig.manager.Tap(rtp.TapOptions{
		TapID: "tap-1", TapSessionID: rig.supervisor, TargetSessionID: rig.agent,
		Hear: rtp.SideBoth, SpeakTo: rtp.SideBoth, Mode: "barge",
	}); err != nil {
		t.Fatalf("re-Tap: %v", err)
	}
	after, _ := room.Member(rig.supervisor)
	if before != after {
		t.Error("escalating a tap took the supervisor out of the room and put them back")
	}
	if room.Len() != 3 {
		t.Errorf("the room has %d members after a re-tap, want 3", room.Len())
	}
}

func TestUntapLeavesTheConversationRunning(t *testing.T) {
	rig := newTapRig(t, 59260, 59309)

	if _, err := rig.manager.Tap(rtp.TapOptions{
		TapID: "tap-1", TapSessionID: rig.supervisor, TargetSessionID: rig.agent,
		Hear: rtp.SideBoth, SpeakTo: rtp.SideNone,
	}); err != nil {
		t.Fatalf("Tap: %v", err)
	}

	sessionID, untapped := rig.manager.Untap("tap-1")
	if !untapped {
		t.Fatal("Untap reported no tap")
	}
	if sessionID != rig.supervisor {
		t.Errorf("Untap reported session %q, want the supervisor's", sessionID)
	}

	room, ok := rig.manager.Conference("call-1")
	if !ok {
		t.Fatal("the monitored conversation ended when the supervisor left")
	}
	if room.Len() != 2 {
		t.Errorf("the room has %d members after the tap left, want 2", room.Len())
	}

	// A retried untap answers honestly rather than as a failure — the same shape unbridge uses.
	if _, again := rig.manager.Untap("tap-1"); again {
		t.Error("untapping a finished tap reported success twice")
	}
}

func TestReleasingASupervisorTakesTheirTapWithThem(t *testing.T) {
	// A tap record that outlived its session would be a supervisor the engine believes is still
	// listening. On a compliance surface that is the expensive direction to be wrong in.
	rig := newTapRig(t, 59320, 59369)

	if _, err := rig.manager.Tap(rtp.TapOptions{
		TapID: "tap-1", TapSessionID: rig.supervisor, TargetSessionID: rig.agent,
		Hear: rtp.SideBoth, SpeakTo: rtp.SideNone,
	}); err != nil {
		t.Fatalf("Tap: %v", err)
	}
	if !rig.manager.Release(rig.supervisor) {
		t.Fatal("Release reported nothing to release")
	}
	if _, stillThere := rig.manager.TapConference("tap-1"); stillThere {
		t.Error("the tap outlived the supervisor's own session")
	}
}

func TestTapRefusals(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*rtp.TapOptions)
		wantErr error
	}{
		{
			name:   "a target that does not exist",
			mutate: func(o *rtp.TapOptions) { o.TargetSessionID = "nobody" },
			// The directory turns this into `wrong_instance` at the wire when a neighbour has it, which
			// is the difference between "try again" and "try there".
			wantErr: rtp.ErrUnknownSession,
		},
		{
			// A supervisor listening to silence and being told it worked is worse than being told
			// there was nothing to listen to.
			name:    "a target that is talking to nobody",
			mutate:  func(o *rtp.TapOptions) { o.TargetSessionID = "leg-d" },
			wantErr: rtp.ErrNotInConversation,
		},
		{
			name:   "a session tapping itself",
			mutate: func(o *rtp.TapOptions) { o.TapSessionID = o.TargetSessionID },
		},
		{
			name:   "no tap id",
			mutate: func(o *rtp.TapOptions) { o.TapID = "" },
		},
		{
			name:   "no supervisor session",
			mutate: func(o *rtp.TapOptions) { o.TapSessionID = "" },
		},
	}

	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			base := 59400 + index*60
			rig := newTapRig(t, base, base+49)

			opts := rtp.TapOptions{
				TapID: "tap-1", TapSessionID: rig.supervisor, TargetSessionID: rig.agent,
				Hear: rtp.SideBoth, SpeakTo: rtp.SideNone,
			}
			testCase.mutate(&opts)

			_, err := rig.manager.Tap(opts)
			if err == nil {
				t.Fatal("Tap accepted a request it cannot serve")
			}
			if testCase.wantErr != nil && !errors.Is(err, testCase.wantErr) {
				t.Errorf("Tap error = %v, want %v", err, testCase.wantErr)
			}
		})
	}
}

func TestSideBIsRefusedInARoomThatHasNoOtherParty(t *testing.T) {
	// `a` and `b` are the halves of a two-party conversation and they mean nothing in a room of five.
	// Resolved to whoever happens to be second in the join order, `speakTo: "b"` would coach a
	// different participant on every call — so it is refused with the gap named instead.
	rig := newConfRig(t, 59700, 59759, 4)
	for _, id := range rig.ids[:3] {
		if err := rig.manager.JoinConference("room-1", id, rtp.JoinOptions{
			Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
		}); err != nil {
			t.Fatalf("JoinConference: %v", err)
		}
	}

	_, err := rig.manager.Tap(rtp.TapOptions{
		TapID: "tap-1", TapSessionID: rig.ids[3], TargetSessionID: rig.ids[0],
		Hear: rtp.SideBoth, SpeakTo: rtp.SideB,
	})
	if !errors.Is(err, rtp.ErrNotInConversation) {
		t.Fatalf("Tap error = %v, want ErrNotInConversation naming the side", err)
	}

	// `both` and `none` still work in a room of any size, which is what makes eavesdrop and barge
	// available on a conference while whisper is not.
	if _, err := rig.manager.Tap(rtp.TapOptions{
		TapID: "tap-2", TapSessionID: rig.ids[3], TargetSessionID: rig.ids[0],
		Hear: rtp.SideBoth, SpeakTo: rtp.SideNone,
	}); err != nil {
		t.Errorf("eavesdropping on a room of three was refused: %v", err)
	}
}

func TestParseSide(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		raw  string
		want rtp.Side
		bad  bool
	}{
		{name: "a", raw: "a", want: rtp.SideA},
		{name: "b", raw: "b", want: rtp.SideB},
		{name: "both", raw: "both", want: rtp.SideBoth},
		{name: "none", raw: "none", want: rtp.SideNone},
		// No default: a side is the whole of what a tap routes on, and guessing one would put a
		// supervisor somewhere nobody asked for.
		{name: "empty", raw: "", bad: true},
		{name: "a direction rather than a side", raw: "in", bad: true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := rtp.ParseSide(testCase.raw)
			if testCase.bad {
				if err == nil {
					t.Fatalf("ParseSide(%q) accepted a side that does not exist", testCase.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseSide(%q): %v", testCase.raw, err)
			}
			if got != testCase.want {
				t.Errorf("ParseSide(%q) = %q, want %q", testCase.raw, got, testCase.want)
			}
		})
	}
}
