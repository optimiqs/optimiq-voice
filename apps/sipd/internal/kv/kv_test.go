package kv_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

const (
	testOrg  = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testHash = "3f2a1b4c5d6e7f8091a2b3c4d5e6f708"
)

func sampleBinding(now time.Time, ttl time.Duration) kv.Binding {
	return kv.Binding{
		OrgID:            testOrg,
		AOR:              "sip:1001@acme.example.com",
		AORHash:          testHash,
		Contact:          "sip:1001@203.0.113.9:5060",
		Transport:        contract.SIPTransportUDP,
		RegisteredAt:     contract.NewEventTime(now),
		ExpiresAt:        contract.NewEventTime(now.Add(ttl)),
		ExpiresInSeconds: int(ttl / time.Second),
	}
}

func TestBindingKeyUsesTheSharedBuilder(t *testing.T) {
	binding := sampleBinding(time.Now(), time.Minute)
	key, err := binding.Key()
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	want, err := contract.RegistrationKVKey(testOrg, testHash)
	if err != nil {
		t.Fatal(err)
	}
	if key != want {
		t.Errorf("Key = %q, want the contract's %q", key, want)
	}

	// A binding whose org is not a subject token must not silently produce a key: it would land in
	// another tenant's namespace or corrupt the bucket's key space.
	bad := binding
	bad.OrgID = "org id"
	if _, err := bad.Key(); err == nil {
		t.Error("Key accepted a non-token orgId")
	}
}

func TestBindingExpiryHelpers(t *testing.T) {
	now := time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)
	binding := sampleBinding(now, 60*time.Second)

	if binding.Expired(now.Add(59 * time.Second)) {
		t.Error("a binding must not expire before its deadline")
	}
	// The deadline itself is expired: at t+60 a 60-second registration is over.
	if !binding.Expired(now.Add(60 * time.Second)) {
		t.Error("a binding must expire at its deadline, not after it")
	}
	if got := binding.RegisteredFor(now.Add(61 * time.Second)); got != 61*time.Second {
		t.Errorf("RegisteredFor = %s, want 61s", got)
	}
	if got := binding.RegisteredFor(now.Add(-time.Second)); got != 0 {
		t.Errorf("RegisteredFor = %s, want 0 for an instant before registration", got)
	}
}

func TestBindingRoundTripsThroughJSON(t *testing.T) {
	now := time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)
	binding := sampleBinding(now, 300*time.Second)
	binding.UserAgent = "Yealink SIP-T46U"
	binding.CallID = "3c26700c1adf"
	binding.CSeq = 7

	encoded, err := json.Marshal(binding)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded kv.Binding
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !decoded.ExpiresAt.Time.Equal(binding.ExpiresAt.Time) {
		t.Errorf("ExpiresAt = %s, want %s", decoded.ExpiresAt.Time, binding.ExpiresAt.Time)
	}
	if decoded.CSeq != 7 || decoded.CallID != "3c26700c1adf" {
		t.Errorf("decoded = %+v", decoded)
	}
}

func TestMemoryStore(t *testing.T) {
	ctx := context.Background()
	store := kv.NewMemoryStore()
	binding := sampleBinding(time.Now(), time.Minute)

	if _, found, err := store.Get(ctx, testOrg, testHash); err != nil || found {
		t.Fatalf("Get on an empty store = found %v, err %v", found, err)
	}

	if err := store.Put(ctx, binding); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, found, err := store.Get(ctx, testOrg, testHash)
	if err != nil || !found {
		t.Fatalf("Get = found %v, err %v", found, err)
	}
	if got.Contact != binding.Contact {
		t.Errorf("Contact = %q", got.Contact)
	}

	all, err := store.All(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("All = %d bindings, err %v", len(all), err)
	}

	if err := store.Delete(ctx, testOrg, testHash); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, found, _ := store.Get(ctx, testOrg, testHash); found {
		t.Error("the binding survived Delete")
	}
	// De-registration is idempotent, so deleting an absent key is not an error.
	if err := store.Delete(ctx, testOrg, testHash); err != nil {
		t.Errorf("a repeated Delete returned %v", err)
	}
}
