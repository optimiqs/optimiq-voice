package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
	"golang.org/x/sync/singleflight"
)

// NATSStore resolves credentials over NATS core request-reply against apps/api on
// `rpc.sip.v1.credential` (packages/events `src/schemas/rpc.ts`, generated into packages/events-go
// as SipCredentialRequest / SipCredentialResponse). Core, never JetStream: it is a synchronous
// question inside a REGISTER transaction whose answer is worthless a second later. It is the only
// rpc.* subject whose request carries no orgId — resolving the tenant is the entire question.
//
// The reply is an HA1, not a password: deriving edge-side would put the provisioning root key —
// which derives EVERY tenant's password — on the most internet-exposed process in the system.
// apps/api derives and ships MD5(username:realm:password), which is what RFC 2617 consumes.
//
// Both cache halves have short TTLs, so an account disabled minutes ago cannot still register. The
// negative half is what protects the API: a username scan generates a miss per guess, and each
// uncached miss is a database query. The cache is bounded because an unbounded negative cache keyed
// on an attacker-chosen username is a memory amplifier.
//
// Fail-closed: a timeout, transport error, malformed reply, a reply whose realm or username does
// not match what was asked, or a `found` reply with no usable HA1 all return an error, and the
// registrar turns any error into 403. There is no allow-on-failure and no stale-while-revalidate.
// Failures are NOT cached, so recovery is immediate.
type NATSStore struct {
	conn    *nats.Conn
	subject string
	timeout time.Duration

	positiveTTL time.Duration
	negativeTTL time.Duration
	refreshTTL  time.Duration
	maxEntries  int

	// now is swapped in tests so TTL behaviour is asserted without sleeping.
	now func() time.Time
	// rpc is the credential request, a field only so tests can assert caching and collapsing
	// without a broker. Nothing but NewNATSStore sets it.
	rpc func(ctx context.Context, realm, username string) (Credential, error)

	mu    sync.Mutex
	cache map[string]cacheEntry
	// lastRefresh is when each account's cached answer was last re-asked because a digest failed
	// against it. Bounded with the cache, and swept by the same evictLocked.
	lastRefresh map[string]time.Time
	// lastEvict is when the full expiry sweep last ran. See evictLocked.
	lastEvict time.Time
	// inflight collapses concurrent lookups for one account into one RPC. The cache handles the
	// steady rate; this handles a fleet restart or a TTL boundary.
	inflight singleflight.Group
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
	// RefreshInterval bounds how often one account's cached answer may be re-asked because a digest
	// failed against it. Defaults to defaultRefreshInterval.
	RefreshInterval time.Duration
	// MaxEntries bounds the cache. Zero means the default.
	MaxEntries int
	// Now is the clock, for tests.
	Now func() time.Time
}

const (
	defaultPositiveTTL = 30 * time.Second
	defaultNegativeTTL = 10 * time.Second
	defaultMaxEntries  = 10_000
	// defaultRefreshInterval is the ceiling on re-asks provoked by a failed digest. Short enough
	// that a rotated phone recovers on its next REGISTER rather than on the positive TTL, and long
	// enough that a credential spray against one account costs one extra RPC every few seconds
	// rather than one per packet.
	defaultRefreshInterval = 5 * time.Second
)

// ErrLookupFailed wraps every transport-level failure so a caller can distinguish "the answer is
// no" (ErrNotFound / ErrDisabled) from "there was no answer". The registrar refuses either way.
var ErrLookupFailed = errors.New("credentials: credential lookup failed")

// NewNATSStore builds the store. A nil connection is refused here rather than on the first
// REGISTER.
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
		refreshTTL:  opts.RefreshInterval,
		maxEntries:  opts.MaxEntries,
		now:         opts.Now,
		cache:       make(map[string]cacheEntry),
		lastRefresh: make(map[string]time.Time),
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
	if store.refreshTTL <= 0 {
		store.refreshTTL = defaultRefreshInterval
	}
	if store.maxEntries <= 0 {
		store.maxEntries = defaultMaxEntries
	}
	if store.now == nil {
		store.now = time.Now
	}
	store.rpc = store.request
	return store, nil
}

// Lookup implements Store.
func (s *NATSStore) Lookup(ctx context.Context, realm, username string) (Credential, error) {
	key := lookupKey(realm, username)

	if entry, ok := s.cached(key); ok {
		return entry.credential, entry.err
	}

	// One RPC per account per burst; waiters share the leader's answer, including its refusal.
	//
	// The cache is written INSIDE the flight, before the group entry is released. Writing it after
	// Do returned would leave a window where the leader has finished, the key is free and the cache
	// is still empty, so an arriving caller becomes a second leader.
	result, err, _ := s.inflight.Do(key, func() (any, error) {
		// The leader re-reads the cache: a caller that queued behind a request which has since
		// landed must not send a second one.
		if entry, ok := s.cached(key); ok {
			return entry.credential, entry.err
		}
		credential, err := s.rpc(ctx, realm, username)
		switch {
		case err == nil:
			s.store(key, cacheEntry{credential: credential, expires: s.now().Add(s.positiveTTL)})
		case errors.Is(err, ErrNotFound), errors.Is(err, ErrDisabled):
			s.store(key, cacheEntry{err: err, expires: s.now().Add(s.negativeTTL)})
		default:
			// Transport failures are never cached: that would extend an outage past its cause.
		}
		return credential, err
	})
	credential, _ := result.(Credential)
	if err != nil {
		return Credential{}, err
	}
	return credential, nil
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
// It re-checks the realm and username the responder echoed, because HA1 is computed over exactly
// those two strings plus the password: an answer for a different account would verify against a
// digest the phone never computed. Comparing here makes a responder bug a loud refusal.
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
	if reply.MaxRegistrations != nil {
		credential.MaxRegistrations = *reply.MaxRegistrations
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

// evictLocked frees a slot, sweeping expired entries at most once per negative TTL.
//
// Deliberately not an LRU: the cache is a load shedder, not a correctness mechanism, so all that
// matters is that the map cannot grow without bound. The sweep is rate limited because a full cache
// is what a username scan produces, and sweeping on every miss would walk all entries under the
// mutex that serialises every REGISTER, at a pace the scanner sets. Between sweeps a single
// arbitrary entry goes, which is O(1).
func (s *NATSStore) evictLocked() {
	now := s.now()
	if now.Sub(s.lastEvict) >= s.negativeTTL {
		s.lastEvict = now
		for key, entry := range s.cache {
			if !now.Before(entry.expires) {
				delete(s.cache, key)
			}
		}
		if len(s.cache) < s.maxEntries {
			return
		}
	}
	for key := range s.cache {
		delete(s.cache, key)
		return
	}
}

// Len reports how many entries the cache holds.
func (s *NATSStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cache)
}

// Refresh implements Refresher: it discards this account's cached answer and re-asks, so a rotated
// secret takes effect on the phone's next REGISTER instead of on the positive TTL.
//
// Rate-bounded per account, because the caller invokes it on a FAILED digest and a failed digest is
// usually a wrong password. When the bound refuses, the cached answer is returned unchanged, so the
// caller re-verifies against what it already had and refuses — which is the same outcome as not
// having asked.
func (s *NATSStore) Refresh(ctx context.Context, realm, username string) (Credential, error) {
	key := lookupKey(realm, username)
	if !s.admitRefresh(key) {
		if entry, ok := s.cached(key); ok {
			return entry.credential, entry.err
		}
	} else {
		s.Forget(realm, username)
	}
	return s.Lookup(ctx, realm, username)
}

// admitRefresh reports whether this account may be re-asked now, and records it when it may.
func (s *NATSStore) admitRefresh(key string) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if last, seen := s.lastRefresh[key]; seen && now.Sub(last) < s.refreshTTL {
		return false
	}
	if len(s.lastRefresh) >= s.maxEntries {
		// Same bound and the same reason as the cache: the key space is attacker-chosen.
		maps.DeleteFunc(s.lastRefresh, func(_ string, last time.Time) bool {
			return now.Sub(last) >= s.refreshTTL
		})
		if len(s.lastRefresh) >= s.maxEntries {
			clear(s.lastRefresh)
		}
	}
	s.lastRefresh[key] = now
	return true
}

// EvictOrg implements OrgEvictor: it drops every cached answer belonging to one tenant and reports
// how many went. Driven by `credential.invalidated`, whose payload names no account.
//
// Cached REFUSALS go with them. A refusal carries no org — ErrNotFound is an answer about a
// username no tenant owns — and it is exactly what a re-enable or a rename has to clear; their TTL
// is seconds, so the cost of dropping another tenant's is a single re-ask. There is no realm→org
// map to drop alongside: the org travels on the credential itself.
func (s *NATSStore) EvictOrg(orgID string) int {
	orgID = strings.TrimSpace(orgID)
	if orgID == "" {
		return 0
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	dropped := 0
	for key, entry := range s.cache {
		if entry.err == nil && entry.credential.OrgID != orgID {
			continue
		}
		delete(s.cache, key)
		delete(s.lastRefresh, key)
		dropped++
	}
	return dropped
}

// Forget drops a cached answer, so a provisioning change can take effect before its TTL. It is the
// seam the invalidation consumer in invalidate.go attaches to without reaching into cache
// internals.
func (s *NATSStore) Forget(realm, username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cache, lookupKey(realm, username))
}
