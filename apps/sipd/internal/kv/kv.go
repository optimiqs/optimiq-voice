// Package kv is sipd's view of the `registrations` NATS KV bucket: the location service.
//
// The bucket is the authority for who is registered right now; the REGISTRATIONS JetStream stream
// is the transition log behind it, not the truth. The bucket definition comes from
// packages/events-go so sipd cannot disagree with the TypeScript services about it.
package kv

import (
	"bytes"
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

// Binding is one AOR to contact binding, as stored in the bucket. It is richer than the
// registration event payload, which describes a transition; this record has to answer where to send
// an INVITE for the AOR, and until when.
type Binding struct {
	Revision       uint64 `json:"-"`
	SIPDInstanceID string `json:"sipdInstanceId,omitempty"`
	OrgID          string `json:"orgId"`
	AOR            string `json:"aor"`
	AORHash        string `json:"aorHash"`
	// Contact is the URI exactly as the device offered it, parameters included. Rewriting it is
	// the proxy's job at INVITE time, not the registrar's at REGISTER time.
	Contact   string                `json:"contact"`
	Transport contract.SIPTransport `json:"transport"`
	UserAgent string                `json:"userAgent,omitempty"`
	// SourceAddress is the signalling peer, host:port, as observed. For a device behind NAT it is
	// the only address that works.
	SourceAddress string `json:"sourceAddress,omitempty"`
	DeviceID      string `json:"deviceId,omitempty"`
	ExtensionID   string `json:"extensionId,omitempty"`
	// SharedLineNumber and AppearanceIndex place this AOR on a shared line appearance, when it has
	// one, so the INVITE path can stamp a `Call-Info` appearance-index header on the outbound
	// request. Nil for an ordinary extension.
	SharedLineNumber *string `json:"sharedLineNumber,omitempty"`
	AppearanceIndex  *int    `json:"appearanceIndex,omitempty"`
	// CallID and CSeq identify the registration dialog, so a retransmission or an out-of-order
	// REGISTER can be recognised (RFC 3261 §10.3 step 6).
	CallID string `json:"callId,omitempty"`
	CSeq   uint32 `json:"cseq,omitempty"`
	// Instance is the device's +sip.instance value when it supplies one (RFC 5626 outbound).
	Instance string `json:"instance,omitempty"`

	RegisteredAt contract.EventTime `json:"registeredAt"`
	ExpiresAt    contract.EventTime `json:"expiresAt"`
	// ExpiresInSeconds is the interval granted, which is not always the one requested.
	ExpiresInSeconds int `json:"expiresInSeconds"`

	// Contacts is every live contact for this AOR, when there is more than one device.
	//
	// It is additive: the flat Contact/Transport/SourceAddress fields above remain and describe the
	// primary contact, so a reader that does not know this field still sees a registered device.
	// aor.ApplyToBinding writes both from one Set with the primary at Contacts[0], so they cannot
	// disagree; readers should trust the flat fields.
	Contacts []Contact `json:"contacts,omitempty"`
}

// Contact is one device bound to an address of record, as the bucket holds it.
//
// The JSON tags match `registrationBindingSchema.contacts`' element for the six fields that schema
// names and carry four more (q, regId, callId, cseq) that the loose element schema permits; those
// four preserve the RFC 3261 §16.6 preference and the §10.3 step 6 ordering check on round-trip.
//
// It lives here rather than in internal/aor because internal/aor imports this package.
type Contact struct {
	SIPDInstanceID string `json:"sipdInstanceId,omitempty"`
	// URI is the contact exactly as the device offered it, parameters included. Not routable on its
	// own: a device behind NAT advertises a private address here, which is what SourceAddress is for.
	URI       string                `json:"contact"`
	Transport contract.SIPTransport `json:"transport"`
	UserAgent string                `json:"userAgent,omitempty"`
	// SourceAddress is the observed signalling peer, host:port. The address that actually works.
	SourceAddress string `json:"sourceAddress,omitempty"`
	DeviceID      string `json:"deviceId,omitempty"`
	// SharedLineNumber and AppearanceIndex place this contact on a shared line appearance, when it
	// has one. Nil for an ordinary contact.
	SharedLineNumber *string `json:"sharedLineNumber,omitempty"`
	AppearanceIndex  *int    `json:"appearanceIndex,omitempty"`
	// Instance is the device's `+sip.instance` (RFC 5626): the only device identity that survives a
	// changed port, and therefore the one a `{kind:"aor"}` originate should name.
	Instance string `json:"instance,omitempty"`
	// RegID is the RFC 5626 `reg-id`: one device with two flows registers twice with the same
	// instance and different reg-ids, and both are legitimately live.
	RegID int `json:"regId,omitempty"`
	// Q is the RFC 3261 §20.10 preference, higher first.
	Q float64 `json:"q,omitempty"`
	// CallID and CSeq identify this contact's registration dialog.
	CallID string `json:"callId,omitempty"`
	CSeq   uint32 `json:"cseq,omitempty"`

	RegisteredAt contract.EventTime `json:"registeredAt"`
	ExpiresAt    contract.EventTime `json:"expiresAt"`
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
	// Update atomically changes one AOR. The callback may run repeatedly on CAS conflicts and must
	// have no side effects. Returning nil deletes the binding. Results are the committed
	// before/after values; nil denotes absence.
	Update(ctx context.Context, orgID, aorHash string, change func(*Binding) (*Binding, error)) (*Binding, *Binding, error)
	Put(ctx context.Context, binding Binding) error
	Get(ctx context.Context, orgID, aorHash string) (Binding, bool, error)
	Delete(ctx context.Context, orgID, aorHash string) error
	// All returns every binding in the bucket. Used once at boot; not on any request path.
	All(ctx context.Context) ([]Binding, error)
}

var ErrConcurrentUpdate = errors.New("kv: registration changed too often to update")

// Hint supplies a caller's last-known value for an AOR, so Update can skip its read. A re-REGISTER
// is the commonest write, and without this each one spends two broker round trips inside the SIP
// transaction to read back a value this process wrote itself.
//
// It is only ever a hint: a stale revision is rejected by the server exactly as a lost race would
// be, and the retry reads the real value. Absent or wrong costs a round trip, never correctness.
type Hint interface {
	// LastKnown returns the caller's copy of the binding under this key, if it has one. The
	// returned Binding's Revision must be the revision that copy was read or written at.
	LastKnown(orgID, aorHash string) (Binding, bool)
}

// SetHint attaches a Hint. Not safe for concurrent use with Update; call it once at wiring time.
func (s *NATSStore) SetHint(hint Hint) { s.hint = hint }

func (s *NATSStore) Update(ctx context.Context, orgID, aorHash string, change func(*Binding) (*Binding, error)) (*Binding, *Binding, error) {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return nil, nil, err
	}
	// hinted is the guess for the first attempt only. Every retry reads, so a wrong hint costs one
	// wasted CAS and never a loop.
	var hinted *Binding
	if s.hint != nil {
		if binding, found := s.hint.LastKnown(orgID, aorHash); found && binding.Revision > 0 {
			hinted = &binding
		}
	}
	for attempt := range 16 {
		var previous *Binding
		var revision uint64
		var stored []byte
		switch {
		case attempt == 0 && hinted != nil:
			previous, revision = hinted, hinted.Revision
		default:
			entry, err := s.bucket.Get(ctx, key)
			if err == nil {
				previous = &Binding{}
				if err := json.Unmarshal(entry.Value(), previous); err != nil {
					return nil, nil, err
				}
				revision = entry.Revision()
				previous.Revision = revision
				stored = entry.Value()
			} else if !errors.Is(err, jetstream.ErrKeyNotFound) && !errors.Is(err, jetstream.ErrKeyDeleted) {
				return nil, nil, err
			}
		}
		next, err := change(previous)
		if err != nil {
			return nil, nil, err
		}
		if previous == nil && next == nil {
			return nil, nil, nil
		}
		if next == nil {
			err = s.bucket.Delete(ctx, key, jetstream.LastRevision(revision))
		} else {
			if next.OrgID != orgID || next.AORHash != aorHash {
				return nil, nil, errors.New("kv: registration update changed its key")
			}
			value, marshalErr := json.Marshal(next)
			if marshalErr != nil {
				return nil, nil, marshalErr
			}
			// The no-op short circuit needs the bytes actually in the bucket, so it applies only when
			// this attempt read them; a hint is a local copy and equal bytes do not prove the server
			// agrees.
			if stored != nil && bytes.Equal(value, stored) {
				return previous, next, nil
			}
			if revision == 0 {
				next.Revision, err = s.bucket.Create(ctx, key, value)
			} else {
				next.Revision, err = s.bucket.Update(ctx, key, value, revision)
			}
		}
		if err == nil {
			return previous, next, nil
		}
		if !errors.Is(err, jetstream.ErrKeyExists) && !errors.Is(err, jetstream.ErrKeyNotFound) &&
			!isWrongLastSequence(err) {
			return nil, nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
	}
	return nil, nil, ErrConcurrentUpdate
}

// isWrongLastSequence reports a rejected CAS: the revision the write named is not the current one.
// It is the retryable case, and jetstream surfaces it as an APIError with
// ErrCodeStreamWrongLastSequence, which neither ErrKeyExists nor ErrKeyNotFound matches.
func isWrongLastSequence(err error) bool {
	apiError, ok := errors.AsType[*jetstream.APIError](err)
	return ok && apiError.ErrorCode == jetstream.JSErrCodeStreamWrongLastSequence
}

// NATSStore is the production Store, backed by the registrations KV bucket.
type NATSStore struct {
	bucket jetstream.KeyValue
	// hint is the optional last-known-value source; see Hint. Nil means every Update reads first.
	hint Hint
}

var _ Store = (*NATSStore)(nil)

// Open binds to (creating if absent) the registrations bucket described by packages/events-go. It is
// idempotent, so every sipd instance can call it at boot.
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

// Get reads a binding. The second result is false when the key is absent, which is a normal answer
// rather than an error.
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
	binding.Revision = entry.Revision()
	return binding, true, nil
}

// Delete removes a binding. Deleting an absent key is not an error; de-registration is idempotent.
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
		binding.Revision = entry.Revision()
		bindings = append(bindings, binding)
	}
	return bindings, nil
}

// MemoryStore is an in-process Store for tests and broker-less development. It is not a deployment
// option: a binding only one instance knows about is a call the rest of the fleet cannot deliver.
type MemoryStore struct {
	revision uint64
	mu       sync.RWMutex
	bindings map[string]Binding
	// updates counts Update calls, so a test can assert a sweep spent no round trip on a binding
	// nowhere near its deadline.
	updates int
}

var _ Store = (*MemoryStore)(nil)

// NewMemoryStore returns an empty in-process store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{bindings: make(map[string]Binding)}
}

func (s *MemoryStore) Update(_ context.Context, orgID, aorHash string, change func(*Binding) (*Binding, error)) (*Binding, *Binding, error) {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updates++
	var previous *Binding
	if value, found := s.bindings[key]; found {
		previous = &value
	}
	next, err := change(previous)
	if err != nil {
		return nil, nil, err
	}
	if next == nil {
		delete(s.bindings, key)
	} else {
		if next.OrgID != orgID || next.AORHash != aorHash {
			return nil, nil, errors.New("kv: registration update changed its key")
		}
		s.revision++
		next.Revision = s.revision
		s.bindings[key] = *next
	}
	return previous, next, nil
}

// Updates reports how many Update calls this store has served.
func (s *MemoryStore) Updates() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.updates
}

// Put implements Store.
func (s *MemoryStore) Put(_ context.Context, binding Binding) error {
	key, err := binding.Key()
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revision++
	binding.Revision = s.revision
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
