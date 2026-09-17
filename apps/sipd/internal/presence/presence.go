// Package presence is sipd's read-only view of the `presence` NATS KV bucket: the device state a
// busy-lamp key renders.
//
// apps/engine is the only writer; sipd only reads, on the hot path of a SUBSCRIBE and of every
// state-change NOTIFY. The bucket definition and key builder come from packages/events-go so the
// two processes cannot disagree about what they are talking to.
package presence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// State is one extension's presence, as the bucket holds it.
type State = contract.ExtensionPresence

// Change is one presence transition observed on the bucket.
//
// Deleted is distinct from a `down` state: the bucket's TTL makes an entry disappearing the normal
// end of an extension's activity, and treating a delete as "no news" would leave a lamp lit.
type Change struct {
	OrgID           string
	ExtensionNumber string
	State           State
	Deleted         bool
}

// Store is the presence source. An interface so the SUBSCRIBE handler's tests run without a broker.
//
// Implementations must be safe for concurrent use.
type Store interface {
	// Get reads one extension's presence. The second result is false when the key is absent, which
	// is a normal answer ("that extension has no channels") and not an error.
	Get(ctx context.Context, orgID, extensionNumber string) (State, bool, error)
	// Watch delivers every transition on the bucket until ctx is cancelled. The channel is closed
	// when the watch ends.
	Watch(ctx context.Context) (<-chan Change, error)
}

// NATSStore is the production Store, backed by the presence KV bucket.
type NATSStore struct {
	bucket jetstream.KeyValue
	log    *slog.Logger
}

var _ Store = (*NATSStore)(nil)

// Open binds to (creating if absent) the presence bucket described by packages/events-go.
//
// CreateOrUpdateKeyValue is idempotent, so sipd does not fail to start merely because the engine
// has not booted yet. Creating the bucket does not make sipd a writer: the NATS permission set
// grants it no publish on `$KV.presence.>`.
func Open(ctx context.Context, js jetstream.JetStream) (*NATSStore, error) {
	definition := contract.PresenceKV
	bucket, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:       definition.Name,
		Description:  definition.Description,
		TTL:          definition.TTL,
		History:      definition.History,
		Storage:      storageTypeFor(definition.Storage),
		MaxValueSize: definition.MaxValueSize,
		MaxBytes:     definition.MaxBytes,
		Replicas:     definition.NumReplicas,
	})
	if err != nil {
		return nil, fmt.Errorf("presence: opening the %s bucket: %w", definition.Name, err)
	}
	return &NATSStore{bucket: bucket}, nil
}

func storageTypeFor(storage contract.StorageType) jetstream.StorageType {
	if storage == contract.StorageMemory {
		return jetstream.MemoryStorage
	}
	return jetstream.FileStorage
}

// Get implements Store.
func (s *NATSStore) Get(ctx context.Context, orgID, extensionNumber string) (State, bool, error) {
	key, err := contract.PresenceKVKey(orgID, extensionNumber)
	if err != nil {
		return State{}, false, err
	}
	entry, err := s.bucket.Get(ctx, key)
	if errors.Is(err, jetstream.ErrKeyNotFound) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, fmt.Errorf("presence: reading %s: %w", key, err)
	}
	var state State
	if err := json.Unmarshal(entry.Value(), &state); err != nil {
		return State{}, false, fmt.Errorf("presence: decoding %s: %w", key, err)
	}
	return state, true, nil
}

// Watch implements Store over the WHOLE bucket, not one key per subscription: one consumer per
// instance plus an in-process fan-out, instead of one ordered consumer per BLF key.
//
// Updates only — initial values are read by Get when a subscription is accepted, and replaying the
// bucket on reconnect would send a redundant NOTIFY to every phone at once.
//
// The watch RE-ESTABLISHES itself when the update stream ends without the context being cancelled: a
// broker restart ends the ordered consumer ("stream not found: recreating ordered consumer"), and a
// watch that gave up there would freeze every busy lamp in the fleet for the life of the process.
// The returned channel STAYS OPEN across a re-establish and closes only when the watch is done for
// good — the SUBSCRIBE handler drops its reference on close, so a close is permanent deafness.
func (s *NATSStore) Watch(ctx context.Context) (<-chan Change, error) {
	updates, err := s.bucket.WatchAll(ctx, jetstream.UpdatesOnly())
	if err != nil {
		return nil, fmt.Errorf("presence: watching the %s bucket: %w", contract.PresenceKV.Name, err)
	}
	log := s.log
	if log == nil {
		log = slog.Default()
	}

	changes := make(chan Change, 64)
	go func() {
		defer close(changes)
		backoff := watchRetryMin
		for {
			ended := consume(ctx, updates, changes)
			_ = updates.Stop()
			if ctx.Err() != nil || !ended {
				return
			}
			log.Warn("the presence watch ended; re-establishing it",
				"bucket", contract.PresenceKV.Name, "retryIn", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, watchRetryMax)
			next, err := s.bucket.WatchAll(ctx, jetstream.UpdatesOnly())
			if err != nil {
				log.Error("cannot re-establish the presence watch",
					"bucket", contract.PresenceKV.Name, "error", err)
				continue
			}
			backoff = watchRetryMin
			updates = next
		}
	}()
	return changes, nil
}

// watchRetryMin and watchRetryMax bound the re-establish backoff. A broker that is down is down for
// everything, so the ceiling is short enough that lamps resume promptly once it returns.
const (
	watchRetryMin = time.Second
	watchRetryMax = 30 * time.Second
)

// consume drains one update stream into changes. It reports whether the stream ENDED (so a
// replacement is wanted) rather than the context being cancelled.
func consume(ctx context.Context, updates jetstream.KeyWatcher, changes chan<- Change) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case entry, ok := <-updates.Updates():
			if !ok {
				return true
			}
			if entry == nil {
				// The end-of-initial-values marker; nats.go sends one even with UpdatesOnly.
				continue
			}
			change, ok := changeFor(entry)
			if !ok {
				continue
			}
			select {
			case changes <- change:
			case <-ctx.Done():
				return false
			}
		}
	}
}

// changeFor turns one KV entry into a Change, reporting false for anything unusable.
//
// A value that will not decode is dropped rather than reported as `down`, so one malformed write
// cannot clear every lamp in a tenant.
func changeFor(entry jetstream.KeyValueEntry) (Change, bool) {
	orgID, extensionNumber, ok := splitKey(entry.Key())
	if !ok {
		return Change{}, false
	}
	switch entry.Operation() {
	case jetstream.KeyValueDelete, jetstream.KeyValuePurge:
		return Change{OrgID: orgID, ExtensionNumber: extensionNumber, Deleted: true}, true
	}
	var state State
	if err := json.Unmarshal(entry.Value(), &state); err != nil {
		return Change{}, false
	}
	return Change{OrgID: orgID, ExtensionNumber: extensionNumber, State: state}, true
}

// splitKey reverses contract.PresenceKVKey: `<orgId>.<extensionNumber>`.
//
// Both tokens are subject tokens and so contain no dot: any other shape is not a key this contract
// can produce and is skipped.
func splitKey(key string) (orgID, extensionNumber string, ok bool) {
	orgID, extensionNumber, found := strings.Cut(key, ".")
	if !found || orgID == "" || extensionNumber == "" || strings.Contains(extensionNumber, ".") {
		return "", "", false
	}
	return orgID, extensionNumber, true
}

// MemoryStore is an in-process Store backing the unit tests and broker-less development. It is not
// a deployment option: presence one instance invents is a lamp the rest of the fleet disagrees with.
type MemoryStore struct {
	mu      sync.RWMutex
	states  map[string]State
	changes chan Change
}

var _ Store = (*MemoryStore)(nil)

// NewMemoryStore returns an empty in-process store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{states: make(map[string]State), changes: make(chan Change, 64)}
}

// Set writes a state and publishes the change to whoever is watching.
func (s *MemoryStore) Set(state State) {
	key, err := contract.PresenceKVKey(state.OrgID, state.ExtensionNumber)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.states[key] = state
	s.mu.Unlock()

	select {
	case s.changes <- Change{OrgID: state.OrgID, ExtensionNumber: state.ExtensionNumber, State: state}:
	default:
	}
}

// Delete removes a state and publishes the deletion.
func (s *MemoryStore) Delete(orgID, extensionNumber string) {
	key, err := contract.PresenceKVKey(orgID, extensionNumber)
	if err != nil {
		return
	}
	s.mu.Lock()
	delete(s.states, key)
	s.mu.Unlock()

	select {
	case s.changes <- Change{OrgID: orgID, ExtensionNumber: extensionNumber, Deleted: true}:
	default:
	}
}

// Get implements Store.
func (s *MemoryStore) Get(_ context.Context, orgID, extensionNumber string) (State, bool, error) {
	key, err := contract.PresenceKVKey(orgID, extensionNumber)
	if err != nil {
		return State{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, found := s.states[key]
	return state, found, nil
}

// Watch implements Store.
func (s *MemoryStore) Watch(context.Context) (<-chan Change, error) { return s.changes, nil }
