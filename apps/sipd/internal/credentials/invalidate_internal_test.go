package credentials

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	orgAcme  = "018f4f5e-0000-7000-8000-0000000000a1"
	orgOther = "018f4f5e-0000-7000-8000-0000000000b2"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// invalidationMessage builds the wire message apps/api publishes.
func invalidationMessage(t *testing.T, orgID string) *nats.Msg {
	t.Helper()
	subject, err := contract.ProvisionSubject(orgID)
	if err != nil {
		t.Fatalf("building the subject: %v", err)
	}
	envelope := contract.NewEnvelope(contract.EventTypeProvisionCredentialInvalidated,
		contract.EnvelopeInput[contract.ProvisionCredentialInvalidatedData]{
			OrgID:   orgID,
			Subject: subject,
			Source:  "api",
			Data:    contract.ProvisionCredentialInvalidatedData{Reason: "update on extension", Dropped: 7},
		})
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("encoding the envelope: %v", err)
	}
	return &nats.Msg{Subject: subject, Data: data}
}

// cachedStore is a store with two tenants' credentials and one cached refusal in it.
func cachedStore(now time.Time) *NATSStore {
	store := &NATSStore{
		cache:       map[string]cacheEntry{},
		lastRefresh: map[string]time.Time{},
		maxEntries:  64,
		positiveTTL: 30 * time.Second,
		negativeTTL: 10 * time.Second,
		refreshTTL:  5 * time.Second,
		now:         func() time.Time { return now },
	}
	store.store(lookupKey("acme.example.com", "1001"),
		cacheEntry{credential: Credential{OrgID: orgAcme, Username: "1001"}, expires: now.Add(30 * time.Second)})
	store.store(lookupKey("acme.example.com", "1002"),
		cacheEntry{credential: Credential{OrgID: orgAcme, Username: "1002"}, expires: now.Add(30 * time.Second)})
	store.store(lookupKey("other.example.com", "2001"),
		cacheEntry{credential: Credential{OrgID: orgOther, Username: "2001"}, expires: now.Add(30 * time.Second)})
	store.store(lookupKey("acme.example.com", "9999"),
		cacheEntry{err: ErrNotFound, expires: now.Add(10 * time.Second)})
	return store
}

func TestEvictOrgDropsOneTenantAndLeavesTheOthers(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	store := cachedStore(now)
	store.lastRefresh[lookupKey("acme.example.com", "1001")] = now

	// The refusal has no org and goes with them: it is what a re-enable has to clear.
	if dropped := store.EvictOrg(orgAcme); dropped != 3 {
		t.Errorf("dropped = %d, want 3 (two credentials and the cached refusal)", dropped)
	}
	if _, ok := store.cached(lookupKey("acme.example.com", "1001")); ok {
		t.Error("the invalidated tenant's credential survived")
	}
	if _, ok := store.cached(lookupKey("acme.example.com", "9999")); ok {
		t.Error("the cached refusal survived")
	}
	if _, ok := store.cached(lookupKey("other.example.com", "2001")); !ok {
		t.Error("another tenant's credential was evicted; the event names one org")
	}
	if _, seen := store.lastRefresh[lookupKey("acme.example.com", "1001")]; seen {
		t.Error("the refresh bound must go with the entry, or the re-ask after the eviction is refused")
	}
	if dropped := store.EvictOrg("  "); dropped != 0 {
		t.Errorf("an empty orgId dropped %d entries; it must drop nothing", dropped)
	}
}

func TestAnInvalidationEventEvictsItsOrg(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	store := cachedStore(now)

	applyInvalidation(invalidationMessage(t, orgAcme), store, quietLogger())

	if _, ok := store.cached(lookupKey("acme.example.com", "1001")); ok {
		t.Error("credential.invalidated did not evict the org it named")
	}
	if _, ok := store.cached(lookupKey("other.example.com", "2001")); !ok {
		t.Error("credential.invalidated evicted an org it did not name")
	}
}

func TestUnusableProvisioningMessagesEvictNothing(t *testing.T) {
	subject, err := contract.ProvisionSubject(orgAcme)
	if err != nil {
		t.Fatalf("building the subject: %v", err)
	}
	otherSubject, err := contract.ProvisionSubject(orgOther)
	if err != nil {
		t.Fatalf("building the subject: %v", err)
	}
	good := invalidationMessage(t, orgAcme)

	cases := []struct {
		name string
		msg  *nats.Msg
	}{
		{"not JSON at all", &nats.Msg{Subject: subject, Data: []byte("{not json")}},
		{"an empty payload", &nats.Msg{Subject: subject, Data: nil}},
		{
			// The family carries provisioning records too; only the invalidation evicts.
			name: "another provisioning event",
			msg: &nats.Msg{Subject: subject, Data: []byte(
				`{"id":"a","at":"2026-01-01T00:00:00.000Z","orgId":"` + orgAcme + `","subject":"` +
					subject + `","type":"` + contract.EventTypeProvisionDeviceRendered +
					`","source":"api","data":{}}`)},
		},
		{
			// An envelope claiming one org, delivered on another's subject, would let one tenant's
			// write empty another tenant's cache.
			name: "an org that disagrees with its subject",
			msg:  &nats.Msg{Subject: otherSubject, Data: good.Data},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			store := cachedStore(time.Unix(1_800_000_000, 0))
			applyInvalidation(testCase.msg, store, quietLogger())
			if store.Len() != 4 {
				t.Errorf("cache holds %d entries, want all 4 — the message must be ignored", store.Len())
			}
		})
	}
}

// countingEvictor records the orgs it was asked to evict.
type countingEvictor struct {
	mu   sync.Mutex
	orgs []string
	seen chan struct{}
}

func newCountingEvictor() *countingEvictor {
	return &countingEvictor{seen: make(chan struct{}, 8)}
}

func (e *countingEvictor) EvictOrg(orgID string) int {
	e.mu.Lock()
	e.orgs = append(e.orgs, orgID)
	e.mu.Unlock()
	e.seen <- struct{}{}
	return 1
}

func (e *countingEvictor) evicted() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.orgs)
}

func (e *countingEvictor) waitForOne(t *testing.T) {
	t.Helper()
	select {
	case <-e.seen:
	case <-time.After(2 * time.Second):
		t.Fatal("no eviction arrived")
	}
}

func TestTheInvalidationWatchSurvivesTheSubscriptionEnding(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	evictor := newCountingEvictor()
	// One entry per subscription the watch opens: the channel it reads, and the way the test ends
	// the subscription from the server's side.
	type opened struct {
		messages chan *nats.Msg
		end      func()
	}
	subscriptions := make(chan opened, 4)

	subscribe := func() (*invalidationStream, error) {
		messages := make(chan *nats.Msg, 4)
		ended := make(chan struct{})
		subscriptions <- opened{messages: messages, end: func() { close(ended) }}
		return &invalidationStream{messages: messages, ended: ended, stop: func() {}}, nil
	}

	if err := watchInvalidations(ctx, subscribe, evictor, quietLogger()); err != nil {
		t.Fatalf("watchInvalidations: %v", err)
	}

	first := <-subscriptions
	first.messages <- invalidationMessage(t, orgAcme)
	evictor.waitForOne(t)

	first.end()

	// The re-subscribe waits out invalidationRetryMin, so this is the slow part of the test.
	var second opened
	select {
	case second = <-subscriptions:
	case <-time.After(10 * time.Second):
		t.Fatal("the watch did not re-subscribe after the subscription ended")
	}

	second.messages <- invalidationMessage(t, orgOther)
	evictor.waitForOne(t)

	if got := evictor.evicted(); len(got) != 2 || got[0] != orgAcme || got[1] != orgOther {
		t.Errorf("evicted = %v, want one eviction on each subscription", got)
	}
}

func TestTheInvalidationWatchStopsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())

	stopped := make(chan struct{})
	subscribe := func() (*invalidationStream, error) {
		return &invalidationStream{
			messages: make(chan *nats.Msg),
			ended:    make(chan struct{}),
			stop:     func() { close(stopped) },
		}, nil
	}
	if err := watchInvalidations(ctx, subscribe, newCountingEvictor(), quietLogger()); err != nil {
		t.Fatalf("watchInvalidations: %v", err)
	}

	cancel()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("a cancelled context must unsubscribe rather than leak the goroutine")
	}
}
