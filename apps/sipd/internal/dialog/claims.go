package dialog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// NATSClaimStore is the production ClaimStore, backed by the `sip-dialogs` KV bucket.
//
// # What it is for, restated where the I/O is
//
// Not failover. A dialog's sockets, timers and CSeq are local to one process, so when a sipd dies
// its calls die with it and nothing can move them. What must not also die is the ENGINE's knowledge
// that they ended: without it the engine holds channels for calls that ended when a pod was
// rescheduled, and no CDR is ever written for any of them. This bucket is how a SURVIVOR learns
// enough to publish those terminations on the dead owner's behalf (design §6.2).
//
// # Why the record's own expiresAt and not the bucket's TTL
//
// `contract.SIPDialogsKV` has a six-hour TTL and that is a BACKSTOP, not the lease. Server-side
// expiry cannot tell "the owner stopped heartbeating" from "this was written a long time ago and is
// still correct" — a six-hour conference call is a real thing — so the lease is a field in the
// value, refreshed by the owner, and the reaper reads it. The TTL exists so a claim whose owner
// died and whose reaper also died does not sit in the bucket for ever.
//
// # Not organization-scoped
//
// The key is the leg id and nothing else: the reader that matters most is a surviving sipd sweeping
// a dead peer's claims, and it has neither the org nor any way to guess it. The org travels in the
// value. That is the same exception `did-index` and `media-sessions` take, and `SIPDialogKVKey`
// states the argument once so no call site has to.
type NATSClaimStore struct {
	bucket jetstream.KeyValue
}

var _ ClaimStore = (*NATSClaimStore)(nil)

// OpenClaims binds to (creating if absent) the `sip-dialogs` bucket described by packages/events-go.
//
// CreateOrUpdateKeyValue is idempotent, so every sipd instance can call it at boot: the first one
// creates the bucket, the rest bind to it. The configuration comes from the contract rather than
// from this file, for the reason internal/kv states — a bucket two services disagree about is a
// bucket one of them silently mis-reads.
func OpenClaims(ctx context.Context, js jetstream.JetStream) (*NATSClaimStore, error) {
	if js == nil {
		return nil, errors.New("dialog: a JetStream context is required for the sip-dialogs bucket")
	}
	definition := contract.SIPDialogsKV
	bucket, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:       definition.Name,
		Description:  definition.Description,
		TTL:          definition.TTL,
		History:      definition.History,
		Storage:      claimStorage(definition.Storage),
		MaxValueSize: definition.MaxValueSize,
		MaxBytes:     definition.MaxBytes,
		Replicas:     definition.NumReplicas,
	})
	if err != nil {
		return nil, fmt.Errorf("dialog: opening the %s bucket: %w", definition.Name, err)
	}
	return &NATSClaimStore{bucket: bucket}, nil
}

func claimStorage(storage contract.StorageType) jetstream.StorageType {
	if storage == contract.StorageMemory {
		return jetstream.MemoryStorage
	}
	return jetstream.FileStorage
}

// Put implements ClaimStore. It is the heartbeat as well as the create: one unconditional write,
// because the value carries a fresh expiresAt every time and a compare-and-set would buy nothing
// against a bucket with exactly one writer per key.
func (s *NATSClaimStore) Put(ctx context.Context, claim Claim) error {
	key, err := contract.SIPDialogKVKey(claim.LegID)
	if err != nil {
		return err
	}
	value, err := json.Marshal(claim)
	if err != nil {
		return fmt.Errorf("dialog: encoding claim %s: %w", key, err)
	}
	if _, err := s.bucket.Put(ctx, key, value); err != nil {
		return fmt.Errorf("dialog: writing claim %s: %w", key, err)
	}
	return nil
}

// Delete implements ClaimStore. Deleting an absent claim is not an error: teardown is idempotent,
// and a leg torn down twice — a BYE crossing our BYE — must not log a failure on the second pass.
func (s *NATSClaimStore) Delete(ctx context.Context, legID string) error {
	key, err := contract.SIPDialogKVKey(legID)
	if err != nil {
		return err
	}
	if err := s.bucket.Delete(ctx, key); err != nil && !errors.Is(err, jetstream.ErrKeyNotFound) {
		return fmt.Errorf("dialog: deleting claim %s: %w", key, err)
	}
	return nil
}

// All implements ClaimStore.
//
// Keys-then-get rather than a watch, and that is deliberate: this is the REAPER's input, it runs on
// a sweep interval measured in tens of seconds, and it is on no request path at all. A watch would
// hold a consumer open for a read that happens twice a minute, and the per-key get is what lets one
// unparseable value be skipped instead of poisoning the whole sweep — which is the difference
// between one call missing a CDR and every call on a dead instance missing one.
func (s *NATSClaimStore) All(ctx context.Context) ([]Claim, error) {
	keys, err := s.bucket.Keys(ctx)
	if errors.Is(err, jetstream.ErrNoKeysFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("dialog: listing claims: %w", err)
	}

	claims := make([]Claim, 0, len(keys))
	for _, key := range keys {
		entry, err := s.bucket.Get(ctx, key)
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			// Raced with a teardown that released the claim between the list and the get. Nothing to
			// reap: the owner is alive and did exactly the right thing.
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("dialog: reading claim %s: %w", key, err)
		}
		var claim Claim
		if err := json.Unmarshal(entry.Value(), &claim); err != nil {
			continue
		}
		if claim.LegID == "" {
			// A claim with no leg id cannot be reaped — there is nothing to publish a termination
			// for — and cannot be deleted safely either, because the key it is under may not be the
			// leg. Skipped rather than acted on.
			continue
		}
		claims = append(claims, claim)
	}
	sort.Slice(claims, func(i, j int) bool { return claims[i].LegID < claims[j].LegID })
	return claims, nil
}
