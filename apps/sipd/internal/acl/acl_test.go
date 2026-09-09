package acl

import (
	"testing"

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
