package rtp_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// Topology as a whole: which conversation a session is in, and what survives a command that fails.
// The mix and the relay are asserted elsewhere; what these tests hold is that a leg is in exactly
// one conversation, that a refused move changes nothing, and that no room outlives its last member.

// topologyRig is `count` sessions on one manager, with no far ends: these assertions are about the
// index, not the wire.
type topologyRig struct {
	manager *rtp.Manager
	ids     []string
}

func newTopologyRig(t *testing.T, low, high, count int, format audio.Format) *topologyRig {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Ticker:     func(time.Duration) (<-chan time.Time, func()) { return nil, func() {} },
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

	rig := &topologyRig{manager: manager}
	for index := range count {
		id := "leg-" + string(rune('a'+index))
		if _, err := manager.Allocate(rtp.AllocateOptions{
			SessionID: id, OrgID: testOrg, CallID: testCall,
			AudioPayloadType: rtp.PayloadTypePCMU, Format: format,
			TelephoneEventPayloadType: rtp.PayloadTypeTelephoneEvent,
		}); err != nil {
			t.Fatalf("allocating %s: %v", id, err)
		}
		rig.ids = append(rig.ids, id)
	}
	return rig
}

// peerOf reports the id of whatever the packet path currently relays this session to.
func (r *topologyRig) peerOf(t *testing.T, sessionID string) string {
	t.Helper()
	session, ok := r.manager.Get(sessionID)
	if !ok {
		t.Fatalf("session %s is gone", sessionID)
	}
	peer := session.Peer()
	if peer == nil {
		return ""
	}
	return peer.ID
}

func TestReusingABridgeIDForADifferentPairDetachesTheFirstOne(t *testing.T) {
	// The engine may re-use a bridge id across an attended transfer. Overwriting the index alone
	// left the first pair relaying to each other with nothing able to address them: a later
	// unbridge under that id took the second pair down and left the first talking forever.
	rig := newTopologyRig(t, 63200, 63239, 4, audio.FormatULaw)
	a, b, c, d := rig.ids[0], rig.ids[1], rig.ids[2], rig.ids[3]

	if err := rig.manager.Bridge("shared", a, b); err != nil {
		t.Fatalf("Bridge(a,b): %v", err)
	}
	if err := rig.manager.Bridge("shared", c, d); err != nil {
		t.Fatalf("Bridge(c,d): %v", err)
	}

	for _, id := range []string{a, b} {
		if peer := rig.peerOf(t, id); peer != "" {
			t.Fatalf("%s still relays to %s after its bridge id was re-used", id, peer)
		}
		if _, in := rig.manager.BridgeOf(id); in {
			t.Fatalf("%s is still indexed under a bridge", id)
		}
	}
	if peer := rig.peerOf(t, c); peer != d {
		t.Fatalf("the replacing pair is not connected: %s relays to %q", c, peer)
	}

	if _, ok := rig.manager.Unbridge("shared"); !ok {
		t.Fatal("Unbridge found no bridge under the re-used id")
	}
	for _, id := range rig.ids {
		if peer := rig.peerOf(t, id); peer != "" {
			t.Fatalf("%s still relays to %s after the unbridge", id, peer)
		}
	}
}

func TestARefusedConferenceJoinLeavesTheExistingConversationIntact(t *testing.T) {
	// A join builds a codec pair, and that is the step that can refuse. Tearing the leg out of its
	// bridge first meant an Opus call asked into a mix lost its audio to an error the caller was
	// told about but could not undo.
	rig := newTopologyRig(t, 63240, 63279, 2, audio.FormatOpus)
	a, b := rig.ids[0], rig.ids[1]

	if err := rig.manager.Bridge("call", a, b); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	if err := rig.manager.JoinConference("room", a, rtp.JoinOptions{
		Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
	}); err == nil {
		t.Fatal("JoinConference accepted a codec the mixer cannot decode")
	}

	if peer := rig.peerOf(t, a); peer != b {
		t.Fatalf("the refused join detached the bridge: %s relays to %q", a, peer)
	}
	if id, ok := rig.manager.BridgeOf(a); !ok || id != "call" {
		t.Fatalf("BridgeOf(%s) = %q/%v after a refused join", a, id, ok)
	}
	if _, exists := rig.manager.Conference("room"); exists {
		t.Fatal("the refused join left a room running")
	}
}

func TestEveryDepartureDestroysTheRoomItEmptied(t *testing.T) {
	// Rooms are implicit: created by the first join, so the last departure must reap them or their
	// mix loop ticks for the life of the process. Four departures, one cleanup path.
	for _, row := range []struct {
		name  string
		low   int
		leave func(t *testing.T, rig *topologyRig, sessionID string)
	}{
		{"an explicit leave", 63280, func(t *testing.T, rig *topologyRig, id string) {
			if _, ok := rig.manager.LeaveConference(id); !ok {
				t.Fatal("LeaveConference found no room")
			}
		}},
		{"a release", 63320, func(t *testing.T, rig *topologyRig, id string) {
			if !rig.manager.Release(id) {
				t.Fatal("Release found no session")
			}
		}},
		{"a move into a bridge", 63360, func(t *testing.T, rig *topologyRig, id string) {
			if err := rig.manager.Bridge("elsewhere", id, rig.ids[1]); err != nil {
				t.Fatalf("Bridge: %v", err)
			}
		}},
		{"a move into another room", 63400, func(t *testing.T, rig *topologyRig, id string) {
			if err := rig.manager.JoinConference("other", id, rtp.JoinOptions{
				Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
			}); err != nil {
				t.Fatalf("JoinConference: %v", err)
			}
		}},
	} {
		t.Run(row.name, func(t *testing.T) {
			rig := newTopologyRig(t, row.low, row.low+39, 2, audio.FormatULaw)
			only := rig.ids[0]
			if err := rig.manager.JoinConference("room", only, rtp.JoinOptions{
				Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
			}); err != nil {
				t.Fatalf("JoinConference: %v", err)
			}
			room, exists := rig.manager.Conference("room")
			if !exists {
				t.Fatal("the join created no room")
			}

			row.leave(t, rig, only)

			if _, stillThere := rig.manager.Conference("room"); stillThere {
				t.Fatal("the emptied room is still indexed")
			}
			select {
			case <-room.Done():
			case <-time.After(readTimeout):
				t.Fatal("the emptied room's mix loop is still running")
			}
		})
	}
}

func TestIdleReapingDestroysTheRoomItEmptied(t *testing.T) {
	// The reaper drops its members straight out of the session map, which is the departure path
	// most easily written without the cleanup the others do.
	allocator, err := rtp.NewAllocator(loopback, 63440, 63479)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	now := time.Now()
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		IdleAfter:  time.Minute,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:        func() time.Time { return now },
		Ticker:     func(time.Duration) (<-chan time.Time, func()) { return nil, func() {} },
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

	if _, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-a", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU, Format: audio.FormatULaw,
	}); err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if err := manager.JoinConference("room", "leg-a", rtp.JoinOptions{
		Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
	}); err != nil {
		t.Fatalf("JoinConference: %v", err)
	}
	room, exists := manager.Conference("room")
	if !exists {
		t.Fatal("the join created no room")
	}

	now = now.Add(2 * time.Minute)
	if reaped := manager.ReapIdle(); reaped != 1 {
		t.Fatalf("ReapIdle reaped %d sessions, want 1", reaped)
	}

	if _, stillThere := manager.Conference("room"); stillThere {
		t.Fatal("the reaped member's room is still indexed")
	}
	select {
	case <-room.Done():
	case <-time.After(readTimeout):
		t.Fatal("the reaped member's room is still mixing")
	}
}

func TestASessionIsInExactlyOneConversationThroughEveryTransition(t *testing.T) {
	// The forward maps and the reverse indexes are written together; this walks a leg through every
	// transition and holds them to the same answer at each step.
	rig := newTopologyRig(t, 63480, 63519, 3, audio.FormatULaw)
	a, b, c := rig.ids[0], rig.ids[1], rig.ids[2]

	assert := func(step, wantBridge, wantRoom string) {
		t.Helper()
		bridgeID, inBridge := rig.manager.BridgeOf(a)
		if inBridge != (wantBridge != "") || bridgeID != wantBridge {
			t.Fatalf("%s: BridgeOf = %q/%v, want %q", step, bridgeID, inBridge, wantBridge)
		}
		roomID, inRoom := rig.manager.ConferenceOf(a)
		if inRoom != (wantRoom != "") || roomID != wantRoom {
			t.Fatalf("%s: ConferenceOf = %q/%v, want %q", step, roomID, inRoom, wantRoom)
		}
	}

	assert("fresh", "", "")

	if err := rig.manager.Bridge("one", a, b); err != nil {
		t.Fatalf("Bridge(one): %v", err)
	}
	assert("bridged", "one", "")

	if err := rig.manager.Bridge("two", a, c); err != nil {
		t.Fatalf("Bridge(two): %v", err)
	}
	assert("re-bridged", "two", "")
	if _, stale := rig.manager.Unbridge("one"); stale {
		t.Fatal("the bridge the leg moved out of is still indexed")
	}

	if err := rig.manager.JoinConference("room", a, rtp.JoinOptions{
		Hear: rtp.Everyone(), SpeakTo: rtp.Everyone(),
	}); err != nil {
		t.Fatalf("JoinConference: %v", err)
	}
	assert("in a room", "", "room")

	if err := rig.manager.JoinConference("room", a, rtp.JoinOptions{
		Hear: rtp.Everyone(), SpeakTo: rtp.Nobody(),
	}); err != nil {
		t.Fatalf("re-join: %v", err)
	}
	assert("re-pointed in place", "", "room")

	if _, ok := rig.manager.LeaveConference(a); !ok {
		t.Fatal("LeaveConference found no room")
	}
	assert("left", "", "")
}
