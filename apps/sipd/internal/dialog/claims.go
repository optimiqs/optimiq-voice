package dialog

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// NATSClaimStore is the production ClaimStore, backed by the `sip-dialogs` KV bucket. It exists so
// a SURVIVING sipd can publish terminations on behalf of a dead owner (design §6.2), not for
// failover: sockets, timers and CSeq are local to one process.
//
// The lease is the record's own expiresAt, refreshed by the owner, not the bucket TTL: server-side
// expiry cannot tell a stalled owner from a long-lived call. Keys are the leg id alone and carry no
// org, because a sweeper of a dead peer's claims has no way to guess one.
type NATSClaimStore struct {
	bucket jetstream.KeyValue
}

var _ ClaimStore = (*NATSClaimStore)(nil)

// OpenClaims binds to (creating if absent) the `sip-dialogs` bucket described by packages/events-go.
// It is idempotent, so every sipd instance may call it at boot; the configuration comes from the
// contract so two services cannot disagree about the bucket's shape.
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
// since the value carries a fresh expiresAt and each key has exactly one writer.
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
// Keys-then-get rather than a watch: this is the reaper's input on a sweep measured in tens of
// seconds, and the per-key get lets one unparseable value be skipped instead of poisoning the
// whole sweep.
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
	slices.SortFunc(claims, func(a, b Claim) int { return cmp.Compare(a.LegID, b.LegID) })
	return claims, nil
}
