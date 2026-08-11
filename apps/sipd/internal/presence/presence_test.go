package presence

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// fakeEntry is a jetstream.KeyValueEntry the watch decoder can be driven with, so the decode path is
// covered without a broker. Only the three accessors changeFor touches carry anything.
type fakeEntry struct {
	key       string
	value     []byte
	operation jetstream.KeyValueOp
}

var _ jetstream.KeyValueEntry = fakeEntry{}

func (e fakeEntry) Bucket() string                  { return contract.PresenceKV.Name }
func (e fakeEntry) Key() string                     { return e.key }
func (e fakeEntry) Value() []byte                   { return e.value }
func (e fakeEntry) Revision() uint64                { return 1 }
func (e fakeEntry) Created() time.Time              { return time.Time{} }
func (e fakeEntry) Delta() uint64                   { return 0 }
func (e fakeEntry) Operation() jetstream.KeyValueOp { return e.operation }

const jetstreamDelete = jetstream.KeyValueDelete

// The key parser is the whole surface of this package that is not a NATS call, and it is the one
// place where a mistake would be invisible: a key that split wrongly would attribute one tenant's
// presence to another's extension, and the symptom is a lamp that lights for a call that is not
// there.
func TestSplitKeyIsExactAndRejectsAnythingElse(t *testing.T) {
	const org = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"

	key, err := contract.PresenceKVKey(org, "1001")
	if err != nil {
		t.Fatalf("PresenceKVKey: %v", err)
	}
	gotOrg, gotExtension, ok := splitKey(key)
	if !ok || gotOrg != org || gotExtension != "1001" {
		t.Fatalf("splitKey(%q) = (%q, %q, %v)", key, gotOrg, gotExtension, ok)
	}

	// Anything that is not the shape contract.PresenceKVKey produces is skipped rather than guessed
	// at. A three-token key is the channels bucket's shape, not this one's.
	for _, bad := range []string{"", ".", "noseparator", ".1001", "org.", "org.1001.extra"} {
		if _, _, ok := splitKey(bad); ok {
			t.Errorf("splitKey(%q) accepted a key this contract cannot produce", bad)
		}
	}
}

// A value that will not decode is DROPPED, not reported as `down`: the alternative is one malformed
// write from a future engine release clearing every lamp in a tenant.
func TestChangeForDropsAnUndecodableValue(t *testing.T) {
	entry := fakeEntry{key: "org.1001", value: []byte("{not json")}
	if _, ok := changeFor(entry); ok {
		t.Error("an unparsable value produced a change")
	}
}

func TestChangeForReportsADeletionSeparatelyFromAnIdleValue(t *testing.T) {
	value, err := json.Marshal(State{
		OrgID:           "org",
		ExtensionNumber: "1001",
		State:           contract.PresenceDeviceStateActive,
	})
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}

	change, ok := changeFor(fakeEntry{key: "org.1001", value: value})
	if !ok || change.Deleted || change.State.State != contract.PresenceDeviceStateActive {
		t.Fatalf("a put decoded as %#v", change)
	}

	deleted, ok := changeFor(fakeEntry{key: "org.1001", operation: jetstreamDelete})
	if !ok || !deleted.Deleted {
		t.Fatalf("a delete decoded as %#v", deleted)
	}
	if deleted.ExtensionNumber != "1001" || deleted.OrgID != "org" {
		t.Errorf("a delete lost its key: %#v", deleted)
	}
}

func TestMemoryStoreRoundTrips(t *testing.T) {
	store := NewMemoryStore()
	const org = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"

	if _, found, err := store.Get(t.Context(), org, "1001"); err != nil || found {
		t.Fatalf("an empty store answered (found=%v, err=%v); absent is a normal answer", found, err)
	}

	store.Set(State{OrgID: org, ExtensionNumber: "1001", State: contract.PresenceDeviceStateRinging})
	state, found, err := store.Get(t.Context(), org, "1001")
	if err != nil || !found || state.State != contract.PresenceDeviceStateRinging {
		t.Fatalf("Get = (%#v, %v, %v)", state, found, err)
	}

	changes, err := store.Watch(t.Context())
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	change := <-changes
	if change.ExtensionNumber != "1001" || change.State.State != contract.PresenceDeviceStateRinging {
		t.Errorf("the watch delivered %#v", change)
	}

	store.Delete(org, "1001")
	if change := <-changes; !change.Deleted {
		t.Errorf("the deletion arrived as %#v", change)
	}
	if _, found, _ := store.Get(t.Context(), org, "1001"); found {
		t.Error("the state survived a delete")
	}
}
