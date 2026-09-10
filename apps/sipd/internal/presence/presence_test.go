package presence

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
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

// A key that split wrongly would attribute one tenant's presence to another's extension.
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

// A value that will not decode is DROPPED, not reported as `down`: one malformed write must not
// clear every lamp in a tenant.
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
	watchers chan *stubWatcher
}

func (b *stubBucket) WatchAll(context.Context, ...jetstream.WatchOpt) (jetstream.KeyWatcher, error) {
	watcher := &stubWatcher{updates: make(chan jetstream.KeyValueEntry, 8)}
	b.watchers <- watcher
	return watcher, nil
}

// TestTheWatchSurvivesTheStreamEnding is the broker-restart case: nats.go ends the ordered consumer,
// and a watch that did not re-establish itself — or that closed its Change channel doing so — would
// freeze every busy lamp for the life of the process, silently.
func TestTheWatchSurvivesTheStreamEnding(t *testing.T) {
	bucket := &stubBucket{watchers: make(chan *stubWatcher, 4)}
	store := &NATSStore{bucket: bucket, log: slog.New(slog.DiscardHandler)}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	changes, err := store.Watch(ctx)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	first := <-bucket.watchers
	close(first.updates)

	var second *stubWatcher
	select {
	case second = <-bucket.watchers:
	case <-time.After(10 * time.Second):
		t.Fatal("the watch was never re-established after the update stream ended")
	}

	const org = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	state := State{OrgID: org, ExtensionNumber: "1001", State: contract.PresenceDeviceStateActive}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshalling the state: %v", err)
	}
	second.updates <- fakeEntry{
		key:       org + ".1001",
		value:     encoded,
		operation: jetstream.KeyValuePut,
	}

	select {
	case change, ok := <-changes:
		if !ok {
			t.Fatal("the change channel was closed by the re-establish; the handler would go deaf")
		}
		if change.ExtensionNumber != "1001" {
			t.Fatalf("change after the restart is for %q", change.ExtensionNumber)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a change written after the stream restarted never arrived")
	}
}
