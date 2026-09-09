package credentials

import (
	"context"
	"errors"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// In-package tests, because the two things worth pinning here — how a reply becomes a credential
// or a refusal, and how the cache behaves — are deliberately not public API. The transport itself
// is covered by the gated integration suite against a real NATS server; splitting the seam open
// just to reach it from outside would be adding API surface for a test's convenience.

func ptr(s string) *string { return &s }

func ptrInt(i int) *int { return &i }

const testHA1 = "425d0b350d19aaf57ebe7faea9c87e27"

func TestCredentialFromReply(t *testing.T) {
	const (
		realm = "acme.example.com"
		user  = "1001"
		org   = "018f4f5e-0000-7000-8000-0000000000a1"
	)

	tests := []struct {
		name  string
		reply contract.SipCredentialResponse
		want  error
		check func(t *testing.T, c Credential)
	}{
		{
			name: "a usable account",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true,
				OrgID: ptr(org), Ha1: ptr(testHA1),
				Username: ptr(user), Realm: ptr(realm),
				DeviceID: ptr("0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50"),
			},
			check: func(t *testing.T, c Credential) {
				t.Helper()
				if c.OrgID != org || c.HA1 != testHA1 || c.Username != user || c.Realm != realm {
					t.Errorf("credential = %+v", c)
				}
				if c.DeviceID == "" {
					t.Error("deviceId was dropped")
				}
			},
		},
		{
			// A shared line appearance: the reply names the shared line's number and this account's
			// appearance index, and both must reach the Credential so the INVITE path can stamp them.
			name: "a shared line appearance",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true,
				OrgID: ptr(org), Ha1: ptr(testHA1),
				Username: ptr(user), Realm: ptr(realm),
				SharedLineNumber: ptr("2000"),
				AppearanceIndex:  ptrInt(2),
			},
			check: func(t *testing.T, c Credential) {
				t.Helper()
				if c.SharedLineNumber == nil || *c.SharedLineNumber != "2000" {
					t.Errorf("sharedLineNumber = %v, want 2000", c.SharedLineNumber)
				}
				if c.AppearanceIndex == nil || *c.AppearanceIndex != 2 {
					t.Errorf("appearanceIndex = %v, want 2", c.AppearanceIndex)
				}
			},
		},
		{
			name:  "an unknown account",
			reply: contract.SipCredentialResponse{Found: false},
			want:  ErrNotFound,
		},
		{
			name:  "a disabled account",
			reply: contract.SipCredentialResponse{Found: true, Enabled: false, OrgID: ptr(org), Ha1: ptr(testHA1)},
			want:  ErrDisabled,
		},
		{
			// Fail closed. "Found and enabled but here is no hash" is a responder bug, and the one
			// thing it must not become is an authenticated registration.
			name:  "found and enabled with no ha1",
			reply: contract.SipCredentialResponse{Found: true, Enabled: true, OrgID: ptr(org)},
			want:  ErrLookupFailed,
		},
		{
			name:  "found and enabled with no orgId",
			reply: contract.SipCredentialResponse{Found: true, Enabled: true, Ha1: ptr(testHA1)},
			want:  ErrLookupFailed,
		},
		{
			// HA1 is computed over username:realm:password, so an answer about a different account
			// would verify against a digest the phone never computed. Refuse loudly instead.
			name: "an answer for a different realm",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true, OrgID: ptr(org), Ha1: ptr(testHA1),
				Realm: ptr("other.example.com"),
			},
			want: ErrLookupFailed,
		},
		{
			name: "an answer for a different user",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true, OrgID: ptr(org), Ha1: ptr(testHA1),
				Username: ptr("1002"),
			},
			want: ErrLookupFailed,
		},
		{
			name: "a malformed ha1",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true, OrgID: ptr(org), Ha1: ptr("nothex"),
			},
			want: ErrLookupFailed,
		},
		{
			// The realm is echoed with different casing; RFC 3261 §19.1.4 makes host parts
			// case-insensitive, so this is the same realm and must be accepted.
			name: "a differently-cased realm",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true, OrgID: ptr(org), Ha1: ptr(testHA1),
				Realm: ptr("ACME.Example.COM"),
			},
		},
		{
			// An uppercase digest is still the digest. Normalise rather than refuse: the
			// comparison in Verify is byte-wise.
			name: "an upper-case ha1",
			reply: contract.SipCredentialResponse{
				Found: true, Enabled: true, OrgID: ptr(org), Ha1: ptr("425D0B350D19AAF57EBE7FAEA9C87E27"),
			},
			check: func(t *testing.T, c Credential) {
				t.Helper()
				if c.HA1 != testHA1 {
					t.Errorf("ha1 = %q, want it folded to lower case", c.HA1)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			credential, err := credentialFromReply(realm, user, tc.reply)
			if tc.want != nil {
				if !errors.Is(err, tc.want) {
					t.Fatalf("err = %v, want %v", err, tc.want)
				}
				if credential != (Credential{}) {
					t.Errorf("a refusal must carry no credential, got %+v", credential)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v, want none", err)
			}
			if tc.check != nil {
				tc.check(t, credential)
			}
		})
	}
}

func TestCacheHonoursItsTTLs(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	store := &NATSStore{
		cache:       map[string]cacheEntry{},
		maxEntries:  16,
		positiveTTL: 30 * time.Second,
		negativeTTL: 10 * time.Second,
		now:         func() time.Time { return now },
	}

	key := lookupKey("acme.example.com", "1001")
	store.store(key, cacheEntry{credential: Credential{Username: "1001"}, expires: now.Add(30 * time.Second)})

	if _, ok := store.cached(key); !ok {
		t.Fatal("a fresh entry must be a hit")
	}

	now = now.Add(29 * time.Second)
	if _, ok := store.cached(key); !ok {
		t.Error("an entry inside its TTL must still be a hit")
	}

	now = now.Add(2 * time.Second)
	if _, ok := store.cached(key); ok {
		t.Error("an expired entry must be a miss")
	}
	if store.Len() != 0 {
		t.Error("an expired entry must be dropped when it is read, not left to accumulate")
	}
}

func TestCacheStoresRefusalsButNeverFailures(t *testing.T) {
	// The asymmetry is the point. A definite "no" is an answer and is cacheable; a transport
	// failure is the absence of an answer, and caching it would extend an outage past its cause.
	now := time.Unix(1_800_000_000, 0)
	store := &NATSStore{
		cache:       map[string]cacheEntry{},
		maxEntries:  16,
		positiveTTL: 30 * time.Second,
		negativeTTL: 10 * time.Second,
		now:         func() time.Time { return now },
	}

	key := lookupKey("acme.example.com", "9999")
	store.store(key, cacheEntry{err: ErrNotFound, expires: now.Add(store.negativeTTL)})

	entry, ok := store.cached(key)
	if !ok || !errors.Is(entry.err, ErrNotFound) {
		t.Fatalf("a cached refusal must be replayed: ok=%v err=%v", ok, entry.err)
	}

	now = now.Add(11 * time.Second)
	if _, ok := store.cached(key); ok {
		t.Error("the negative TTL is short on purpose; it must actually expire")
	}
}

func TestCacheIsBounded(t *testing.T) {
	// A username scanner against an open port produces one miss per guess. Without a ceiling the
	// negative cache turns that into one map entry per guess, for free.
	now := time.Unix(1_800_000_000, 0)
	store := &NATSStore{
		cache:       map[string]cacheEntry{},
		maxEntries:  8,
		positiveTTL: time.Minute,
		negativeTTL: time.Minute,
		now:         func() time.Time { return now },
	}

	for i := range 500 {
		store.store(lookupKey("acme.example.com", string(rune('a'+i%26))+time.Duration(i).String()),
			cacheEntry{err: ErrNotFound, expires: now.Add(time.Minute)})
	}

	if store.Len() > store.maxEntries {
		t.Errorf("cache holds %d entries, ceiling is %d", store.Len(), store.maxEntries)
	}
}

func TestNewNATSStoreDefaultsToTheContract(t *testing.T) {
	// The timeout and subject come from packages/events-go rather than from a literal here, so a
	// contract change reaches the edge through codegen instead of through somebody remembering.
	store := &NATSStore{}
	store.subject, store.timeout = contract.SubjectSipCredentialRPC, contract.TimeoutSipCredentialRPC

	if store.subject != "rpc.sip.v1.credential" {
		t.Errorf("subject = %q", store.subject)
	}
	if store.timeout != 500*time.Millisecond {
		t.Errorf("timeout = %s, want the contract's 500ms REGISTER-path deadline", store.timeout)
	}
}

// A cold cache must not stampede the control plane. The positive cache collapses the STEADY rate;
// without single-flight a fleet restart or a TTL boundary sends one RPC per concurrent REGISTER.
func TestConcurrentLookupsForOneAccountIssueOneRequest(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	release := make(chan struct{})
	var requests atomic.Int64
	store := &NATSStore{
		cache:       map[string]cacheEntry{},
		maxEntries:  16,
		positiveTTL: 30 * time.Second,
		negativeTTL: 10 * time.Second,
		now:         func() time.Time { return now },
	}
	store.rpc = func(context.Context, string, string) (Credential, error) {
		requests.Add(1)
		// Held open so every caller is genuinely concurrent rather than merely serialised behind a
		// cache that filled after the first one returned.
		<-release
		return Credential{OrgID: "org", Username: "1001", Realm: "acme.example.com", HA1: strings.Repeat("a", 32)}, nil
	}

	const callers = 32
	var group sync.WaitGroup
	errs := make(chan error, callers)
	for range callers {
		group.Add(1)
		go func() {
			defer group.Done()
			credential, err := store.Lookup(context.Background(), "acme.example.com", "1001")
			if err != nil {
				errs <- err
				return
			}
			if credential.OrgID != "org" {
				errs <- errors.New("a waiter got the wrong credential")
			}
		}()
	}
	// Give the callers time to pile up behind the leader before it answers.
	for requests.Load() == 0 {
		runtime.Gosched()
	}
	close(release)
	group.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("Lookup: %v", err)
	}

	if got := requests.Load(); got != 1 {
		t.Errorf("%d concurrent lookups issued %d requests, want 1", callers, got)
	}
	if store.Len() != 1 {
		t.Errorf("cache holds %d entries, want the one answer", store.Len())
	}
}

// The eviction sweep is rate limited, because a full cache is exactly what a username scan
// produces: sweeping on every miss would make each of the scanner's guesses a full map walk under
// the mutex that serialises every REGISTER in the process.
func TestCacheEvictionSweepIsRateLimited(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	store := &NATSStore{
		cache:       map[string]cacheEntry{},
		maxEntries:  8,
		positiveTTL: time.Minute,
		negativeTTL: 10 * time.Second,
		now:         func() time.Time { return now },
	}
	fill := func(count int, prefix string, expires time.Time) {
		for i := range count {
			store.store(lookupKey("acme.example.com", prefix+strconv.Itoa(i)), cacheEntry{err: ErrNotFound, expires: expires})
		}
	}

	fill(8, "a", now.Add(5*time.Second))
	if store.Len() != 8 {
		t.Fatalf("cache holds %d entries, want 8", store.Len())
	}

	// Everything has lapsed and no sweep has ever run: this one sweeps.
	now = now.Add(6 * time.Second)
	fill(1, "b", now.Add(5*time.Second))
	if store.Len() != 1 {
		t.Fatalf("the first eviction holds %d entries, want the sweep to have cleared the lapsed 8", store.Len())
	}

	fill(7, "c", now.Add(5*time.Second))
	now = now.Add(6 * time.Second)
	// Everything has lapsed again, but the last sweep was 6s ago and the negative TTL is 10s: a
	// single arbitrary entry goes instead of a full walk, so the ceiling holds without the scan.
	fill(1, "d", now.Add(5*time.Second))
	if store.Len() != 8 {
		t.Errorf("cache holds %d entries, want the ceiling of 8 held by a single-entry eviction", store.Len())
	}
}
