package trunk

import (
	"context"
	"strings"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	testOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testTrunk = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b60"
)

func registeringConfig() Config {
	return Config{
		TrunkID:            testTrunk,
		OrgID:              testOrg,
		Name:               "telnyx-primary",
		Enabled:            true,
		Register:           true,
		Registrar:          "sip.telnyx.com",
		SecondaryRegistrar: "sip2.telnyx.com",
		AuthUser:           "optimiq",
		ExpiresSeconds:     600,
	}
}

func newGateway(t *testing.T, config Config) *Gateway {
	t.Helper()
	gateway, err := New(Options{
		Config:  config,
		Backoff: Backoff{Initial: time.Second, Max: time.Minute, Factor: 2},
		Now:     func() time.Time { return time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return gateway
}

func actionsOf(outcome Outcome) []ActionKind {
	kinds := make([]ActionKind, 0, len(outcome.Actions))
	for _, action := range outcome.Actions {
		kinds = append(kinds, action.Kind)
	}
	return kinds
}

// The whole ladder: unregistered → trying → registered, and the refresh that keeps it there.
func TestRegistrationLifecycle(t *testing.T) {
	gateway := newGateway(t, registeringConfig())

	start := gateway.Step(Input{Trigger: TriggerStart})
	if gateway.State() != StateTrying || !start.Has(ActionSendRegister) {
		t.Fatalf("start = %v / %s, want a REGISTER and trying", actionsOf(start), gateway.State())
	}
	if start.Actions[0].Registrar != "sip.telnyx.com" || start.Actions[0].Expires != 600*time.Second {
		t.Errorf("REGISTER = %+v, want the primary registrar and the configured expiry", start.Actions[0])
	}

	accepted := gateway.Step(Input{Trigger: TriggerAccepted, GrantedExpires: 300 * time.Second})
	if gateway.State() != StateRegistered || gateway.Status() != StatusUp {
		t.Fatalf("state/status = %s/%s, want registered/up", gateway.State(), gateway.Status())
	}
	if !accepted.Has(ActionScheduleRefresh) || accepted.Actions[0].After != 150*time.Second {
		t.Errorf("refresh = %+v, want half the GRANTED interval and not the requested one", accepted.Actions[0])
	}
	if !accepted.Has(ActionPublishStatus) {
		t.Error("becoming registered must publish a status")
	}

	refresh := gateway.Step(Input{Trigger: TriggerRefreshDue})
	if gateway.State() != StateTrying || !refresh.Has(ActionSendRegister) {
		t.Errorf("refresh = %v / %s, want another REGISTER", actionsOf(refresh), gateway.State())
	}

	// A second acceptance publishes NOTHING: the status did not change, and one event per refresh
	// would rewrite the same database column every few minutes for the life of the trunk.
	again := gateway.Step(Input{Trigger: TriggerAccepted, GrantedExpires: 300 * time.Second})
	if again.Has(ActionPublishStatus) {
		t.Error("an unchanged status must not be republished")
	}
}

// A failure counts, backs off, and reports `degraded` before `down`: a single lost REGISTER is not
// an outage, and paging on one is how an alert becomes noise.
func TestFailuresDegradeBeforeTheyGoDown(t *testing.T) {
	gateway := newGateway(t, registeringConfig())
	gateway.Step(Input{Trigger: TriggerStart})

	first := gateway.Step(Input{Trigger: TriggerRejected, Status: 500, Fraction: 0.5})
	if gateway.State() != StateFailing || gateway.Status() != StatusDegraded {
		t.Fatalf("state/status = %s/%s, want failing/degraded", gateway.State(), gateway.Status())
	}
	if !first.Has(ActionScheduleRetry) {
		t.Fatalf("actions = %v, want a retry scheduled", actionsOf(first))
	}

	// Attempt two: still degraded, and the wait has doubled.
	gateway.Step(Input{Trigger: TriggerRetryDue})
	second := gateway.Step(Input{Trigger: TriggerRejected, Status: 500, Fraction: 0.5})
	if gateway.Status() != StatusDegraded {
		t.Errorf("status = %s, want still degraded at attempt 2", gateway.Status())
	}
	firstWait := retryWait(t, first)
	secondWait := retryWait(t, second)
	if secondWait <= firstWait {
		t.Errorf("the second wait (%s) must exceed the first (%s)", secondWait, firstWait)
	}

	// Attempt three crosses the threshold.
	gateway.Step(Input{Trigger: TriggerRetryDue})
	third := gateway.Step(Input{Trigger: TriggerRejected, Status: 500, Fraction: 0.5})
	if gateway.Status() != StatusDown {
		t.Errorf("status = %s, want down at attempt 3", gateway.Status())
	}
	if !third.Has(ActionPublishStatus) {
		t.Error("crossing the threshold must publish")
	}
	if gateway.Attempt() != 3 {
		t.Errorf("attempt = %d, want 3", gateway.Attempt())
	}

	// And a success resets the counter completely, so a brief outage does not leave a long backoff
	// behind it.
	gateway.Step(Input{Trigger: TriggerRetryDue})
	gateway.Step(Input{Trigger: TriggerAccepted, GrantedExpires: 300 * time.Second})
	if gateway.Attempt() != 0 || gateway.Status() != StatusUp {
		t.Errorf("after recovery attempt/status = %d/%s, want 0/up", gateway.Attempt(), gateway.Status())
	}
}

func retryWait(t *testing.T, outcome Outcome) time.Duration {
	t.Helper()
	for _, action := range outcome.Actions {
		if action.Kind == ActionScheduleRetry {
			return action.After
		}
	}
	t.Fatalf("no retry in %v", actionsOf(outcome))
	return 0
}

// Failover is for a registrar that is unreachable, not for a credential that is wrong. Moving to
// the secondary with the same rejected identity is a second refusal for free.
func TestFailoverOnlyForReachabilityFailures(t *testing.T) {
	cases := []struct {
		name         string
		input        Input
		wantFailover bool
	}{
		{"a timeout is a reachability problem", Input{Trigger: TriggerTimeout}, true},
		{"a 500 is the registrar being broken", Input{Trigger: TriggerRejected, Status: 500}, true},
		{"a 503 is the registrar being unavailable", Input{Trigger: TriggerRejected, Status: 503}, true},
		{"a 403 is our credential, everywhere", Input{Trigger: TriggerRejected, Status: 403}, false},
		{"a 404 is our account, everywhere", Input{Trigger: TriggerRejected, Status: 404}, false},
		{"an unanswerable challenge is our credential", Input{Trigger: TriggerChallenged}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gateway := newGateway(t, registeringConfig())
			gateway.Step(Input{Trigger: TriggerStart})
			outcome := gateway.Step(tc.input)

			if outcome.Has(ActionFailover) != tc.wantFailover {
				t.Fatalf("failover = %v, want %v", outcome.Has(ActionFailover), tc.wantFailover)
			}
			if tc.wantFailover && gateway.Registrar() != "sip2.telnyx.com" {
				t.Errorf("registrar = %q, want the secondary", gateway.Registrar())
			}
			if !tc.wantFailover && gateway.Registrar() != "sip.telnyx.com" {
				t.Errorf("registrar = %q, want the primary", gateway.Registrar())
			}
		})
	}
}

func TestNoSecondaryMeansNoFailover(t *testing.T) {
	config := registeringConfig()
	config.SecondaryRegistrar = ""
	gateway := newGateway(t, config)
	gateway.Step(Input{Trigger: TriggerStart})

	outcome := gateway.Step(Input{Trigger: TriggerTimeout})
	if outcome.Has(ActionFailover) {
		t.Error("there is nowhere to fail over to")
	}
	if gateway.Registrar() != "sip.telnyx.com" {
		t.Errorf("registrar = %q", gateway.Registrar())
	}
}

// A trunk that does not register is UP as soon as it is configured. Reporting `unknown` forever
// would make every ip-auth carrier look broken on the dashboard.
func TestIPAuthTrunkIsUpWithNothingToEstablish(t *testing.T) {
	config := registeringConfig()
	config.Register = false
	gateway := newGateway(t, config)

	outcome := gateway.Step(Input{Trigger: TriggerStart})
	if outcome.Has(ActionSendRegister) {
		t.Error("an ip-auth trunk sends no REGISTER")
	}
	if gateway.Status() != StatusUp {
		t.Errorf("status = %s, want up", gateway.Status())
	}
}

func TestDisableAndStop(t *testing.T) {
	t.Run("disabling a registered trunk unregisters and reports disabled", func(t *testing.T) {
		gateway := newGateway(t, registeringConfig())
		gateway.Step(Input{Trigger: TriggerStart})
		gateway.Step(Input{Trigger: TriggerAccepted, GrantedExpires: 300 * time.Second})

		outcome := gateway.Step(Input{Trigger: TriggerDisable})
		if !outcome.Has(ActionSendUnregister) {
			t.Error("a clean stop owes the carrier an unregister, or it keeps routing calls here")
		}
		if gateway.State() != StateDisabled || gateway.Status() != StatusDisabled {
			t.Errorf("state/status = %s/%s, want disabled/disabled", gateway.State(), gateway.Status())
		}
		// A disabled trunk is not restarted by a tick.
		if gateway.Step(Input{Trigger: TriggerStart}).Has(ActionSendRegister) {
			t.Error("a disabled trunk must stay disabled until it is reconfigured")
		}
	})

	t.Run("stopping is a drain rather than an administrative change", func(t *testing.T) {
		gateway := newGateway(t, registeringConfig())
		gateway.Step(Input{Trigger: TriggerStart})
		gateway.Step(Input{Trigger: TriggerAccepted, GrantedExpires: 300 * time.Second})

		outcome := gateway.Step(Input{Trigger: TriggerStop})
		if !outcome.Has(ActionSendUnregister) || gateway.State() != StateUnregistered {
			t.Errorf("stop = %v / %s, want an unregister and unregistered", actionsOf(outcome), gateway.State())
		}
	})

	t.Run("a config that is disabled starts disabled", func(t *testing.T) {
		config := registeringConfig()
		config.Enabled = false
		gateway := newGateway(t, config)
		if gateway.State() != StateDisabled || gateway.Status() != StatusDisabled {
			t.Errorf("state/status = %s/%s", gateway.State(), gateway.Status())
		}
	})
}

// A timer that fires after the state moved on must not put a REGISTER on the wire outside the
// backoff — which is the one thing the backoff exists to prevent.
func TestStaleTimersAreIgnored(t *testing.T) {
	gateway := newGateway(t, registeringConfig())
	gateway.Step(Input{Trigger: TriggerStart})
	gateway.Step(Input{Trigger: TriggerRejected, Status: 500})

	if gateway.Step(Input{Trigger: TriggerRefreshDue}).Has(ActionSendRegister) {
		t.Error("a refresh timer that fires while failing must be ignored")
	}
	gateway.Step(Input{Trigger: TriggerRetryDue})
	gateway.Step(Input{Trigger: TriggerAccepted, GrantedExpires: 300 * time.Second})
	if gateway.Step(Input{Trigger: TriggerRetryDue}).Has(ActionSendRegister) {
		t.Error("a retry timer that fires while registered must be ignored")
	}
}

// Exponential, capped, and jittered — because a fixed interval turns a carrier outage into a
// synchronised REGISTER storm from the whole fleet.
func TestBackoffAfter(t *testing.T) {
	backoff := Backoff{Initial: time.Second, Max: 30 * time.Second, Factor: 2, Jitter: 0}

	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{1, time.Second},
		{2, 2 * time.Second},
		{3, 4 * time.Second},
		{4, 8 * time.Second},
		{6, 30 * time.Second},
		{20, 30 * time.Second},
		{0, time.Second},
		{-5, time.Second},
	}
	for _, tc := range cases {
		if got := backoff.After(tc.attempt, 0); got != tc.want {
			t.Errorf("After(%d) = %s, want %s", tc.attempt, got, tc.want)
		}
	}

	jittered := Backoff{Initial: 10 * time.Second, Max: time.Minute, Factor: 2, Jitter: 0.2}
	low := jittered.After(1, 0)
	high := jittered.After(1, 0.999999)
	middle := jittered.After(1, 0.5)
	if low != 8*time.Second {
		t.Errorf("the bottom of the jitter range = %s, want 8s", low)
	}
	if high < 11900*time.Millisecond || high > 12*time.Second {
		t.Errorf("the top of the jitter range = %s, want ~12s", high)
	}
	if middle != 10*time.Second {
		t.Errorf("the middle of the jitter range = %s, want the nominal 10s", middle)
	}

	// The jitter is CENTRED. A one-sided one would make a fleet retry faster than configured under
	// load, which is the opposite of what backoff is for.
	if jittered.After(1, 0) >= 10*time.Second {
		t.Error("the jitter must be able to shorten as well as lengthen")
	}
	// Defaults fill in for a zero policy rather than dividing by zero or retrying instantly.
	if (Backoff{}).After(1, 0) != time.Second {
		t.Error("a zero backoff must default rather than retry instantly")
	}
	if (Backoff{Initial: time.Second, Max: time.Minute, Factor: 2, Jitter: 5}).After(1, 0) != 0 {
		t.Error("a jitter above 1 is clamped to full randomisation")
	}
}

// The refresh point is half the granted interval, with a floor that keeps a very short grant from
// being refreshed after it has already lapsed.
func TestRefreshAfter(t *testing.T) {
	cases := []struct {
		expires time.Duration
		want    time.Duration
	}{
		{600 * time.Second, 300 * time.Second},
		{60 * time.Second, 30 * time.Second},
		{20 * time.Second, 10 * time.Second},
		{15 * time.Second, 10 * time.Second},
		{4 * time.Second, 2 * time.Second},
		{0, 0},
	}
	for _, tc := range cases {
		if got := RefreshAfter(tc.expires); got != tc.want {
			t.Errorf("RefreshAfter(%s) = %s, want %s", tc.expires, got, tc.want)
		}
	}
	for _, expires := range []time.Duration{4, 15, 20, 60, 600} {
		interval := expires * time.Second
		if refresh := RefreshAfter(interval); refresh >= interval {
			t.Errorf("RefreshAfter(%s) = %s, which is not before the expiry", interval, refresh)
		}
	}
}

func TestConfigValidate(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{"no id", func(c *Config) { c.TrunkID = "" }, "needs an id"},
		{"no org", func(c *Config) { c.OrgID = "" }, "needs an org"},
		{"registering with no registrar", func(c *Config) { c.Registrar = "" }, "needs a registrar"},
		{"registering with no auth user", func(c *Config) { c.AuthUser = "" }, "needs an auth user"},
		{"registering with no expiry", func(c *Config) { c.ExpiresSeconds = 0 }, "needs a positive expiry"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			config := registeringConfig()
			tc.mutate(&config)
			err := config.Validate()
			if err == nil {
				t.Fatal("Validate must refuse")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
			if _, err := New(Options{Config: config}); err == nil {
				t.Error("New must refuse a configuration Validate rejects")
			}
		})
	}

	// An ip-auth trunk needs none of the registration fields, which is the point of it.
	config := Config{TrunkID: testTrunk, OrgID: testOrg, Enabled: true}
	if err := config.Validate(); err != nil {
		t.Errorf("an ip-auth trunk must validate with no registrar: %v", err)
	}
}

// The envelope has to be right before the grant exists to try it, which is why it is asserted
// without a broker.
func TestStatusEnvelope(t *testing.T) {
	envelope, err := statusEnvelope(registeringConfig(), StatusUp, "registered", "sipd",
		time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("statusEnvelope: %v", err)
	}
	wantSubject := "trunk.evt.v1." + testOrg + "." + testTrunk + ".status.changed"
	if envelope.Subject != wantSubject {
		t.Errorf("subject = %q, want %q", envelope.Subject, wantSubject)
	}
	if envelope.Type != contract.EventTypeTrunkStatusChanged {
		t.Errorf("type = %q", envelope.Type)
	}
	if envelope.OrgID != testOrg || envelope.Source != "sipd" {
		t.Errorf("envelope = %+v", envelope)
	}
	if envelope.Data.Status != contract.TrunkStatusChangedStatusUp {
		t.Errorf("status = %q", envelope.Data.Status)
	}
	if envelope.Data.Reason == nil || *envelope.Data.Reason != "registered" {
		t.Error("the reason must travel on the payload")
	}
	if envelope.Data.Endpoint == nil || *envelope.Data.Endpoint != "sip.telnyx.com" {
		t.Error("the endpoint must travel on the payload")
	}
	// And the envelope must agree with its own subject, which is the tenancy check every consumer
	// on this backbone relies on.
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		t.Errorf("CheckSubject: %v", err)
	}

	if _, err := statusEnvelope(registeringConfig(), Status("sideways"), "", "sipd", time.Now()); err == nil {
		t.Error("a status outside the contract vocabulary must be refused before it is published")
	}
}

func TestRecordingPublisher(t *testing.T) {
	publisher := NewRecordingPublisher()
	if err := publisher.StatusChanged(context.Background(), registeringConfig(), StatusDown, "gone"); err != nil {
		t.Fatalf("StatusChanged: %v", err)
	}
	transitions := publisher.Transitions()
	if len(transitions) != 1 || transitions[0].Status != StatusDown || transitions[0].TrunkID != testTrunk {
		t.Errorf("transitions = %+v", transitions)
	}
}

func TestVocabulariesRender(t *testing.T) {
	for state := StateUnregistered; state <= StateDisabled; state++ {
		if state.String() == "unknown" {
			t.Errorf("state %d has no name", int(state))
		}
	}
	for trigger := TriggerStart; trigger <= TriggerStop; trigger++ {
		if trigger.String() == "unknown" {
			t.Errorf("trigger %d has no name", int(trigger))
		}
	}
	for kind := ActionSendRegister; kind <= ActionFailover; kind++ {
		if kind.String() == "unknown" {
			t.Errorf("action %d has no name", int(kind))
		}
	}
}
