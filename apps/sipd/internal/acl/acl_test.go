package acl

import (
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
)

func record(network, action string, priority int, trunkID string) Record {
	return Record{
		ID:      network,
		Network: network,
		Action:  action,
		Scope:   ScopeTrunk,
		// Priority is the COLUMN's, "lower first". The inversion into the evaluator's "higher wins"
		// is this package's job and is exactly what these tests are checking.
		Priority: priority,
		TrunkID:  trunkID,
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

// The whole boundary in one test: an address matching NOTHING is REFUSED. There is no default allow
// anywhere in this package or in internal/profile, and there is no constructor that could give one.
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

// An EMPTY ACL refuses everything, which is what makes it safe to build the external profile before
// the bucket has replayed. The alternative — refusing to boot until the ACL loads — would let a
// briefly slow broker take REGISTER down with it.
func TestAnEmptyACLRefusesEveryAddress(t *testing.T) {
	acl, _ := newTestWatcher(t, nil)
	if acl.Len() != 0 {
		t.Fatalf("a fresh watched ACL has %d entries, want 0", acl.Len())
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("an empty ACL admitted an address")
	}
}

// Lowest column priority first, and the evaluator sees it as highest. A deny written at priority 10
// must beat an allow at 100 for the same network, or an operator's "block this range" does nothing.
func TestLowerColumnPriorityWins(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	watcher.Put("allow", record("203.0.113.0/24", "allow", 100, "trunk-a"))
	watcher.Put("deny", record("203.0.113.0/24", "deny", 10, ""))

	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a deny at a lower column priority lost to an allow at a higher one")
	}
}

// Ties are broken by the MOST SPECIFIC prefix. An operator denies a range and then allows one
// customer inside it, and the /32 has to win or the exception is unreachable.
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

// The scope filter IS the anti-toll-fraud boundary, in the column's own words. An entry written to
// let an office reach the provisioning endpoint must not also let it send unauthenticated INVITEs.
func TestOnlyTheTrunkScopeGovernsINVITEAdmission(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	for _, scope := range []string{"registration", "provisioning", "api"} {
		entry := record("203.0.113.0/24", "allow", 100, "trunk-a")
		entry.Scope = scope
		watcher.Put(scope, entry)
	}

	if acl.Len() != 0 {
		t.Fatalf("entries from other scopes compiled into the trunk ACL: %d", acl.Len())
	}
	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("an entry scoped to another surface admitted an INVITE")
	}
}

// A disabled entry is one an operator switched off. Treating it as an allow is how a decommissioned
// carrier keeps sending calls.
func TestADisabledEntryDoesNotApply(t *testing.T) {
	acl, watcher := newTestWatcher(t, nil)
	entry := record("203.0.113.0/24", "allow", 100, "trunk-a")
	entry.Enabled = false
	watcher.Put("disabled", entry)

	if _, allowed := acl.Match("203.0.113.7:5060"); allowed {
		t.Fatal("a disabled entry admitted an address")
	}
}

// One unusable row must not take every carrier offline. The control plane writes this bucket and
// this process does not control it, so a single malformed network is skipped and the rest apply.
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

// A withdrawn entry stops admitting immediately. This is the path a revoked carrier takes, and a
// deny that took effect only on restart would be a boundary that is advisory.
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

// SIPD_TRUNK_ACL is an OVERRIDE now. It survives every bucket update, which is what makes it
// trustworthy for the case it exists for: an operator admitting one address during an incident who
// cannot wait for a database write to propagate.
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

// An override outranks a bucket entry for the same network, because overrides exist to win. The
// arithmetic is not obvious at either end alone — the column is negated and an override is zero — so
// it is asserted rather than assumed.
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

// The record's action decides, and the trunk id is what turns "this packet may enter" into "this
// packet is Telnyx" — the attribution the engine needs before it can be asked whose call it is.
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
