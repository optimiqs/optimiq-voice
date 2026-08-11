// Package presence is sipd's view of the `presence` NATS KV bucket: the device state a busy-lamp
// key renders.
//
// The bucket is written by apps/engine, which is the only process that can see a channel move
// between call states, and read here — on the hot path of a SUBSCRIBE and of every state-change
// NOTIFY. sipd never writes it: an edge that could publish presence could publish a lie about a
// tenant's phones, and it has nothing to base one on anyway.
//
// The bucket definition (name, TTL, storage, limits) and the key builder come from
// packages/events-go so sipd cannot disagree with the engine about what it is talking to.
package presence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// State is one extension's presence, as the bucket holds it.
type State = contract.ExtensionPresence

// Change is one presence transition observed on the bucket.
//
// Deleted is separate from a `down` value on purpose: the bucket's five-minute TTL means an entry
// disappearing is the normal end of an extension's activity, not an error, and a watcher that
// treated a delete as "no news" would leave a lamp lit after the last engine writing it stopped.
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
}

var _ Store = (*NATSStore)(nil)

// Open binds to (creating if absent) the presence bucket described by packages/events-go.
//
// CreateOrUpdateKeyValue rather than a read-only bind, for the same reason kv.Open uses it: the
// call is idempotent, and an edge that refused to start because the engine had not booted yet would
// turn a deploy ordering detail into a SIP outage. sipd creating the bucket does not make it a
// writer — the NATS permission set is what stops that, and it grants sipd no publish on
// `$KV.presence.>`.
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

// Watch implements Store over the whole bucket.
//
// The WHOLE bucket, not one key per subscription. A phone with sixteen BLF keys would otherwise
// open sixteen ordered consumers, and a fifty-phone office would open eight hundred — for a bucket
// whose entire contents fit in a few hundred kilobytes. One watch and an in-process fan-out costs
// one consumer per instance and makes the subscription table the only thing that has to know which
// extensions anyone cares about.
//
// Updates only: the initial values are read by Get when a subscription is accepted, and replaying
// the bucket on every reconnect would send a redundant NOTIFY to every phone at once.
func (s *NATSStore) Watch(ctx context.Context) (<-chan Change, error) {
	watcher, err := s.bucket.WatchAll(ctx, jetstream.UpdatesOnly())
	if err != nil {
		return nil, fmt.Errorf("presence: watching the %s bucket: %w", contract.PresenceKV.Name, err)
	}

	changes := make(chan Change, 64)
	go func() {
		defer close(changes)
		defer func() { _ = watcher.Stop() }()

		for {
			select {
			case <-ctx.Done():
				return
			case entry, ok := <-watcher.Updates():
				if !ok {
					return
				}
				if entry == nil {
					// The end-of-initial-values marker. Harmless with UpdatesOnly, but nats.go still
					// sends one and a nil dereference here would take the watch down.
					continue
				}
				change, ok := changeFor(entry)
				if !ok {
					continue
				}
				select {
				case changes <- change:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return changes, nil
}

// changeFor turns one KV entry into a Change, reporting false for anything unusable.
//
// A value that will not decode is DROPPED rather than reported as `down`: the alternative is one
// malformed write from a future engine release clearing every lamp in a tenant, which is a worse
// outcome than a lamp that does not move until the next good write.
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
// Both tokens are subject tokens and therefore contain no dot, so the split is exact rather than a
// best guess — a key with any other shape is not one this contract can produce and is skipped.
func splitKey(key string) (orgID, extensionNumber string, ok bool) {
	for index := 0; index < len(key); index++ {
		if key[index] != '.' {
			continue
		}
		if index == 0 || index == len(key)-1 {
			return "", "", false
		}
		orgID, extensionNumber = key[:index], key[index+1:]
		// A second dot means a key shape this contract does not define.
		for _, char := range extensionNumber {
			if char == '.' {
				return "", "", false
			}
		}
		return orgID, extensionNumber, true
	}
	return "", "", false
}

// MemoryStore is an in-process Store. It backs the unit tests and lets sipd run without a broker
// during development; it is NOT a deployment option, because presence one instance invented is a
// lamp the rest of the fleet does not agree with.
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
