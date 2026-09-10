package acl

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
)

func record(network, action string, priority int, trunkID string) Record {
	var trunk *string
	if trunkID != "" {
		trunk = new(trunkID)
	}
	return Record{
		OrgID:   "org-test",
		Network: network,
		Action:  contract.SIPACLEntryAction(action),
		Scope:   ScopeTrunk,
		// Priority is the COLUMN's, "lower first"; this package inverts it.
		Priority: priority,
		TrunkID:  trunk,
		Enabled:  true,
	}
}

func newTestWatcher(t *testing.T, overrides []profile.Entry) (*profile.ACL, *Watcher) {
	t.Helper()
	acl := profile.NewWatchedACL(overrides)
	watcher, err := NewWatcher(acl, overrides, nil)
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	return acl, watcher
}

// There is no default allow anywhere in this package or in internal/profile.
func TestAnAddressMatchingNothingIsRefused(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("203-0-113-0-24", record("203.0.113.0/24", "allow", 100, "trunk-a"))

	if _, allowed := acl.Match("198.51.100.7:5060"); allowed {
		t.Fatal("an address in no entry was admitted")
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); !allowed {
		t.Fatal("an address inside an allow entry was refused")
	}
}

// An empty ACL refusing everything is what makes it safe to build the external profile before the
// bucket has replayed, rather than refusing to boot until the ACL loads.
func TestAnEmptyACLRefusesEveryAddress(t *testing.T) {
	acl, _ := newTestWatcher(t, nil)
	if acl.Len() != 0 {
		t.Fatalf("a fresh watched ACL has %d entries, want 0", acl.Len())
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("an empty ACL admitted an address")
	}
}

func TestLowerColumnPriorityWins(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("allow", record("203.0.113.0/24", "allow", 100, "trunk-a"))
	watcher.Put("deny", record("203.0.113.0/24", "deny", 10, ""))

	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a deny at a lower column priority lost to an allow at a higher one")
	}
}

// An operator denies a range then allows one customer inside it; the /32 must win or the exception
// is unreachable.
func TestTheMostSpecificPrefixWinsAtEqualPriority(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("deny-range", record("203.0.113.0/24", "deny", 100, ""))
	watcher.Put("allow-host", record("203.0.113.7/32", "allow", 100, "trunk-a"))

	entry, allowed := acl.Match("203.0.113.7:5060")
	if !allowed {
		t.Fatal("the more specific allow lost to the less specific deny")
	}
	if entry.TrunkID != "trunk-a" {
		t.Fatalf("the matched entry attributed the call to %q, want trunk-a", entry.TrunkID)
	}
	if _, allowed := acl.Match("203.0.113.8:5060"); allowed {
		t.Fatal("an address covered only by the deny was admitted")
	}
}

// The scope filter is the anti-toll-fraud boundary: an entry admitting an office to the provisioning
// endpoint must not also let it send unauthenticated INVITEs.
func TestOnlyTheTrunkScopeGovernsINVITEAdmission(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	for _, scope := range []contract.SIPACLEntryScope{
		contract.SIPACLEntryScopeRegistration,
		contract.SIPACLEntryScopeProvisioning,
		contract.SIPACLEntryScopeAPI,
	} {
		entry := record("203.0.113.0/24", "allow", 100, "trunk-a")
		entry.Scope = scope
		watcher.Put(string(scope), entry)
	}

	if acl.Len() != 0 {
		t.Fatalf("entries from other scopes compiled into the trunk ACL: %d", acl.Len())
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("an entry scoped to another surface admitted an INVITE")
	}
}

// Treating a disabled entry as an allow is how a decommissioned carrier keeps sending calls.
func TestADisabledEntryDoesNotApply(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	entry := record("203.0.113.0/24", "allow", 100, "trunk-a")
	entry.Enabled = false
	watcher.Put("disabled", entry)

	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a disabled entry admitted an address")
	}
}

// The control plane writes this bucket, so one malformed row must not take every carrier offline.
func TestOneUnusableRecordDoesNotDiscardTheRest(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("good", record("203.0.113.0/24", "allow", 100, "trunk-a"))
	watcher.Put("bad-network", record("not-a-network", "allow", 100, "trunk-b"))
	watcher.Put("bad-action", record("198.51.100.0/24", "maybe", 100, "trunk-c"))

	if _, allowed := acl.Match("203.0.113.7:5060"); !allowed {
		t.Fatal("a valid entry was discarded because another row was malformed")
	}
	if _, allowed := acl.Match("198.51.100.7:5060"); allowed {
		t.Fatal("an entry with an invalid action was admitted")
	}
}

// The revoked-carrier path: a deny taking effect only on restart would make the boundary advisory.
func TestRemovingAnEntryRevokesItImmediately(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("allow", record("203.0.113.0/24", "allow", 100, "trunk-a"))
	if _, allowed := acl.Match("203.0.113.7:5060"); !allowed {
		t.Fatal("the entry never applied")
	}

	watcher.Remove("allow")
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a withdrawn entry still admits")
	}
}

// SIPD_TRUNK_ACL survives every bucket update, for the operator admitting one address during an
// incident who cannot wait for a database write to propagate.
func TestConfiguredOverridesSurviveBucketUpdates(t *testing.T) {
	override, err := profile.ParseEntry("198.51.100.9", profile.ActionAllow, 0, "trunk-override", "SIPD_TRUNK_ACL")
	if err != nil {
		t.Fatalf("ParseEntry: %v", err)
	}
	acl, watcher := newTestWatcher(t, []profile.Entry{override})

	if _, allowed := acl.Match("198.51.100.9:5060"); !allowed {
		t.Fatal("the override did not apply at construction")
	}
	watcher.Put("bucket", record("203.0.113.0/24", "allow", 100, "trunk-a"))
	if _, allowed := acl.Match("198.51.100.9:5060"); !allowed {
		t.Fatal("a bucket update removed a configured override")
	}
	watcher.Remove("bucket")
	if _, allowed := acl.Match("198.51.100.9:5060"); !allowed {
		t.Fatal("a bucket removal removed a configured override")
	}
}

// The arithmetic is not obvious at either end alone: the column is negated and an override is zero.
func TestAnOverrideOutranksABucketDeny(t *testing.T) {
	override, err := profile.ParseEntry("203.0.113.0/24", profile.ActionAllow, 0, "trunk-override", "SIPD_TRUNK_ACL")
	if err != nil {
		t.Fatalf("ParseEntry: %v", err)
	}
	acl, watcher := newTestWatcher(t, []profile.Entry{override})
	watcher.Put("deny", record("203.0.113.0/24", "deny", 100, ""))

	if _, allowed := acl.Match("203.0.113.7:5060"); !allowed {
		t.Fatal("a bucket deny beat a configured override")
	}
}

// The trunk id is the attribution the engine needs before it can be asked whose call it is.
func TestAMatchedAllowCarriesItsTrunkAttribution(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("allow", record("203.0.113.0/24", "allow", 100, "018f-telnyx"))

	entry, allowed := acl.Match("203.0.113.7:5060")
	if !allowed {
		t.Fatal("the entry did not admit")
	}
	if entry.TrunkID != "018f-telnyx" {
		t.Fatalf("trunkId = %q, want 018f-telnyx", entry.TrunkID)
	}
}

// The initial replay arrives as one update per key; recompiling per key would be quadratic, and
// every carrier is refused until it finishes.
func TestSuspendDefersRecompilationUntilResume(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)

	watcher.Suspend()
	for _, network := range []string{"203.0.113.0/24", "198.51.100.0/24", "192.0.2.0/24"} {
		watcher.Put(network, record(network, "allow", 100, "trunk-a"))
	}
	if watcher.Len() != 3 {
		t.Fatalf("the watcher holds %d records, want 3", watcher.Len())
	}
	// Suspended leaves the ACL empty rather than half-applied.
	if acl.Len() != 0 {
		t.Fatalf("the ACL compiled %d entries while suspended", acl.Len())
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a suspended watcher admitted traffic")
	}

	watcher.Resume()
	if acl.Len() != 3 {
		t.Fatalf("the ACL compiled %d entries after Resume, want 3", acl.Len())
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); !allowed {
		t.Fatal("the replayed entries never applied")
	}

	watcher.Remove("203.0.113.0/24")
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a withdrawn entry still admits after a resume")
	}
}

// stubWatcher is one update stream that the test closes to simulate a broker restart ending the
// ordered consumer.
type stubWatcher struct {
	updates chan jetstream.KeyValueEntry
	stopped atomic.Bool
}

func (s *stubWatcher) Updates() <-chan jetstream.KeyValueEntry { return s.updates }
func (s *stubWatcher) Stop() error                             { s.stopped.Store(true); return nil }

// stubBucket hands out one stubWatcher per WatchAll. Only WatchAll is implemented; the embedded
// interface is nil, so any other call would panic — which is the assertion that Watch uses nothing
// else.
type stubBucket struct {
	jetstream.KeyValue
	mu       sync.Mutex
	handed   []*stubWatcher
	watchers chan *stubWatcher
}

func (b *stubBucket) WatchAll(context.Context, ...jetstream.WatchOpt) (jetstream.KeyWatcher, error) {
	watcher := &stubWatcher{updates: make(chan jetstream.KeyValueEntry, 8)}
	b.mu.Lock()
	b.handed = append(b.handed, watcher)
	b.mu.Unlock()
	b.watchers <- watcher
	return watcher, nil
}

// stubEntry is one KV update. Only the four accessors applyUpdate reads are implemented.
type stubEntry struct {
	jetstream.KeyValueEntry
	key       string
	value     []byte
	operation jetstream.KeyValueOp
}

func (e stubEntry) Key() string                     { return e.key }
func (e stubEntry) Value() []byte                   { return e.value }
func (e stubEntry) Operation() jetstream.KeyValueOp { return e.operation }

// TestTheWatchSurvivesTheStreamEnding is the broker-restart case: nats.go ends the ordered consumer,
// and a watch that did not re-establish itself would leave the edge on a frozen ACL for the life of
// the process, silently.
func TestTheWatchSurvivesTheStreamEnding(t *testing.T) {
	evaluator := profile.NewWatchedACL(nil)
	watcher, err := NewWatcher(evaluator, nil, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	bucket := &stubBucket{watchers: make(chan *stubWatcher, 4)}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready, err := Watch(ctx, bucket, watcher)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	first := <-bucket.watchers
	first.updates <- nil // end of the initial replay
	<-ready

	// The broker restarts: the ordered consumer's channel closes.
	close(first.updates)

	var second *stubWatcher
	select {
	case second = <-bucket.watchers:
	case <-time.After(10 * time.Second):
		t.Fatal("the watch was never re-established after the update stream ended")
	}

	record := contract.SIPACLEntry{
		Network: "203.0.113.7/32", Action: contract.SIPACLEntryActionAllow,
		Scope: contract.SIPACLEntryScopeTrunk, Priority: 10, Enabled: true,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshalling the record: %v", err)
	}
	second.updates <- stubEntry{key: "203-0-113-7-32", value: encoded, operation: jetstream.KeyValuePut}
	second.updates <- nil

	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, allowed := evaluator.Match("203.0.113.7:5060"); allowed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("an entry written after the stream restarted never reached the evaluator")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The bucket carries both edge scopes on one watch. Compiling either into the other's evaluator is
// how an ACL written to block a credential-stuffing run admits a carrier — or the reverse.
func TestTheTwoScopesCompileIntoSeparateEvaluators(t *testing.T) {
	trunkACL := profile.NewWatchedACL(nil)
	registrationACL := profile.NewWatchedBlocklist(nil)
	watcher, err := NewWatcher(trunkACL, nil, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	watcher.WithRegistrationACL(registrationACL)

	carrier := record("198.51.100.0/24", "allow", 100, "trunk-a")
	watcher.Put("198-51-100-0-24", carrier)

	blocked := record("203.0.113.0/24", "deny", 100, "")
	blocked.Scope = ScopeRegistration
	watcher.Put("203-0-113-0-24", blocked)

	if _, allowed := trunkACL.Match("198.51.100.7:5060"); !allowed {
		t.Error("the trunk-scoped allow did not reach the trunk evaluator")
	}
	if _, allowed := trunkACL.Match("203.0.113.7:5060"); allowed {
		t.Error("a registration-scoped entry admitted an INVITE")
	}
	if _, allowed := registrationACL.Match("203.0.113.7:5060"); allowed {
		t.Error("the registration-scoped deny did not reach the registration evaluator")
	}
	// A blocklist admits what no rule names, including an address a trunk rule allows.
	if _, allowed := registrationACL.Match("198.51.100.7:5060"); !allowed {
		t.Error("the registration blocklist refused an address no registration rule names")
	}

	watcher.Remove("203-0-113-0-24")
	if _, allowed := registrationACL.Match("203.0.113.7:5060"); !allowed {
		t.Error("a withdrawn registration deny still blocks")
	}
}
