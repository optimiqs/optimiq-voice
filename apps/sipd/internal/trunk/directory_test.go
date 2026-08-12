package trunk

import (
	"context"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	directoryOrg   = "018f0000-0000-7000-8000-000000000000"
	directoryTrunk = "018f0000-0000-7000-8000-0000000000t1"
)

func testRecord() Record {
	return Record{
		ID:                     directoryTrunk,
		OrganizationID:         directoryOrg,
		Name:                   "Telnyx",
		Kind:                   "register",
		SIPDomain:              "sip.telnyx.example",
		SIPProxy:               "sip.telnyx.example:5060",
		AuthUser:               "acme",
		RegisterExpiresSeconds: 600,
		Transport:              "UDP",
		Enabled:                true,
	}
}

// `register` registers and `ip-auth` does not, derived from the column rather than carried as a
// second boolean. A trunk whose kind said ip-auth and whose flag said true would send REGISTER at a
// carrier that has no account for us and be refused 403 for ever on a backoff.
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

// The column set has only `sipProxy`. A carrier that takes registrations at its call address is the
// common case, so the inheritance is the normal path rather than a fallback.
func TestTheRegistrarInheritsTheProxyWhenUnset(t *testing.T) {
	config := testRecord().Config()
	if config.Registrar != "sip.telnyx.example:5060" {
		t.Fatalf("registrar = %q, want the proxy", config.Registrar)
	}

	split := testRecord()
	split.Registrar = "registrar.telnyx.example"
	if got := split.Config().Registrar; got != "registrar.telnyx.example" {
		t.Fatalf("registrar = %q, want the explicit one", got)
	}
	if got := split.Config().SIPProxy; got != "sip.telnyx.example:5060" {
		t.Fatalf("sipProxy = %q, want it kept apart from the registrar", got)
	}
}

// A record written by an older writer may omit the interval, and a registering trunk with a zero
// expiry fails Validate rather than defaulting quietly somewhere further in.
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

// The auth realm falls back to the SIP domain, which is what a carrier challenges with when it does
// not state a separate one.
func TestTheAuthRealmFallsBackToTheSIPDomain(t *testing.T) {
	if got := testRecord().Config().AuthRealm; got != "sip.telnyx.example" {
		t.Fatalf("authRealm = %q, want the sip domain", got)
	}
}

// The directory is keyed by the contract's own builder, so this reader and the control-plane writer
// cannot disagree about where a trunk lives.
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

// A record that fails Validate is REFUSED and the previous one stands. An operator who saves a
// half-filled trunk form must not take a working carrier offline.
func TestAnInvalidRecordDoesNotReplaceAWorkingOne(t *testing.T) {
	directory := NewDirectory(nil)
	key, _ := contract.TrunkKVKey(directoryOrg, directoryTrunk)
	if err := directory.Put(key, testRecord().Config()); err != nil {
		t.Fatalf("Put: %v", err)
	}

	broken := testRecord()
	broken.SIPProxy = ""
	broken.Registrar = ""
	if err := directory.Put(key, broken.Config()); err == nil {
		t.Fatal("a registering trunk with no registrar was accepted")
	}

	config, found := directory.Trunk(directoryOrg, directoryTrunk)
	if !found || config.SIPProxy != "sip.telnyx.example:5060" {
		t.Fatal("the working configuration was replaced by an invalid one")
	}
}

// Removal takes effect immediately, which is the path a decommissioned trunk takes.
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

// sameConfig compares what the MACHINE reads, so a rename or a codec-preference edit does not
// restart a gateway and put a REGISTER on the wire for nothing.
func TestARenameDoesNotRestartAGateway(t *testing.T) {
	left := testRecord().Config()
	renamed := testRecord()
	renamed.Name = "Telnyx (EU)"
	renamed.CodecPrefs = "PCMA,PCMU"
	renamed.MaxChannels = 40

	if !sameConfig(left, renamed.Config()) {
		t.Fatal("a rename or a codec-preference edit would restart the gateway")
	}

	moved := testRecord()
	moved.SIPProxy = "sip2.telnyx.example:5060"
	if sameConfig(left, moved.Config()) {
		t.Fatal("a changed proxy did not restart the gateway; it would fail over to an address that is gone")
	}
}

// The supervisor reconciles: a trunk that leaves the directory stops, one that arrives starts, and
// one that is unchanged is left alone.
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
	second.ID = "018f0000-0000-7000-8000-0000000000t2"
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

// An ip-auth trunk is UP as soon as it is configured. There is nothing to establish, and reporting
// `unknown` for ever would make every ip-auth carrier look broken on a dashboard.
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

// A supervisor that tracked carrier state and told nobody would be a dashboard that is always
// green, so it is refused at construction by name.
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
