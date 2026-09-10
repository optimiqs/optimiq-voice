package reaper

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
)

var testNow = time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)

// fakeClaims is a claim store whose every method can be made to fail independently, which is the
// only way to prove that a reap whose DELETE fails still published its termination — and that one
// whose PUBLISH fails deletes nothing.
type fakeClaims struct {
	mu      sync.Mutex
	claims  map[string]dialog.Claim
	putErr  error
	allErr  error
	delErr  error
	deleted []string
	puts    []dialog.Claim
	lists   int
}

func newFakeClaims(claims ...dialog.Claim) *fakeClaims {
	store := &fakeClaims{claims: make(map[string]dialog.Claim, len(claims))}
	for _, claim := range claims {
		store.claims[claim.LegID] = claim
	}
	return store
}

func (f *fakeClaims) Put(_ context.Context, claim dialog.Claim) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putErr != nil {
		return f.putErr
	}
	f.puts = append(f.puts, claim)
	f.claims[claim.LegID] = claim
	return nil
}

func (f *fakeClaims) Delete(_ context.Context, legID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.delErr != nil {
		return f.delErr
	}
	f.deleted = append(f.deleted, legID)
	delete(f.claims, legID)
	return nil
}

func (f *fakeClaims) All(_ context.Context) ([]dialog.Claim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lists++
	if f.allErr != nil {
		return nil, f.allErr
	}
	claims := make([]dialog.Claim, 0, len(f.claims))
	for _, claim := range f.claims {
		claims = append(claims, claim)
	}
	return claims, nil
}

func (f *fakeClaims) deletedLegs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.deleted)
}

func (f *fakeClaims) written() []dialog.Claim {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.puts)
}

type fakeLive struct{ claims []dialog.Claim }

func (f fakeLive) Claims() []dialog.Claim { return f.claims }

func claim(legID, instanceID string, expiresAt time.Time) dialog.Claim {
	return dialog.Claim{
		LegID:      legID,
		InstanceID: instanceID,
		OrgID:      "018f0000-0000-7000-8000-000000000000",
		CallID:     "call-" + legID,
		Role:       "uas",
		SIPCallID:  legID + "@pc33",
		LocalTag:   "local",
		RemoteTag:  "remote",
		State:      "confirmed",
		CreatedAt:  testNow.Add(-time.Hour).UnixMilli(),
		ExpiresAt:  expiresAt.UnixMilli(),
	}
}

func newTestReaper(t *testing.T, store Claims, live Live, events sipevents.Publisher) *Reaper {
	t.Helper()
	reaper, err := New(Options{
		Store:      store,
		Dialogs:    live,
		Events:     events,
		InstanceID: "sipd-alive",
		Now:        func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return reaper
}

// The whole point of the bucket, in one test: a dead instance's expired claim becomes a
// `dialog.terminated` the engine would otherwise never receive — and therefore a CDR row that would
// otherwise never be written.
func TestAnOrphanedClaimIsPublishedAndDeleted(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	terminated := events.TerminatedEvents()
	if len(terminated) != 1 {
		t.Fatalf("published %d terminations, want 1", len(terminated))
	}
	data := terminated[0].Data
	if data.LegID != "leg-dead" {
		t.Fatalf("legId = %q, want leg-dead", data.LegID)
	}
	if data.Reason != contract.SIPDialogTerminatedReasonInstanceLost {
		t.Fatalf("reason = %q, want instance-lost", data.Reason)
	}
	if data.Cause != CauseInstanceLost {
		t.Fatalf("cause = %d, want %d (Q.850 temporary failure)", data.Cause, CauseInstanceLost)
	}
	if deleted := store.deletedLegs(); len(deleted) != 1 || deleted[0] != "leg-dead" {
		t.Fatalf("deleted = %v, want [leg-dead]", deleted)
	}
}

// The event describes a leg that lived on the DEAD instance. Stamping the reaper's own id would
// make the engine address a follow-up command at a process that never held the call.
func TestTheTerminationNamesTheDeadOwnerNotTheReaper(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	data := events.TerminatedEvents()[0].Data
	if data.InstanceID != "sipd-gone" {
		t.Fatalf("instanceId = %q, want sipd-gone (the owner, not the reaper)", data.InstanceID)
	}
}

// Nobody DECIDED this call should end; a lease expired. `timer` and not `local`, because
// attributing it to the platform is the direction of error that loses an argument with a customer.
// And the cause was chosen from evidence about the PROCESS, not read off a SIP Reason header.
func TestTheTerminationIsAttributedToATimerAndNotToAReasonHeader(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	data := events.TerminatedEvents()[0].Data
	if data.Initiator != contract.SIPDialogTerminatedInitiatorTimer {
		t.Fatalf("initiator = %q, want timer", data.Initiator)
	}
	if data.CauseFromReasonHeader {
		t.Fatal("causeFromReasonHeader is true; there was no BYE and no response to read one from")
	}
	if data.AnsweredForSeconds != nil {
		t.Fatal("answeredForSeconds was invented; a claim records creation and expiry, not the answer")
	}
}

// The rule that makes the whole mechanism safe: this instance never reaps its OWN expired claims.
// Our own late heartbeat is a broker blip, and reaping our own live calls because the broker was
// slow would turn a network hiccup into dropped calls.
func TestOurOwnExpiredClaimsAreNeverReaped(t *testing.T) {
	store := newFakeClaims(claim("leg-mine", "sipd-alive", testNow.Add(-time.Hour)))
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	if events.Len() != 0 {
		t.Fatalf("published %d events for our own expired claim, want 0", events.Len())
	}
	if deleted := store.deletedLegs(); len(deleted) != 0 {
		t.Fatalf("deleted our own claims: %v", deleted)
	}
}

// A live claim on a dead-looking instance is not an orphan. Only a lapsed lease is.
func TestAnUnexpiredClaimFromAnotherInstanceIsLeftAlone(t *testing.T) {
	store := newFakeClaims(claim("leg-theirs", "sipd-other", testNow.Add(time.Minute)))
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	if events.Len() != 0 {
		t.Fatalf("published %d events for a live claim, want 0", events.Len())
	}
}

// Publish-then-delete, and the order is not interchangeable. A publish that fails must leave the
// claim in place so the next sweep tries again — deleting it would discard the only evidence that
// call ever ended.
func TestAFailedPublishLeavesTheClaimForTheNextSweep(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	events := &failingPublisher{err: errors.New("stream unavailable")}
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	if deleted := store.deletedLegs(); len(deleted) != 0 {
		t.Fatalf("deleted %v after a failed publish; the evidence is gone for ever", deleted)
	}
}

// The other half of that ordering: a delete that fails is HARMLESS, because the envelope carries a
// stable id as Nats-Msg-Id and the stream's duplicate window collapses the republish. One failure
// mode is bounded and idempotent; the other is a call that is never billed.
func TestAFailedDeleteStillPublished(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	store.delErr = errors.New("bucket unavailable")
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).Sweep(t.Context())

	if len(events.TerminatedEvents()) != 1 {
		t.Fatalf("published %d terminations, want 1", len(events.TerminatedEvents()))
	}
}

// The heartbeat half: every live dialog's claim is re-written, unconditionally, so a busy
// instance's calls never look dead to its neighbours.
func TestTheSweepRefreshesEveryLiveClaim(t *testing.T) {
	live := fakeLive{claims: []dialog.Claim{
		claim("leg-a", "sipd-alive", testNow.Add(90*time.Second)),
		claim("leg-b", "sipd-alive", testNow.Add(90*time.Second)),
	}}
	store := newFakeClaims()
	newTestReaper(t, store, live, sipevents.NewRecordingPublisher()).Sweep(t.Context())

	written := store.written()
	if len(written) != 2 {
		t.Fatalf("refreshed %d claims, want 2", len(written))
	}
}

// A claim that cannot be refreshed costs REAPING for that leg, not the call. Abandoning the pass
// would leave every subsequent dialog's claim stale as well.
func TestAFailedHeartbeatDoesNotStopTheReap(t *testing.T) {
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	store.putErr = errors.New("bucket unavailable")
	live := fakeLive{claims: []dialog.Claim{claim("leg-a", "sipd-alive", testNow.Add(90*time.Second))}}
	events := sipevents.NewRecordingPublisher()

	newTestReaper(t, store, live, events).Sweep(t.Context())

	if len(events.TerminatedEvents()) != 1 {
		t.Fatal("a failed heartbeat stopped the reap; a dead peer's calls would never be reaped")
	}
}

// A reaper with no publisher would DELETE claims and tell nobody, which is strictly worse than not
// running at all — so it is refused at construction, by name.
func TestConstructionRefusesTheDangerousConfigurations(t *testing.T) {
	for name, opts := range map[string]Options{
		"no store":     {Dialogs: fakeLive{}, Events: sipevents.NewRecordingPublisher(), InstanceID: "sipd"},
		"no dialogs":   {Store: newFakeClaims(), Events: sipevents.NewRecordingPublisher(), InstanceID: "sipd"},
		"no publisher": {Store: newFakeClaims(), Dialogs: fakeLive{}, InstanceID: "sipd"},
		"no instance":  {Store: newFakeClaims(), Dialogs: fakeLive{}, Events: sipevents.NewRecordingPublisher()},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := New(opts); err == nil {
				t.Fatalf("New accepted a configuration with %s", name)
			}
		})
	}
}

// An instance id is load-bearing rather than cosmetic: without one every claim in the bucket looks
// like somebody else's and this process would reap its own live calls.
func TestTheMissingInstanceIDErrorSaysWhyItMatters(t *testing.T) {
	_, err := New(Options{
		Store: newFakeClaims(), Dialogs: fakeLive{}, Events: sipevents.NewRecordingPublisher(),
	})
	if err == nil || !strings.Contains(err.Error(), "reap its own calls") {
		t.Fatalf("error = %v, want it to name the consequence", err)
	}
}

type failingPublisher struct {
	sipevents.RecordingPublisher
	err error
}

func (p *failingPublisher) Terminated(
	_ context.Context,
	_ contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	return p.err
}

// The reaper waits for the stream's acknowledgement before it deletes a claim, so the failure this
// double models is an unacknowledged publish and not merely a rejected submission.
func (p *failingPublisher) TerminatedAck(
	_ context.Context,
	_ contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	return p.err
}

// The reap half lists the WHOLE bucket, on every instance — cost O(instances × fleet dialogs) — so
// it runs on its own longer interval while the heartbeat keeps ticking at the sweep rate.
func TestTheReapListingDoesNotRunOnEverySweep(t *testing.T) {
	now := testNow
	store := newFakeClaims(claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)))
	live := fakeLive{claims: []dialog.Claim{claim("leg-a", "sipd-alive", testNow.Add(90*time.Second))}}
	reaper, err := New(Options{
		Store:      store,
		Dialogs:    live,
		Events:     sipevents.NewRecordingPublisher(),
		InstanceID: "sipd-alive",
		Interval:   30 * time.Second,
		Now:        func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// The first sweep reaps immediately: a restarted pod's neighbours may be holding claims that
	// lapsed while it was down.
	reaper.Sweep(t.Context())
	if store.lists != 1 {
		t.Fatalf("the first sweep listed %d times, want 1", store.lists)
	}

	now = now.Add(30 * time.Second)
	reaper.Sweep(t.Context())
	if store.lists != 1 {
		t.Errorf("the next sweep listed the bucket again; the reap interval is not honoured")
	}
	if len(store.written()) != 2 {
		t.Errorf("the heartbeat wrote %d claims over two sweeps, want one per sweep", len(store.written()))
	}

	// Past the reap interval — 2x the sweep interval by default, minus the jitter window.
	now = now.Add(2 * time.Minute)
	reaper.Sweep(t.Context())
	if store.lists != 2 {
		t.Errorf("listed %d times, want the reap to have run again", store.lists)
	}
}

// fakeLeases is the read half of the sip-instances bucket, so a test can say who is alive.
type fakeLeases struct {
	live map[string]struct{}
	err  error
}

func (f fakeLeases) Live(context.Context, time.Time) (map[string]struct{}, error) {
	return f.live, f.err
}

func newTestReaperWithLeases(
	t *testing.T,
	store Claims,
	events sipevents.Publisher,
	leases Leases,
) *Reaper {
	t.Helper()
	reaper, err := New(Options{
		Store:      store,
		Dialogs:    fakeLive{},
		Events:     events,
		Leases:     leases,
		InstanceID: "sipd-alive",
		Now:        func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return reaper
}

// The reason the sip-instances bucket exists. The claim's own ninety-second lease has NOT lapsed,
// but its owner stopped renewing its instance lease seconds ago — so the call is reaped now rather
// than after a minute and a half of the engine holding a channel for a dead edge.
func TestAClaimWhoseOwnerHasNoInstanceLeaseIsReapedBeforeItsClaimExpires(t *testing.T) {
	store := newFakeClaims(claim("leg-theirs", "sipd-other", testNow.Add(time.Minute)))
	events := sipevents.NewRecordingPublisher()
	leases := fakeLeases{live: map[string]struct{}{"sipd-alive": {}}}
	newTestReaperWithLeases(t, store, events, leases).Sweep(t.Context())

	terminated := events.TerminatedEvents()
	if len(terminated) != 1 || terminated[0].Data.LegID != "leg-theirs" {
		t.Fatalf("published %d terminations, want 1 for leg-theirs", len(terminated))
	}
	if deleted := store.deletedLegs(); len(deleted) != 1 || deleted[0] != "leg-theirs" {
		t.Fatalf("deleted = %v, want [leg-theirs]", deleted)
	}
}

// A live lease protects an unexpired claim, which is the ordinary steady state of a two-instance
// fleet: neither instance may touch the other's calls.
func TestALiveInstanceLeaseKeepsItsClaims(t *testing.T) {
	store := newFakeClaims(claim("leg-theirs", "sipd-other", testNow.Add(time.Minute)))
	events := sipevents.NewRecordingPublisher()
	leases := fakeLeases{live: map[string]struct{}{"sipd-alive": {}, "sipd-other": {}}}
	newTestReaperWithLeases(t, store, events, leases).Sweep(t.Context())

	if events.Len() != 0 {
		t.Fatalf("published %d events for a live instance's claim, want 0", events.Len())
	}
}

// The safety property of the lease evidence. A bucket that cannot be listed — or one an older sipd
// never writes into — must fall back to judging each claim on its own lease, NOT read the absence
// of every lease as the death of every instance and reap the whole fleet's calls.
func TestNoLeaseEvidenceFallsBackToTheClaimLease(t *testing.T) {
	for name, leases := range map[string]Leases{
		"unreadable": fakeLeases{err: errors.New("bucket unavailable")},
		"empty":      fakeLeases{live: map[string]struct{}{}},
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeClaims(
				claim("leg-live", "sipd-other", testNow.Add(time.Minute)),
				claim("leg-dead", "sipd-gone", testNow.Add(-time.Minute)),
			)
			events := sipevents.NewRecordingPublisher()
			newTestReaperWithLeases(t, store, events, leases).Sweep(t.Context())

			terminated := events.TerminatedEvents()
			if len(terminated) != 1 || terminated[0].Data.LegID != "leg-dead" {
				t.Fatalf("published %d terminations, want only leg-dead", len(terminated))
			}
		})
	}
}

// Our own claims stay ours whatever the lease bucket says. A renewal we lost to a slow broker is
// not a death, and the process reading the bucket is plainly alive — it is running the sweep.
func TestOurOwnClaimsSurviveAMissingLeaseOfOurOwn(t *testing.T) {
	store := newFakeClaims(claim("leg-mine", "sipd-alive", testNow.Add(time.Minute)))
	events := sipevents.NewRecordingPublisher()
	leases := fakeLeases{live: map[string]struct{}{"sipd-other": {}}}
	newTestReaperWithLeases(t, store, events, leases).Sweep(t.Context())

	if events.Len() != 0 {
		t.Fatalf("published %d events for our own claim, want 0", events.Len())
	}
}

// The hole the ordinary sweep cannot cover. A sipd restarted with the SAME instance id — which is
// every orchestrator that names a pod deterministically, and every deployment that sets
// SIPD_INSTANCE_ID — leaves claims that look like its own for ever, so nothing publishes the
// terminations for the calls that died with the previous process. Observed live as 25 claims
// against zero live channels.
func TestABootSweepReapsThisInstanceIDsPreviousClaims(t *testing.T) {
	store := newFakeClaims(
		claim("leg-mine-old", "sipd-alive", testNow.Add(time.Minute)),
		claim("leg-theirs", "sipd-other", testNow.Add(time.Minute)),
	)
	events := sipevents.NewRecordingPublisher()
	newTestReaper(t, store, fakeLive{}, events).SweepPredecessor(t.Context())

	terminated := events.TerminatedEvents()
	if len(terminated) != 1 || terminated[0].Data.LegID != "leg-mine-old" {
		t.Fatalf("published %d terminations, want 1 for leg-mine-old", len(terminated))
	}
	if deleted := store.deletedLegs(); len(deleted) != 1 || deleted[0] != "leg-mine-old" {
		t.Fatalf("deleted = %v, want [leg-mine-old]", deleted)
	}
}

// The guard that keeps it safe. Run late — after this process has admitted a call — it would be
// reaping its own LIVE dialogs, which is the one thing a reaper must never do.
func TestTheBootSweepRefusesOnceTheInstanceIsServing(t *testing.T) {
	store := newFakeClaims(claim("leg-mine-old", "sipd-alive", testNow.Add(time.Minute)))
	events := sipevents.NewRecordingPublisher()
	live := fakeLive{claims: []dialog.Claim{claim("leg-live", "sipd-alive", testNow.Add(time.Minute))}}
	newTestReaper(t, store, live, events).SweepPredecessor(t.Context())

	if events.Len() != 0 {
		t.Fatalf("published %d events while serving, want 0", events.Len())
	}
	if deleted := store.deletedLegs(); len(deleted) != 0 {
		t.Fatalf("deleted %v while serving", deleted)
	}
}
