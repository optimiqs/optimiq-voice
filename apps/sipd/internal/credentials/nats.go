package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// NATSStore resolves credentials over NATS request-reply against apps/api.
//
// # The contract
//
// `rpc.sip.v1.credential`, defined in packages/events (`src/schemas/rpc.ts`) and generated into
// packages/events-go as SipCredentialRequest / SipCredentialResponse. NATS core request-reply,
// never JetStream: this is a synchronous question inside a REGISTER transaction, and a persisted
// stream would be storage for a message whose answer is worthless a second later.
//
// This is the ONLY rpc.* subject whose request carries no orgId. Every other one is called by a
// process that already knows its tenant; here, resolving the tenant is the entire question. sipd
// holds no database handle and must not grow one — extension rows are pbx-db, which apps/api owns
// — so all it can send is what the phone put on the wire.
//
// # Why the reply is an HA1 and not a password
//
// The password a provisioned phone holds is derived: hmac-sha256(rootKey, "<orgId>:<secretRef>").
// sipd could run that derivation itself — derive.go is a byte-exact port and proves it — but that
// would require the root key on the SIP edge. The edge is the process most exposed to the
// internet, and the root key derives EVERY tenant's password, so its compromise would be a total
// credential compromise rather than the loss of whatever is registered here. The API derives, and
// ships MD5(username:realm:password), which is what RFC 2617 verification actually consumes.
//
// # Caching, and why the negative half matters more than the positive half
//
// Every device re-REGISTERs on its expiry interval — 300 s by default, and a thousand phones is
// then a steady three requests a second that all have the same answer. That is the positive
// cache's job.
//
// The negative cache is the one that protects the API. A scanner walking usernames against an open
// SIP port generates a miss per attempt, and without a negative cache each miss is a database
// query. Both TTLs are short (seconds), because the alternative to staleness here is an account
// that was disabled minutes ago still registering.
//
// The cache is bounded. An unbounded negative cache keyed on an attacker-chosen username is a
// memory amplifier: the scanner above would otherwise cost the registrar one map entry per guess.
//
// # Fail-closed
//
// A timeout, a transport error, a malformed reply, a reply whose realm or username does not match
// what was asked, or a reply that claims `found` without a usable HA1 — all return an error, and
// the registrar turns any error into 403. There is deliberately no "allow on failure" mode and no
// stale-while-revalidate: a registrar that authenticates when it cannot check is worse than one
// that is briefly unavailable. Failures are NOT cached, so recovery is immediate.
type NATSStore struct {
	conn    *nats.Conn
	subject string
	timeout time.Duration

	positiveTTL time.Duration
	negativeTTL time.Duration
	maxEntries  int

	// now is swapped in tests so TTL behaviour is asserted without sleeping.
	now func() time.Time

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	credential Credential
	// err is ErrNotFound or ErrDisabled for a cached refusal, nil for a cached credential.
	// Transport failures are never stored.
	err     error
	expires time.Time
}

// NATSOptions configures a NATSStore. Every field has a working default.
type NATSOptions struct {
	// Subject overrides the contract subject. Only tests should set it.
	Subject string
	// Timeout is the per-request deadline. Defaults to the contract's own TimeoutSipCredentialRPC.
	Timeout time.Duration
	// PositiveTTL is how long a resolved credential is reused.
	PositiveTTL time.Duration
	// NegativeTTL is how long an unknown/disabled answer is reused.
	NegativeTTL time.Duration
	// MaxEntries bounds the cache. Zero means the default.
	MaxEntries int
	// Now is the clock, for tests.
	Now func() time.Time
}

const (
	defaultPositiveTTL = 30 * time.Second
	defaultNegativeTTL = 10 * time.Second
	defaultMaxEntries  = 10_000
)

// ErrLookupFailed wraps every transport-level failure so a caller can distinguish "the answer is
// no" (ErrNotFound / ErrDisabled) from "there was no answer". The registrar refuses either way;
// the distinction is what the logs and any future health signal need.
var ErrLookupFailed = errors.New("credentials: credential lookup failed")

// NewNATSStore builds the store. A nil connection is a programming error rather than a runtime
// state, so it is refused here instead of on the first REGISTER.
func NewNATSStore(conn *nats.Conn, opts NATSOptions) (*NATSStore, error) {
	if conn == nil {
		return nil, errors.New("credentials: a NATS connection is required for the credential RPC")
	}

	store := &NATSStore{
		conn:        conn,
		subject:     opts.Subject,
		timeout:     opts.Timeout,
		positiveTTL: opts.PositiveTTL,
		negativeTTL: opts.NegativeTTL,
		maxEntries:  opts.MaxEntries,
		now:         opts.Now,
		cache:       make(map[string]cacheEntry),
	}
	if store.subject == "" {
		store.subject = contract.SubjectSipCredentialRPC
	}
	if store.timeout <= 0 {
		store.timeout = contract.TimeoutSipCredentialRPC
	}
	if store.positiveTTL <= 0 {
		store.positiveTTL = defaultPositiveTTL
	}
	if store.negativeTTL <= 0 {
		store.negativeTTL = defaultNegativeTTL
	}
	if store.maxEntries <= 0 {
		store.maxEntries = defaultMaxEntries
	}
	if store.now == nil {
		store.now = time.Now
	}
	return store, nil
}

// Lookup implements Store.
func (s *NATSStore) Lookup(ctx context.Context, realm, username string) (Credential, error) {
	key := lookupKey(realm, username)

	if entry, ok := s.cached(key); ok {
		return entry.credential, entry.err
	}

	credential, err := s.request(ctx, realm, username)
	switch {
	case err == nil:
		s.store(key, cacheEntry{credential: credential, expires: s.now().Add(s.positiveTTL)})
		return credential, nil
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrDisabled):
		// A definite "no" is cacheable; that is the whole point of the negative half.
		s.store(key, cacheEntry{err: err, expires: s.now().Add(s.negativeTTL)})
		return Credential{}, err
	default:
		// Transport failures are never cached: caching them would extend an outage past its cause.
		return Credential{}, err
	}
}

func (s *NATSStore) request(ctx context.Context, realm, username string) (Credential, error) {
	payload, err := json.Marshal(contract.SipCredentialRequest{
		Realm:    realm,
		Username: username,
	})
	if err != nil {
		return Credential{}, fmt.Errorf("%w: encoding the request: %w", ErrLookupFailed, err)
	}

	// The deadline is the smaller of the contract timeout and whatever the caller's context has
	// left, so a handler that is already nearly out of time does not start a fresh 500 ms wait.
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	message, err := s.conn.RequestWithContext(ctx, s.subject, payload)
	if err != nil {
		return Credential{}, fmt.Errorf("%w: %s: %w", ErrLookupFailed, s.subject, err)
	}

	var reply contract.SipCredentialResponse
	if err := json.Unmarshal(message.Data, &reply); err != nil {
		return Credential{}, fmt.Errorf("%w: malformed reply on %s: %w", ErrLookupFailed, s.subject, err)
	}

	return credentialFromReply(realm, username, reply)
}

// credentialFromReply turns a well-formed reply into a Credential, or into the refusal it encodes.
//
// It re-checks the realm and username the responder echoed. Not because the responder is expected
// to lie, but because HA1 is computed over exactly those two strings plus the password: an answer
// for a different account would verify against a digest response the phone never computed, and the
// symptom would be an authentication failure nobody could explain. Comparing here makes a
// responder bug a loud refusal instead.
func credentialFromReply(realm, username string, reply contract.SipCredentialResponse) (Credential, error) {
	if !reply.Found {
		return Credential{}, ErrNotFound
	}
	if !reply.Enabled {
		return Credential{}, ErrDisabled
	}

	if reply.Ha1 == nil || reply.OrgID == nil {
		return Credential{}, fmt.Errorf(
			"%w: the responder reported a usable account for %q with no ha1 or no orgId",
			ErrLookupFailed, username)
	}

	if reply.Realm != nil && !strings.EqualFold(strings.TrimSpace(*reply.Realm), strings.TrimSpace(realm)) {
		return Credential{}, fmt.Errorf("%w: asked for realm %q, answered for %q",
			ErrLookupFailed, realm, *reply.Realm)
	}
	if reply.Username != nil && strings.TrimSpace(*reply.Username) != strings.TrimSpace(username) {
		return Credential{}, fmt.Errorf("%w: asked for user %q, answered for %q",
			ErrLookupFailed, username, *reply.Username)
	}

	credential := Credential{
		OrgID:            *reply.OrgID,
		Username:         username,
		Realm:            realm,
		HA1:              strings.ToLower(strings.TrimSpace(*reply.Ha1)),
		DeviceID:         optional(reply.DeviceID),
		ExtensionID:      optional(reply.ExtensionID),
		SharedLineNumber: reply.SharedLineNumber,
		AppearanceIndex:  reply.AppearanceIndex,
	}
	if err := credential.Validate(); err != nil {
		return Credential{}, fmt.Errorf("%w: %w", ErrLookupFailed, err)
	}
	return credential, nil
}

func optional(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *NATSStore) cached(key string) (cacheEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.cache[key]
	if !ok {
		return cacheEntry{}, false
	}
	if !s.now().Before(entry.expires) {
		delete(s.cache, key)
		return cacheEntry{}, false
	}
	return entry, true
}

func (s *NATSStore) store(key string, entry cacheEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.cache) >= s.maxEntries {
		s.evictLocked()
	}
	s.cache[key] = entry
}

// evictLocked drops expired entries, and if that frees nothing, drops an arbitrary one.
//
// Not an LRU. An LRU's bookkeeping would be a second data structure protected by the same mutex on
// the REGISTER path, and the cache is a load shedder rather than a correctness mechanism — an
// eviction costs one extra request, which is exactly what the entry would have cost anyway once
// its short TTL ran out. What matters is only that the map cannot grow without bound.
func (s *NATSStore) evictLocked() {
	now := s.now()
	for key, entry := range s.cache {
		if !now.Before(entry.expires) {
			delete(s.cache, key)
		}
	}
	if len(s.cache) < s.maxEntries {
		return
	}
	for key := range s.cache {
		delete(s.cache, key)
		return
	}
}

// Len reports how many entries the cache holds. Tests and diagnostics only.
func (s *NATSStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cache)
}

// Forget drops a cached answer, so a provisioning change can take effect before its TTL.
//
// Nothing calls it yet. The invalidation signal is a JetStream consumer on the provisioning
// stream, which belongs with the provisioning wave rather than here; this is the seam it will
// attach to, and it exists now so that wave does not have to reach into the cache internals.
func (s *NATSStore) Forget(realm, username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cache, lookupKey(realm, username))
}
