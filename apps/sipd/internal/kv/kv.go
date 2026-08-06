// Package kv is sipd's view of the `registrations` NATS KV bucket: the location service.
//
// The bucket is the AUTHORITY for "who is registered right now" (plan §3.5). The REGISTRATIONS
// JetStream stream is the transition log behind it, not the truth — a consumer that needs to route
// a call to a device reads here.
//
// The bucket definition (name, TTL, storage, limits) comes from packages/events-go so sipd cannot
// disagree with the TypeScript services about what it is talking to.
package kv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Binding is one AOR → contact binding, as stored in the bucket.
//
// The value is deliberately richer than the registration EVENT payload: an event describes a
// transition and is consumed once, whereas this record has to answer "where do I send an INVITE
// for this AOR, and until when" long after the REGISTER is forgotten.
type Binding struct {
	OrgID   string `json:"orgId"`
	AOR     string `json:"aor"`
	AORHash string `json:"aorHash"`
	// Contact is the URI exactly as the device offered it, parameters included. Rewriting it is
	// the proxy's job at INVITE time, not the registrar's at REGISTER time.
	Contact   string                `json:"contact"`
	Transport contract.SIPTransport `json:"transport"`
	UserAgent string                `json:"userAgent,omitempty"`
	// SourceAddress is the signalling peer, host:port, as observed. For a device behind NAT this is
	// the only address that works, and it is why a binding is worth more than the Contact alone.
	SourceAddress string `json:"sourceAddress,omitempty"`
	DeviceID      string `json:"deviceId,omitempty"`
	ExtensionID   string `json:"extensionId,omitempty"`
	// CallID and CSeq identify the registration dialog, so a retransmission or an out-of-order
	// REGISTER can be recognised (RFC 3261 §10.3 step 6).
	CallID string `json:"callId,omitempty"`
	CSeq   uint32 `json:"cseq,omitempty"`
	// Instance is the device's +sip.instance value when it supplies one (RFC 5626 outbound).
	Instance string `json:"instance,omitempty"`

	RegisteredAt contract.EventTime `json:"registeredAt"`
	ExpiresAt    contract.EventTime `json:"expiresAt"`
	// ExpiresInSeconds is the interval GRANTED, which is not always the one requested.
	ExpiresInSeconds int `json:"expiresInSeconds"`
}

// Key returns the bucket key for the binding, <orgId>.<aorHash>, via the shared builder.
func (b Binding) Key() (string, error) {
	return contract.RegistrationKVKey(b.OrgID, b.AORHash)
}

// Expired reports whether the binding's granted interval has lapsed at the given instant.
func (b Binding) Expired(now time.Time) bool {
	return !now.Before(b.ExpiresAt.Time)
}

// RegisteredFor returns how long the binding had been in place at the given instant, never
// negative. It fills the `registeredForSeconds` field of an `expired` event.
func (b Binding) RegisteredFor(now time.Time) time.Duration {
	if now.Before(b.RegisteredAt.Time) {
		return 0
	}
	return now.Sub(b.RegisteredAt.Time)
}

// Store is the location service sipd writes bindings to.
//
// Implementations must be safe for concurrent use.
type Store interface {
	Put(ctx context.Context, binding Binding) error
	Get(ctx context.Context, orgID, aorHash string) (Binding, bool, error)
	Delete(ctx context.Context, orgID, aorHash string) error
	// All returns every binding in the bucket. Used once at boot to adopt bindings a previous
	// instance granted; it is not on any request path.
	All(ctx context.Context) ([]Binding, error)
}

// NATSStore is the production Store, backed by the registrations KV bucket.
type NATSStore struct {
	bucket jetstream.KeyValue
}

var _ Store = (*NATSStore)(nil)

// Open binds to (creating if absent) the registrations bucket described by packages/events-go.
//
// CreateOrUpdateKeyValue is idempotent, so every sipd instance can call it at boot: the first one
// creates the bucket, the rest bind to it.
func Open(ctx context.Context, js jetstream.JetStream) (*NATSStore, error) {
	definition := contract.RegistrationsKV
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
		return nil, fmt.Errorf("kv: opening the %s bucket: %w", definition.Name, err)
	}
	return &NATSStore{bucket: bucket}, nil
}

func storageTypeFor(storage contract.StorageType) jetstream.StorageType {
	if storage == contract.StorageMemory {
		return jetstream.MemoryStorage
	}
	return jetstream.FileStorage
}

// Put writes (or overwrites) a binding.
func (s *NATSStore) Put(ctx context.Context, binding Binding) error {
	key, err := binding.Key()
	if err != nil {
		return err
	}
	value, err := json.Marshal(binding)
	if err != nil {
		return fmt.Errorf("kv: encoding binding %s: %w", key, err)
	}
	if _, err := s.bucket.Put(ctx, key, value); err != nil {
		return fmt.Errorf("kv: writing binding %s: %w", key, err)
	}
	return nil
}

// Get reads a binding. The second result is false when the key is absent, which is a normal
// answer ("that device is not registered"), not an error.
func (s *NATSStore) Get(ctx context.Context, orgID, aorHash string) (Binding, bool, error) {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return Binding{}, false, err
	}
	entry, err := s.bucket.Get(ctx, key)
	if errors.Is(err, jetstream.ErrKeyNotFound) {
		return Binding{}, false, nil
	}
	if err != nil {
		return Binding{}, false, fmt.Errorf("kv: reading binding %s: %w", key, err)
	}
	var binding Binding
	if err := json.Unmarshal(entry.Value(), &binding); err != nil {
		return Binding{}, false, fmt.Errorf("kv: decoding binding %s: %w", key, err)
	}
	return binding, true, nil
}

// Delete removes a binding. Deleting an absent key is not an error: de-registration is idempotent
// and a device may send Expires: 0 twice.
func (s *NATSStore) Delete(ctx context.Context, orgID, aorHash string) error {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return err
	}
	if err := s.bucket.Delete(ctx, key); err != nil && !errors.Is(err, jetstream.ErrKeyNotFound) {
		return fmt.Errorf("kv: deleting binding %s: %w", key, err)
	}
	return nil
}

// All lists every binding in the bucket.
func (s *NATSStore) All(ctx context.Context) ([]Binding, error) {
	keys, err := s.bucket.Keys(ctx)
	if errors.Is(err, jetstream.ErrNoKeysFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("kv: listing bindings: %w", err)
	}

	bindings := make([]Binding, 0, len(keys))
	for _, key := range keys {
		entry, err := s.bucket.Get(ctx, key)
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			continue // raced with an expiry or a de-registration; nothing to adopt
		}
		if err != nil {
			return nil, fmt.Errorf("kv: reading binding %s: %w", key, err)
		}
		var binding Binding
		if err := json.Unmarshal(entry.Value(), &binding); err != nil {
			// One poisoned value must not stop a boot from adopting the rest.
			continue
		}
		bindings = append(bindings, binding)
	}
	return bindings, nil
}

// MemoryStore is an in-process Store. It backs the unit tests and lets sipd run without a broker
// during development; it is NOT a deployment option, because a binding only one instance knows
// about is a call the rest of the fleet cannot deliver.
type MemoryStore struct {
	mu       sync.RWMutex
	bindings map[string]Binding
}

var _ Store = (*MemoryStore)(nil)

// NewMemoryStore returns an empty in-process store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{bindings: make(map[string]Binding)}
}

// Put implements Store.
func (s *MemoryStore) Put(_ context.Context, binding Binding) error {
	key, err := binding.Key()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bindings[key] = binding
	return nil
}

// Get implements Store.
func (s *MemoryStore) Get(_ context.Context, orgID, aorHash string) (Binding, bool, error) {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return Binding{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	binding, found := s.bindings[key]
	return binding, found, nil
}

// Delete implements Store.
func (s *MemoryStore) Delete(_ context.Context, orgID, aorHash string) error {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bindings, key)
	return nil
}

// All implements Store, in key order so tests are deterministic.
func (s *MemoryStore) All(_ context.Context) ([]Binding, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0, len(s.bindings))
	for key := range s.bindings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	bindings := make([]Binding, 0, len(keys))
	for _, key := range keys {
		bindings = append(bindings, s.bindings[key])
	}
	return bindings, nil
}
