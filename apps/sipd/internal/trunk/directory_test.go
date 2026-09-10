package trunk

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	directoryOrg   = "018f0000-0000-7000-8000-000000000000"
	directoryTrunk = "018f0000-0000-7000-8000-0000000000t1"
)

func testRecord() Record {
	return Record{
		TrunkID:                directoryTrunk,
		OrgID:                  directoryOrg,
		Name:                   "Telnyx",
		Kind:                   "register",
		SIPDomain:              "sip.telnyx.example",
		SIPProxy:               "sip.telnyx.example:5060",
		AuthUser:               new("acme"),
		RegisterExpiresSeconds: 600,
		Transport:              "UDP",
		Enabled:                true,
	}
}

// Derived from the column rather than carried as a second boolean: a kind and a flag that disagreed
// would REGISTER at a carrier with no account for us and be refused 403 for ever on a backoff.
func TestTheKindColumnDecidesWhetherATrunkRegisters(t *testing.T) {
	registering := testRecord().Config()
	if !registering.Register {
		t.Fatal("a kind=register trunk does not register")
	}

	ipAuth := testRecord()
	ipAuth.Kind = "ip-auth"
	if ipAuth.Config().Register {
		t.Fatal("an ip-auth trunk registers; the carrier has no account for us")
	}
}

func TestTheRegistrarInheritsTheProxyWhenUnset(t *testing.T) {
	config := testRecord().Config()
	if config.Registrar != "sip.telnyx.example:5060" {
		t.Fatalf("registrar = %q, want the proxy", config.Registrar)
	}

}

// A writer may omit the interval, and a registering trunk with a zero expiry fails Validate.
func TestAnOmittedExpiryTakesTheColumnDefault(t *testing.T) {
	record := testRecord()
	record.RegisterExpiresSeconds = 0
	config := record.Config()

	if config.ExpiresSeconds != 300 {
		t.Fatalf("expires = %d, want the column default of 300", config.ExpiresSeconds)
	}
	if err := config.Validate(); err != nil {
		t.Fatalf("a defaulted config does not validate: %v", err)
	}
}

// The SIP domain is what a carrier challenges with when it states no separate realm.
func TestTheAuthRealmFallsBackToTheSIPDomain(t *testing.T) {
	if got := testRecord().Config().AuthRealm; got != "sip.telnyx.example" {
		t.Fatalf("authRealm = %q, want the sip domain", got)
	}
}

// Keyed by the contract's builder so this reader and the control-plane writer cannot disagree.
func TestTheDirectoryIsKeyedByTheContractKeyBuilder(t *testing.T) {
	directory := NewDirectory(nil)
	key, err := contract.TrunkKVKey(directoryOrg, directoryTrunk)
	if err != nil {
		t.Fatalf("TrunkKVKey: %v", err)
	}
	if err := directory.Put(key, testRecord().Config()); err != nil {
		t.Fatalf("Put: %v", err)
	}

	config, found := directory.Trunk(directoryOrg, directoryTrunk)
	if !found {
		t.Fatal("a trunk written under the contract key was not found by it")
	}
	if config.Name != "Telnyx" {
		t.Fatalf("name = %q, want Telnyx", config.Name)
	}
	if _, found := directory.Trunk(directoryOrg, "another-trunk"); found {
		t.Fatal("an unknown trunk was found")
	}
}

// An operator saving a half-filled trunk form must not take a working carrier offline.
func TestAnInvalidRecordDoesNotReplaceAWorkingOne(t *testing.T) {
	directory := NewDirectory(nil)
	key, _ := contract.TrunkKVKey(directoryOrg, directoryTrunk)
	if err := directory.Put(key, testRecord().Config()); err != nil {
		t.Fatalf("Put: %v", err)
	}

	broken := testRecord()
	broken.SIPProxy = ""
	if err := directory.Put(key, broken.Config()); err == nil {
		t.Fatal("a registering trunk with no registrar was accepted")
	}

	config, found := directory.Trunk(directoryOrg, directoryTrunk)
	if !found || config.SIPProxy != "sip.telnyx.example:5060" {
		t.Fatal("the working configuration was replaced by an invalid one")
	}
}

func TestRemovingATrunkTakesEffectImmediately(t *testing.T) {
	directory := NewDirectory(nil)
	key, _ := contract.TrunkKVKey(directoryOrg, directoryTrunk)
	_ = directory.Put(key, testRecord().Config())

	directory.Remove(key)
	if _, found := directory.Trunk(directoryOrg, directoryTrunk); found {
		t.Fatal("a removed trunk is still resolvable")
	}
	if directory.Len() != 0 {
		t.Fatalf("Len = %d, want 0", directory.Len())
	}
}

// sameConfig compares only what the machine reads, so a rename puts no REGISTER on the wire.
func TestARenameDoesNotRestartAGateway(t *testing.T) {
	left := testRecord().Config()
	renamed := testRecord()
	renamed.Name = "Telnyx (EU)"
	renamed.MaxChannels = new(40)

	if !sameConfig(left, renamed.Config()) {
		t.Fatal("a rename or a capacity edit would restart the gateway")
	}

	moved := testRecord()
	moved.SIPProxy = "sip2.telnyx.example:5060"
	if sameConfig(left, moved.Config()) {
		t.Fatal("a changed proxy did not restart the gateway; it would fail over to an address that is gone")
	}
}

func TestAPIPublishedTrunkReachesDirectory(t *testing.T) {
	raw, err := os.ReadFile("testdata/api_projection.json")
	if err != nil {
		t.Fatal(err)
	}
	var record Record
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	config := record.Config()
	key, err := contract.TrunkKVKey(config.OrgID, config.TrunkID)
	if err != nil {
		t.Fatal(err)
	}
	directory := NewDirectory(nil)
	if err := directory.Put(key, config); err != nil {
		t.Fatalf("API projection rejected: %v", err)
	}
	resolved, found := directory.Trunk("019fd3c2-1111-76be-a6b3-b0f1914e39b6", "019fd3c2-3333-76be-a6b3-b0f1914e39b6")
	if !found || !resolved.Register || resolved.AuthUser != "optimiq-outbound" ||
		resolved.SecretRef != "secret://pbx/trunk/telnyx" ||
		resolved.Registrar != "sip.telnyx.example:5060" {
		t.Fatalf("API trunk lost its identity or registration configuration: %+v", resolved)
	}
	otherKey, _ := contract.TrunkKVKey(directoryOrg, config.TrunkID)
	if err := directory.Put(otherKey, config); err == nil {
		t.Fatal("a trunk was accepted under another organization's key")
	}
}

func TestTheSupervisorReconcilesAgainstTheDirectory(t *testing.T) {
	supervisor, err := NewSupervisor(SupervisorOptions{
		Registrar: stubRegistrar{},
		Publisher: NewRecordingPublisher(),
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	defer supervisor.Stop()

	ipAuth := testRecord()
	ipAuth.Kind = "ip-auth"
	second := testRecord()
	second.TrunkID = "018f0000-0000-7000-8000-0000000000t2"
	second.Kind = "ip-auth"

	supervisor.Apply(t.Context(), []Config{ipAuth.Config(), second.Config()})
	if supervisor.Len() != 2 {
		t.Fatalf("running = %d, want 2", supervisor.Len())
	}

	supervisor.Apply(t.Context(), []Config{ipAuth.Config()})
	if supervisor.Len() != 1 {
		t.Fatalf("running = %d after one left, want 1", supervisor.Len())
	}

	supervisor.Apply(t.Context(), nil)
	if supervisor.Len() != 0 {
		t.Fatalf("running = %d after all left, want 0", supervisor.Len())
	}
}

// Nothing to establish, and `unknown` for ever would make every ip-auth carrier look broken.
func TestAnIPAuthTrunkReportsUpWithoutRegistering(t *testing.T) {
	publisher := NewRecordingPublisher()
	supervisor, err := NewSupervisor(SupervisorOptions{
		Registrar: stubRegistrar{},
		Publisher: publisher,
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	defer supervisor.Stop()

	ipAuth := testRecord()
	ipAuth.Kind = "ip-auth"
	supervisor.Apply(t.Context(), []Config{ipAuth.Config()})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, transition := range publisher.Transitions() {
			if transition.Status == StatusUp {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no `up` was published for an ip-auth trunk; transitions = %v", publisher.Transitions())
}

// A supervisor that tracked carrier state and told nobody would be a dashboard that is always green.
func TestTheSupervisorRefusesToRunWithoutAPublisher(t *testing.T) {
	if _, err := NewSupervisor(SupervisorOptions{Registrar: stubRegistrar{}}); err == nil {
		t.Fatal("NewSupervisor accepted a nil publisher")
	}
	if _, err := NewSupervisor(SupervisorOptions{Publisher: NewRecordingPublisher()}); err == nil {
		t.Fatal("NewSupervisor accepted a nil registrar")
	}
}

type stubRegistrar struct{}

func (stubRegistrar) Register(_ context.Context, _ Config, _ string, expires time.Duration) Result {
	return Result{Trigger: TriggerAccepted, GrantedExpires: expires}
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

// stubEntry is one KV update. Only the three accessors applyTrunkUpdate reads are implemented.
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
// and a watch that did not re-establish itself would leave the edge on a frozen directory for the
// life of the process, silently.
func TestTheWatchSurvivesTheStreamEnding(t *testing.T) {
	directory := NewDirectory(slog.New(slog.DiscardHandler))
	bucket := &stubBucket{watchers: make(chan *stubWatcher, 4)}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready, err := Watch(ctx, bucket, directory)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	first := <-bucket.watchers
	firstRecord := testRecord()
	firstKey, err := contract.TrunkKVKey(firstRecord.OrgID, firstRecord.TrunkID)
	if err != nil {
		t.Fatalf("TrunkKVKey: %v", err)
	}
	encoded, err := json.Marshal(firstRecord)
	if err != nil {
		t.Fatalf("marshalling the record: %v", err)
	}
	first.updates <- stubEntry{key: firstKey, value: encoded, operation: jetstream.KeyValuePut}
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

	// The trunk from before the stream ended is still resolvable while the replacement replays.
	if _, found := directory.Trunk(firstRecord.OrgID, firstRecord.TrunkID); !found {
		t.Fatal("the directory was cleared while the watch was being re-established")
	}

	nextRecord := testRecord()
	nextRecord.TrunkID = "018f0000-0000-7000-8000-0000000000t2"
	nextRecord.Name = "Second"
	nextKey, err := contract.TrunkKVKey(nextRecord.OrgID, nextRecord.TrunkID)
	if err != nil {
		t.Fatalf("TrunkKVKey: %v", err)
	}
	encoded, err = json.Marshal(nextRecord)
	if err != nil {
		t.Fatalf("marshalling the record: %v", err)
	}
	second.updates <- stubEntry{key: nextKey, value: encoded, operation: jetstream.KeyValuePut}
	second.updates <- nil

	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, found := directory.Trunk(nextRecord.OrgID, nextRecord.TrunkID); found {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("a trunk written after the stream restarted never reached the directory")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestTheReplayAfterAReestablishReconciles proves the trunk supervisor is woken by the replacement
// replay's boundary, not just by the first one.
func TestTheReplayAfterAReestablishReconciles(t *testing.T) {
	directory := NewDirectory(slog.New(slog.DiscardHandler))
	reconciled := make(chan struct{}, 8)
	directory.OnChange(func() { reconciled <- struct{}{} })
	bucket := &stubBucket{watchers: make(chan *stubWatcher, 4)}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready, err := Watch(ctx, bucket, directory)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	first := <-bucket.watchers
	first.updates <- nil
	<-ready
	<-reconciled

	close(first.updates)
	var second *stubWatcher
	select {
	case second = <-bucket.watchers:
	case <-time.After(10 * time.Second):
		t.Fatal("the watch was never re-established")
	}
	second.updates <- nil
	select {
	case <-reconciled:
	case <-time.After(10 * time.Second):
		t.Fatal("the re-established replay did not reconcile the supervisor")
	}
}
