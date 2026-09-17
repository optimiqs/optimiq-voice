package reaper

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
)

// The retry guarantee the reap ordering rests on: two publications of the same orphan's termination
// carry the same envelope id, so the stream's duplicate window collapses them into one CDR row.
func TestAnOrphanTerminationKeepsOneIDAcrossSweeps(t *testing.T) {
	store := newFakeClaims(
		claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)),
		claim("leg-dead-2", "sipd-gone", testNow.Add(-time.Minute)),
	)
	store.delErr = errors.New("bucket unavailable")
	events := sipevents.NewRecordingPublisher()
	reaper := newTestReaper(t, store, fakeLive{}, events)

	reaper.Sweep(t.Context())
	reaper.nextReap = time.Time{}
	reaper.Sweep(t.Context())

	ids := make(map[string][]string)
	for _, envelope := range events.TerminatedEvents() {
		ids[envelope.Data.LegID] = append(ids[envelope.Data.LegID], envelope.ID)
	}
	if len(ids) != 2 {
		t.Fatalf("terminated legs = %d, want 2", len(ids))
	}
	for legID, published := range ids {
		if len(published) != 2 {
			t.Fatalf("%s published %d times, want 2 (the delete failed both sweeps)", legID, len(published))
		}
		if published[0] != published[1] {
			t.Errorf("%s republished as %s then %s; a retry must reuse the id", legID, published[0], published[1])
		}
	}
	if ids["leg-dead"][0] == ids["leg-dead-2"][0] {
		t.Error("two different legs must not share a termination id")
	}
}

// A claim is recovery evidence: it may only be deleted once the termination is DURABLE. A publish
// the stream never acknowledged is not.
func TestAnUnacknowledgedTerminationKeepsTheClaim(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	events := &failingPublisher{err: errors.New("no acknowledgement")}
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	if deleted := store.deletedLegs(); len(deleted) != 0 {
		t.Fatalf("deleted %v for a termination the stream never accepted", deleted)
	}
}

// An expired claim whose OWNER renewed its instance lease is a late heartbeat, not a dead call.
func TestAnExpiredClaimOfALiveOwnerIsNotReaped(t *testing.T) {
	store := newFakeClaims(claim("leg-slow", "sipd-busy", testNow.Add(-time.Minute)))
	events := sipevents.NewRecordingPublisher()
	reaper, err := New(Options{
		Store:      store,
		Dialogs:    fakeLive{},
		Events:     events,
		Leases:     fakeLeases{live: map[string]struct{}{"sipd-busy": {}}},
		InstanceID: "sipd-alive",
		Now:        func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	reaper.Sweep(t.Context())

	if events.Len() != 0 {
		t.Errorf("published %d terminations for a live owner's calls, want 0", events.Len())
	}
	if deleted := store.deletedLegs(); len(deleted) != 0 {
		t.Errorf("deleted %v belonging to an instance that is still renewing its lease", deleted)
	}
}

// budgetedClaims accepts a fixed number of renewals per sweep and refuses the rest, which is what a
// broker slow enough to exhaust the heartbeat's budget looks like from here.
type budgetedClaims struct {
	fakeClaims
	mu       sync.Mutex
	budget   int
	accepted int
	order    []string
}

func (b *budgetedClaims) Put(_ context.Context, claim dialog.Claim) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.accepted >= b.budget {
		return errors.New("bucket is too slow")
	}
	b.accepted++
	b.order = append(b.order, claim.LegID)
	return nil
}

func (b *budgetedClaims) sweepOrder() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	order := b.order
	b.order = nil
	b.accepted = 0
	return order
}

// Fair continuation: the claims a starved sweep could not renew are the ones the next sweep renews
// first, so the same calls are not the ones left to expire every time.
func TestAStarvedHeartbeatResumesWhereItStopped(t *testing.T) {
	live := make([]dialog.Claim, 0, 8)
	for index := range 8 {
		live = append(live, claim("leg-"+strconv.Itoa(index), "sipd-alive", testNow.Add(time.Minute)))
	}
	store := &budgetedClaims{fakeClaims: *newFakeClaims(), budget: 4}
	reaper, err := New(Options{
		Store:      store,
		Dialogs:    fakeLive{claims: live},
		Events:     sipevents.NewRecordingPublisher(),
		InstanceID: "sipd-alive",
		Workers:    1,
		Now:        func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	reaper.Sweep(t.Context())
	first := store.sweepOrder()
	if len(first) != 4 || first[0] != "leg-0" {
		t.Fatalf("first sweep renewed %v, want the first four in order", first)
	}

	reaper.Sweep(t.Context())
	second := store.sweepOrder()
	if len(second) != 4 || second[0] != "leg-4" {
		t.Fatalf("second sweep renewed %v, want it to resume at leg-4", second)
	}
}
