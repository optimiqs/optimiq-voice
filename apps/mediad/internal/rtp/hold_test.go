package rtp_test

import (
	"testing"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// aReachesB and bReachesA send one audio frame across a bridged pair and report whether it arrived.
//
// The assertions in this file are made on the WIRE rather than on the flags, deliberately: a test
// that checked `Held()` would pass on an implementation that set a boolean and forwarded the audio
// anyway, which is the defect shape — the operation reports success and the caller can still be
// heard — that the whole refusal vocabulary exists to prevent.
func (r *bridgeRig) aReachesB(t *testing.T) bool {
	t.Helper()
	return crosses(t, r.aPhone, r.bPhone, 0xa1)
}

func (r *bridgeRig) bReachesA(t *testing.T) bool {
	t.Helper()
	return crosses(t, r.bPhone, r.aPhone, 0xb1)
}

func crosses(t *testing.T, from, to *phone, marker byte) bool {
	t.Helper()
	from.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 999, SequenceNumber: 1},
		Payload: []byte{marker, marker, marker},
	})
	got, ok := to.receive(t)
	return ok && len(got.Payload) > 0 && got.Payload[0] == marker
}

// frames builds a clip of n 20 ms µ-law frames filled with one byte.
func frames(n int, fill byte) [][]byte {
	out := make([][]byte, n)
	for index := range out {
		frame := make([]byte, audio.FrameSamples)
		for i := range frame {
			frame[i] = fill
		}
		out[index] = frame
	}
	return out
}

// Rung 5: hold, music on hold and per-direction muting, asserted through the packet path rather than
// through the flags. A test that only checked `Held()` would pass on an implementation that set a
// boolean and forwarded the audio anyway, which is the exact defect shape this design keeps
// rejecting — the operation reports success and the caller can still be heard.

func TestMuteGatesTheDirectionItNames(t *testing.T) {
	// The matrix that matters, and both halves of every row are asserted: a mute must stop the
	// direction it names AND leave the other one alone. `mute(in)` on a conference participant who
	// then cannot hear the room is a worse bug than one that does nothing, because it looks like a
	// network fault.
	cases := []struct {
		name        string
		direction   rtp.MediaDirection
		wantAtoB    bool
		wantBtoA    bool
		description string
	}{
		{
			name:      "in stops what the leg SENDS",
			direction: rtp.DirectionIn,
			wantAtoB:  false,
			wantBtoA:  true,
		},
		{
			name:      "out stops what the leg HEARS",
			direction: rtp.DirectionOut,
			wantAtoB:  true,
			wantBtoA:  false,
		},
		{
			name:      "both stops everything",
			direction: rtp.DirectionBoth,
			wantAtoB:  false,
			wantBtoA:  false,
		},
	}

	for index, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			base := 62000 + index*40
			rig := newBridgeRig(t, base, base+19)
			// Latched BEFORE the bridge, deliberately: the latch packets are real RTP, and a bridge
			// that already existed would relay them — leaving a stale frame queued at each phone that
			// the assertions below would read instead of their own.
			rig.latch(t)
			if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
				t.Fatalf("Bridge: %v", err)
			}

			if err := rig.manager.Mute(rig.aID, testCase.direction); err != nil {
				t.Fatalf("Mute: %v", err)
			}

			if got := rig.aReachesB(t); got != testCase.wantAtoB {
				t.Errorf("A→B delivered = %v, want %v", got, testCase.wantAtoB)
			}
			if got := rig.bReachesA(t); got != testCase.wantBtoA {
				t.Errorf("B→A delivered = %v, want %v", got, testCase.wantBtoA)
			}

			// And it comes back. An unmute that left one gate up is the same defect one command later.
			if err := rig.manager.Unmute(rig.aID, testCase.direction); err != nil {
				t.Fatalf("Unmute: %v", err)
			}
			if !rig.aReachesB(t) {
				t.Error("A→B is still suppressed after an unmute")
			}
			if !rig.bReachesA(t) {
				t.Error("B→A is still suppressed after an unmute")
			}
		})
	}
}

func TestMuteIsAdditivePerDirection(t *testing.T) {
	// Muting `in` on a leg already muted `out` must leave BOTH muted. A direction field that replaced
	// whatever was there would make the second command an unmute of the direction nobody asked about.
	rig := newBridgeRig(t, 62200, 62219)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	session, _ := rig.manager.Get(rig.aID)
	if err := rig.manager.Mute(rig.aID, rtp.DirectionOut); err != nil {
		t.Fatalf("Mute(out): %v", err)
	}
	if err := rig.manager.Mute(rig.aID, rtp.DirectionIn); err != nil {
		t.Fatalf("Mute(in): %v", err)
	}

	in, out := session.Muted()
	if !in || !out {
		t.Fatalf("Muted() = in %v out %v, want both", in, out)
	}

	// And lifting one leaves the other.
	if err := rig.manager.Unmute(rig.aID, rtp.DirectionIn); err != nil {
		t.Fatalf("Unmute(in): %v", err)
	}
	if in, out = session.Muted(); in || !out {
		t.Errorf("after unmuting in: in %v out %v, want out still muted", in, out)
	}
}

func TestHoldTakesTheLegOutOfTheConversationBothWays(t *testing.T) {
	// Hold is symmetric where mute is not, and that is the difference between them: a held party is
	// out of the conversation, so they neither hear it nor are heard in it. A hold that only stopped
	// one direction would leave the held caller audible to a room they believe they have left.
	rig := newBridgeRig(t, 62240, 62259)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	if err := rig.manager.Hold(rig.aID, rtp.HoldOptions{}); err != nil {
		t.Fatalf("Hold: %v", err)
	}
	session, _ := rig.manager.Get(rig.aID)
	if !session.Held() {
		t.Fatal("the session does not report itself held")
	}
	if rig.aReachesB(t) {
		t.Error("a held party is still being heard")
	}
	if rig.bReachesA(t) {
		t.Error("a held party is still hearing the conversation")
	}

	held, err := rig.manager.Unhold(rig.aID)
	if err != nil {
		t.Fatalf("Unhold: %v", err)
	}
	if !held {
		t.Error("Unhold reported the session was not held")
	}
	if !rig.aReachesB(t) || !rig.bReachesA(t) {
		t.Error("the conversation did not resume after an unhold")
	}
}

func TestUnholdOfAnUnheldSessionIsHonestRatherThanAnError(t *testing.T) {
	// The engine retries an unhold. A retry that answered "failed" would make a working recovery look
	// like a broken one — the same shape `Unbridge` and `StopPlayback` use.
	rig := newBridgeRig(t, 62280, 62299)
	held, err := rig.manager.Unhold(rig.aID)
	if err != nil {
		t.Fatalf("Unhold: %v", err)
	}
	if held {
		t.Error("Unhold reported a hold that never existed")
	}
}

func TestHoldAndMuteAreIndependentStates(t *testing.T) {
	// An operator who muted a warehouse phone and then parked it does not expect parking to have
	// unmuted it. Two flags rather than one mode is what makes that true.
	rig := newBridgeRig(t, 62320, 62339)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	if err := rig.manager.Mute(rig.aID, rtp.DirectionIn); err != nil {
		t.Fatalf("Mute: %v", err)
	}
	if err := rig.manager.Hold(rig.aID, rtp.HoldOptions{}); err != nil {
		t.Fatalf("Hold: %v", err)
	}
	if _, err := rig.manager.Unhold(rig.aID); err != nil {
		t.Fatalf("Unhold: %v", err)
	}

	if rig.aReachesB(t) {
		t.Error("unholding lifted a mute that was applied before the hold")
	}
	if !rig.bReachesA(t) {
		t.Error("unholding did not restore the direction the mute never touched")
	}
}

func TestHoldStartsAndUnholdStopsTheMusicLoop(t *testing.T) {
	// The whole of rung 5's "a session sourcing from a LOOP instead of a peer", end to end: the hold
	// starts a looping playback, the loop is indexed by reference so `stop-playback` can find it, and
	// the unhold stops exactly the loop the hold started.
	rig := newBridgeRig(t, 62360, 62379)
	rig.latch(t)

	music := frames(3, 0x20)
	if err := rig.manager.Hold(rig.aID, rtp.HoldOptions{
		MusicRef:      "moh-1",
		MusicFrames:   music,
		MusicEncoding: audio.EncodingULaw,
	}); err != nil {
		t.Fatalf("Hold: %v", err)
	}

	session, _ := rig.manager.Get(rig.aID)
	playback := session.ActivePlayback()
	if playback == nil {
		t.Fatal("a hold with music started no playback")
	}
	if playback.Ref() != "moh-1" {
		t.Errorf("playback ref = %q, want moh-1", playback.Ref())
	}
	if owner, ok := rig.manager.PlaybackSessionOf("moh-1"); !ok || owner != rig.aID {
		t.Errorf("the hold loop is not in the playback index (%q, %v)", owner, ok)
	}

	if _, err := rig.manager.Unhold(rig.aID); err != nil {
		t.Fatalf("Unhold: %v", err)
	}
	<-playback.Done()
	if summary := playback.Summary(); summary.Reason != rtp.PlaybackStopped {
		t.Errorf("the hold loop ended %q, want stopped: a loop has no end to complete at",
			summary.Reason)
	}
	if summary := playback.Summary(); summary.Kind != rtp.PlaybackMusicOnHold {
		t.Errorf("the hold loop is labelled %q, want moh", summary.Kind)
	}
}

func TestHoldStandsEvenWhenItsMusicCannotStart(t *testing.T) {
	// A leg that has not sent a packet has taught symmetric RTP nowhere to send, so a playback cannot
	// begin. The hold must still take effect: the caller pressing hold expects the other party to
	// stop hearing them, and failing the hold over its soundtrack would put music ahead of privacy.
	rig := newBridgeRig(t, 62400, 62419)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	// Deliberately NOT latched: no packet has arrived from either far end.

	if err := rig.manager.Hold(rig.aID, rtp.HoldOptions{
		MusicRef:      "moh-1",
		MusicFrames:   frames(2, 0x20),
		MusicEncoding: audio.EncodingULaw,
	}); err != nil {
		t.Fatalf("Hold refused because its music could not start: %v", err)
	}
	session, _ := rig.manager.Get(rig.aID)
	if !session.Held() {
		t.Error("the hold did not stand")
	}
	if session.ActivePlayback() != nil {
		t.Error("a playback started with nowhere to send")
	}
}

func TestHoldOnAnUnknownSessionIsRefused(t *testing.T) {
	rig := newBridgeRig(t, 62440, 62459)
	if err := rig.manager.Hold("nobody", rtp.HoldOptions{}); err == nil {
		t.Error("Hold accepted a session that does not exist")
	}
	if err := rig.manager.Mute("nobody", rtp.DirectionIn); err == nil {
		t.Error("Mute accepted a session that does not exist")
	}
	if err := rig.manager.Unmute("nobody", rtp.DirectionIn); err == nil {
		t.Error("Unmute accepted a session that does not exist")
	}
	if _, err := rig.manager.Unhold("nobody"); err == nil {
		t.Error("Unhold accepted a session that does not exist")
	}
}

func TestParseMediaDirection(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		raw  string
		want rtp.MediaDirection
		bad  bool
	}{
		{name: "in", raw: "in", want: rtp.DirectionIn},
		{name: "out", raw: "out", want: rtp.DirectionOut},
		{name: "both", raw: "both", want: rtp.DirectionBoth},
		// ARI's own default: a mute with no direction mutes everything. Matching it matters more than
		// picking the direction this service would have chosen.
		{name: "empty is both", raw: "", want: rtp.DirectionBoth},
		{name: "anything else", raw: "sideways", bad: true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := rtp.ParseDirection(testCase.raw)
			if testCase.bad {
				if err == nil {
					t.Fatalf("ParseDirection(%q) accepted a direction that does not exist", testCase.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseDirection(%q): %v", testCase.raw, err)
			}
			if got != testCase.want {
				t.Errorf("ParseDirection(%q) = %q, want %q", testCase.raw, got, testCase.want)
			}
		})
	}
}
