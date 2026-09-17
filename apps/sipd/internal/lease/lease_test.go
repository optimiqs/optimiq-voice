package lease

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

var testNow = time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)

// fakeStore records every renewal and can be made to fail, which is how the "a process that cannot
// claim its own liveness must not start" rule is asserted.
type fakeStore struct {
	mu        sync.Mutex
	renewals  []contract.SIPInstanceLease
	released  []string
	renewErr  error
	releaseEr error
	live      map[string]struct{}
	liveErr   error
}

func (f *fakeStore) Renew(_ context.Context, record contract.SIPInstanceLease) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.renewErr != nil {
		return f.renewErr
	}
	f.renewals = append(f.renewals, record)
	return nil
}

func (f *fakeStore) Release(_ context.Context, instanceID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.releaseEr != nil {
		return f.releaseEr
	}
	f.released = append(f.released, instanceID)
	return nil
}

func (f *fakeStore) Live(context.Context, time.Time) (map[string]struct{}, error) {
	return f.live, f.liveErr
}

func (f *fakeStore) snapshot() ([]contract.SIPInstanceLease, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]contract.SIPInstanceLease(nil), f.renewals...),
		append([]string(nil), f.released...)
}

func newTestRenewer(t *testing.T, store Store) *Renewer {
	t.Helper()
	renewer, err := New(Options{
		Store:      store,
		InstanceID: "sipd-alive",
		Logger:     slog.New(slog.DiscardHandler),
		Now:        func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return renewer
}

func TestARenewalCarriesTheContractTTLAsItsExpiry(t *testing.T) {
	store := &fakeStore{}
	if err := newTestRenewer(t, store).Renew(t.Context()); err != nil {
		t.Fatalf("Renew: %v", err)
	}

	renewals, _ := store.snapshot()
	if len(renewals) != 1 {
		t.Fatalf("renewed %d times, want 1", len(renewals))
	}
	record := renewals[0]
	if record.InstanceID != "sipd-alive" {
		t.Fatalf("instanceId = %q, want sipd-alive", record.InstanceID)
	}
	want := testNow.Add(contract.SIPInstancesKV.TTL).UnixMilli()
	if int64(record.ExpiresAt) != want {
		t.Fatalf("expiresAt = %d, want %d (now + the bucket TTL)", int64(record.ExpiresAt), want)
	}
	if int64(record.RenewedAt) != testNow.UnixMilli() {
		t.Fatalf("renewedAt = %d, want %d", int64(record.RenewedAt), testNow.UnixMilli())
	}
}

// The interval has to leave room for a lost write. One renewal per TTL would let a single dropped
// publish look exactly like a dead process to every reader.
func TestTheRenewIntervalLeavesRoomForALostWrite(t *testing.T) {
	if RenewInterval*2 >= contract.SIPInstancesKV.TTL {
		t.Fatalf("RenewInterval %s against a %s TTL leaves fewer than two spare renewals",
			RenewInterval, contract.SIPInstancesKV.TTL)
	}
}

// A process that cannot claim its own liveness would be reaped by the engine while it is serving
// calls. Failing at boot is the honest outcome; discovering it on the first crash is not.
func TestRunFailsWhenTheFirstRenewalCannotBeWritten(t *testing.T) {
	store := &fakeStore{renewErr: errors.New("bucket unavailable")}
	err := newTestRenewer(t, store).Run(t.Context())
	if err == nil || !strings.Contains(err.Error(), "claiming the first instance lease") {
		t.Fatalf("Run error = %v, want the first-lease failure", err)
	}
}

// A graceful shutdown drops the lease rather than leaving the engine to wait out a TTL for a
// process that told it it was leaving.
func TestACancelledRunReleasesTheLease(t *testing.T) {
	store := &fakeStore{}
	ctx, cancel := context.WithCancel(t.Context())
	renewer := newTestRenewer(t, store)

	done := make(chan error, 1)
	go func() { done <- renewer.Run(ctx) }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run error = %v, want context.Canceled", err)
	}

	_, released := store.snapshot()
	if len(released) != 1 || released[0] != "sipd-alive" {
		t.Fatalf("released = %v, want [sipd-alive]", released)
	}
}

// Exactly at the expiry the instance is gone, matching isSipInstanceLeaseExpired in TypeScript: a
// reader that treated the boundary as live would keep a stranded call up for one more sweep.
func TestExpiredIsInclusiveOfTheInstantTheLeaseNames(t *testing.T) {
	record := contract.SIPInstanceLease{
		InstanceID: "sipd-alive",
		ExpiresAt:  float64(testNow.UnixMilli()),
	}
	if Expired(record, testNow.Add(-time.Millisecond)) {
		t.Fatal("a lease expiring in a millisecond reads as expired")
	}
	if !Expired(record, testNow) {
		t.Fatal("a lease at its expiry instant reads as live")
	}
}

func TestConstructionRefusesAnInstanceWithNoID(t *testing.T) {
	if _, err := New(Options{Store: &fakeStore{}, InstanceID: "  "}); err == nil {
		t.Fatal("New accepted a blank instance id")
	}
	if _, err := New(Options{InstanceID: "sipd-alive"}); err == nil {
		t.Fatal("New accepted a nil store")
	}
}
