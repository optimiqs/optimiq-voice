package reaper

import (
	"context"
	"errors"
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
	return append([]string(nil), f.deleted...)
}

func (f *fakeClaims) written() []dialog.Claim {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]dialog.Claim(nil), f.puts...)
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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, fakeLive{}, events).Sweep(context.Background())

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
	newTestReaper(t, store, live, sipevents.NewRecordingPublisher()).Sweep(context.Background())

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

	newTestReaper(t, store, live, events).Sweep(context.Background())

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
