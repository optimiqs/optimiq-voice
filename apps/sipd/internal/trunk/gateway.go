// Package trunk is the outbound gateway registration state machine.
//
// # What is missing today, and what this replaces
//
// The parity audit's row 1.27 records the state of trunk registration on the production plane: the
// only `type = registration` blocks in the repository live in an EXAMPLE file with placeholders
// that nothing includes, `pjsip_wizard.conf` still registers to the deleted Routr proxy's
// placeholder host, no code turns a `trunk` row into any of it, and there is no gateway state
// machine anywhere. Row 1.7 adds the other half: nothing reads registration state back into
// `trunk.status*`.
//
// This package is that state machine. It decides WHEN to register, WHERE to register, how long to
// wait after a failure, when to fail over to a secondary registrar, and what status transition to
// publish — and it decides all of it as a pure function of inputs and a clock, so every one of
// those decisions is a table test rather than a stopwatch.
//
// # Where the configuration comes from, and what is missing
//
// Nothing delivers trunk configuration to sipd today. There is no provisioning path, no watched
// read model and no RPC: the `trunk` table lives in packages/pbx-db and is read by apps/api, and
// the SIP edge holds no handle on either. So this package defines the struct it NEEDS (Config
// below), takes it from a caller, and names the ingestion seam explicitly: a `trunks` KV read model
// written by apps/api from the table and watched here, on the exact pattern design §8.1 prescribes
// for the ACL read model and `did-index.publisher.ts` already implements for DIDs. Until that
// exists a deployment configures trunks in process, which is honest and is not a deployment story.
package trunk

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

// State is where one gateway registration is.
//
// Four states and not three: `failing` is separate from `unregistered` because they differ in the
// only way that matters operationally — an unregistered trunk is one nobody has tried yet, and a
// failing one is a trunk that is being retried on a backoff and whose status should already be
// visible as degraded. Collapsing them produces a dashboard that shows a carrier as "not
// configured" during an outage.
type State int

const (
	// StateUnregistered is the initial state: configured, never attempted, or deliberately stopped.
	StateUnregistered State = iota
	// StateTrying means a REGISTER is on the wire and no answer has come back.
	StateTrying
	// StateRegistered means the registrar accepted us and we hold a binding until its expiry.
	StateRegistered
	// StateFailing means the last attempt failed and the next one is waiting out a backoff.
	StateFailing
	// StateDisabled means the trunk is administratively off. It is a state rather than an absence
	// so a disabled trunk still reports `disabled` rather than falling silent, which is the
	// difference between "we turned it off" and "we lost it".
	StateDisabled
)

// String renders the state for logs and for the status reason.
func (s State) String() string {
	switch s {
	case StateUnregistered:
		return "unregistered"
	case StateTrying:
		return "trying"
	case StateRegistered:
		return "registered"
	case StateFailing:
		return "failing"
	case StateDisabled:
		return "disabled"
	default:
		return "unknown"
	}
}

// Config is one trunk's registration configuration.
//
// The field names mirror `packages/pbx-db/src/schema/trunks-schema.ts` where they overlap
// (`sipProxy`, `outboundProxy`, `authUser`, `registerExpiresSeconds`), deliberately, so the
// ingestion seam is a rename-free mapping when it arrives.
type Config struct {
	// TrunkID is the trunk ROW id — the subject token for its status events. Not the name: a tenant
	// may rename a trunk while it is down, and a subject that moved under a rename would strand a
	// durable consumer mid-outage (the argument already written on TrunkSubject).
	TrunkID string
	// OrgID is the tenant. Required, because every status event's subject carries it.
	OrgID string
	// Name is the human label, for logs and for the status payload.
	Name string
	// Enabled is the administrative switch.
	Enabled bool
	// Register says whether this trunk registers OUTWARD at all. A great many carrier trunks do
	// not: they authenticate our source IP and expect INVITEs with no registration behind them
	// (`kind: "ip-auth"` in the schema). For those this machine stays at StateUnregistered
	// forever, and that is the correct state rather than a failure.
	Register bool
	// Registrar is where the REGISTER goes, as a host or host:port.
	Registrar string
	// SecondaryRegistrar is the failover target. Empty means there is none, and a failing trunk
	// simply retries the primary.
	SecondaryRegistrar string
	// OutboundProxy is where the REGISTER is SENT when the carrier is fronted by an SBC, while the
	// Request-URI still names the registrar. Same split as everywhere else in this service:
	// the address stays the address and the destination is where the packet goes.
	OutboundProxy string
	// AuthUser and AuthRealm are the digest identity. The secret itself never appears here: it is
	// resolved through the credential store, on the same argument that keeps the provisioning key
	// off this process.
	AuthUser  string
	AuthRealm string
	// Contact is the address of record we bind. Usually this edge's own contact.
	Contact string
	// ExpiresSeconds is the registration interval to request.
	ExpiresSeconds int
	// MaxChannels is the concurrency cap. It is not this machine's business and is carried so a
	// capacity refusal has somewhere to read it from.
	MaxChannels int
}

// Validate refuses a configuration that cannot work, at the point it is ingested rather than at the
// first REGISTER.
func (c Config) Validate() error {
	var problems []string
	if strings.TrimSpace(c.TrunkID) == "" {
		problems = append(problems, "a trunk needs an id")
	}
	if strings.TrimSpace(c.OrgID) == "" {
		problems = append(problems, "a trunk needs an org: every status event's subject carries one")
	}
	if c.Register {
		if strings.TrimSpace(c.Registrar) == "" {
			problems = append(problems, "a registering trunk needs a registrar")
		}
		if strings.TrimSpace(c.AuthUser) == "" {
			problems = append(problems, "a registering trunk needs an auth user")
		}
		if c.ExpiresSeconds <= 0 {
			problems = append(problems, "a registering trunk needs a positive expiry")
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("trunk %q is misconfigured:\n  - %s",
			orName(c), strings.Join(problems, "\n  - "))
	}
	return nil
}

func orName(c Config) string {
	if c.Name != "" {
		return c.Name
	}
	return c.TrunkID
}

// Backoff is the retry policy for a failing registration.
//
// # Why exponential with a cap and jitter, and not a fixed interval
//
// A carrier that is down is down for every one of our instances at once. A fixed retry interval
// turns a carrier outage into a synchronised REGISTER storm from the whole fleet, arriving at the
// same instant every N seconds — which is a denial of service we aim at our own supplier's
// recovery. Exponential backoff spreads the load out over the outage; the cap stops a long outage
// from turning into an hour-long blind spot after the carrier comes back; and the jitter is what
// actually de-synchronises the replicas, because without it exponential backoff is still perfectly
// aligned.
type Backoff struct {
	// Initial is the first wait after a failure.
	Initial time.Duration
	// Max caps it.
	Max time.Duration
	// Factor multiplies each attempt. Two is the conventional choice and is what the comments
	// assume.
	Factor float64
	// Jitter is the fraction of the computed interval that is randomised, in [0,1]. 0.2 means the
	// wait lands anywhere in ±20% of the nominal value.
	Jitter float64
}

// DefaultBackoff is what a trunk gets when nothing is configured: two seconds, doubling, capped at
// two minutes, with 20% jitter.
//
// Two minutes rather than an hour because a carrier outage is usually short and the cost of a
// too-long cap is a trunk that stays down for minutes after the carrier is back. Two seconds rather
// than instant because the first failure is very often a transient DNS or TLS error, and an instant
// retry into one of those is two failures instead of one.
func DefaultBackoff() Backoff {
	return Backoff{Initial: 2 * time.Second, Max: 2 * time.Minute, Factor: 2, Jitter: 0.2}
}

// After computes the wait before attempt number `attempt`, counting the first failure as 1.
//
// `fraction` is a value in [0,1) — rand.Float64() in production, a constant in a test, which is how
// the jitter stays testable without a fake random source.
func (b Backoff) After(attempt int, fraction float64) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	initial := b.Initial
	if initial <= 0 {
		initial = time.Second
	}
	factor := b.Factor
	if factor < 1 {
		factor = 2
	}
	maximum := b.Max
	if maximum <= 0 {
		maximum = time.Minute
	}

	nominal := float64(initial) * math.Pow(factor, float64(attempt-1))
	if nominal > float64(maximum) {
		nominal = float64(maximum)
	}
	jitter := b.Jitter
	switch {
	case jitter <= 0:
		return time.Duration(nominal)
	case jitter > 1:
		jitter = 1
	}
	if fraction < 0 {
		fraction = 0
	}
	if fraction >= 1 {
		fraction = 0.999999
	}
	// Centred on the nominal value: (1-jitter) to (1+jitter). A one-sided jitter that only ever
	// shortens the wait would make a fleet retry faster than configured under load, which is the
	// opposite of what backoff is for.
	scale := 1 - jitter + 2*jitter*fraction
	return time.Duration(nominal * scale)
}

// Trigger is one input to the gateway machine.
type Trigger int

const (
	// TriggerStart begins registration, or resumes it after a stop.
	TriggerStart Trigger = iota
	// TriggerAccepted is a 200 to our REGISTER. It carries the GRANTED expiry, which is frequently
	// shorter than the one we asked for and is the one the refresh must be based on.
	TriggerAccepted
	// TriggerRejected is a final failure response. The status decides whether a failover is worth
	// trying — a 403 means the credential is wrong everywhere, and moving to the secondary
	// registrar with the same wrong credential is a second rejection for free.
	TriggerRejected
	// TriggerChallenged is a 401 or 407. It is NOT a failure: sipgo answers a digest challenge
	// inside the same transaction, so this exists for the case where the challenge could not be
	// answered — no credential, or a realm we hold nothing for.
	TriggerChallenged
	// TriggerTimeout is Timer F on the REGISTER: no answer at all.
	TriggerTimeout
	// TriggerRefreshDue is the refresh point of a live registration.
	TriggerRefreshDue
	// TriggerRetryDue is the end of a backoff.
	TriggerRetryDue
	// TriggerDisable turns the trunk administratively off, and TriggerStop unregisters without
	// disabling — the difference between "this tenant switched it off" and "this pod is draining".
	TriggerDisable
	TriggerStop
)

// String renders the trigger for logs and test failures.
func (t Trigger) String() string {
	switch t {
	case TriggerStart:
		return "start"
	case TriggerAccepted:
		return "accepted"
	case TriggerRejected:
		return "rejected"
	case TriggerChallenged:
		return "challenged"
	case TriggerTimeout:
		return "timeout"
	case TriggerRefreshDue:
		return "refresh-due"
	case TriggerRetryDue:
		return "retry-due"
	case TriggerDisable:
		return "disable"
	case TriggerStop:
		return "stop"
	default:
		return "unknown"
	}
}

// Input is a trigger plus its data.
type Input struct {
	Trigger Trigger
	// Status is the SIP status for TriggerRejected.
	Status int
	// GrantedExpires is what the registrar actually gave us, for TriggerAccepted.
	GrantedExpires time.Duration
	// Fraction is the jitter draw for a backoff computation.
	Fraction float64
	// At is the instant; zero means the machine's own clock.
	At time.Time
}

// ActionKind is one thing the owner of a gateway must do.
type ActionKind int

const (
	// ActionSendRegister sends a REGISTER to the named registrar with the named expiry.
	ActionSendRegister ActionKind = iota
	// ActionSendUnregister sends a REGISTER with Expires: 0. It is what a clean shutdown owes the
	// carrier: without it the carrier keeps routing calls at a node that has gone, for the whole
	// remaining registration interval.
	ActionSendUnregister
	// ActionScheduleRefresh arms the refresh timer.
	ActionScheduleRefresh
	// ActionScheduleRetry arms the backoff timer.
	ActionScheduleRetry
	// ActionPublishStatus emits a `trunk.status.changed`.
	ActionPublishStatus
	// ActionFailover records that the next attempt uses the other registrar.
	ActionFailover
)

// String renders the action kind for logs and test failures.
func (k ActionKind) String() string {
	switch k {
	case ActionSendRegister:
		return "send-register"
	case ActionSendUnregister:
		return "send-unregister"
	case ActionScheduleRefresh:
		return "schedule-refresh"
	case ActionScheduleRetry:
		return "schedule-retry"
	case ActionPublishStatus:
		return "publish-status"
	case ActionFailover:
		return "failover"
	default:
		return "unknown"
	}
}

// Action is one instruction from the machine.
type Action struct {
	Kind ActionKind
	// Registrar is where a REGISTER goes.
	Registrar string
	// Expires is the interval to request, or zero for an unregister.
	Expires time.Duration
	// After is the delay for a scheduled action.
	After time.Duration
	// Status is the status to publish.
	Status Status
	// Reason is a short token explaining the status.
	Reason string
}

// Status is the vocabulary of `trunk.status.changed`, mirrored here so this package does not depend
// on the contract module for a pure state machine. The values are the contract's verbatim.
type Status string

const (
	// StatusUnknown is a trunk nothing has been established about yet.
	StatusUnknown Status = "unknown"
	// StatusUp is registered, or a non-registering trunk that is reachable.
	StatusUp Status = "up"
	// StatusDown is a trunk that has failed past the degraded threshold.
	StatusDown Status = "down"
	// StatusDegraded is a trunk that has failed and is being retried. It is the honest state for
	// the first few failures: a single lost REGISTER is not an outage, and reporting `down` for one
	// would page somebody every time a packet is dropped.
	StatusDegraded Status = "degraded"
	// StatusDisabled is administratively off.
	StatusDisabled Status = "disabled"
)

// Outcome is what one Step did.
type Outcome struct {
	From    State
	To      State
	Actions []Action
}

// Has reports whether the outcome contains an action of the given kind.
func (o Outcome) Has(kind ActionKind) bool {
	for _, action := range o.Actions {
		if action.Kind == kind {
			return true
		}
	}
	return false
}

// Gateway is one trunk's registration machine.
//
// Not safe for concurrent use: one goroutine drives one gateway, the same discipline the dialog
// layer uses and for the same reason — a refresh racing a rejection has to have exactly one winner.
type Gateway struct {
	config  Config
	backoff Backoff
	// degradedFor is how many consecutive failures are reported as `degraded` before `down`. Three
	// is the default: at the default backoff that is roughly fourteen seconds of trouble before
	// anybody is told the trunk is out, which is longer than any transient and shorter than any
	// human notices.
	degradedFor int

	state State
	// attempt counts consecutive failures. It resets on every success, which is what makes the
	// backoff recover fully rather than staying long after a brief outage.
	attempt int
	// onSecondary records which registrar the next attempt uses.
	onSecondary bool
	// status is the last status published, so a transition is published once rather than on every
	// retry of an outage.
	status Status
	// expires is the granted interval of the live registration.
	expires    time.Duration
	registered time.Time
	now        func() time.Time
}

// Options configures a Gateway.
type Options struct {
	Config  Config
	Backoff Backoff
	// DegradedFor is the consecutive-failure count before the status moves from degraded to down.
	DegradedFor int
	Now         func() time.Time
}

// ErrDisabledTrunk refuses to build a machine for a trunk that is administratively off, so a caller
// cannot accidentally start one.
var ErrDisabledTrunk = errors.New("trunk: the trunk is disabled")

// New validates the configuration and builds a gateway in its initial state.
func New(opts Options) (*Gateway, error) {
	if err := opts.Config.Validate(); err != nil {
		return nil, err
	}
	gateway := &Gateway{
		config:      opts.Config,
		backoff:     opts.Backoff,
		degradedFor: opts.DegradedFor,
		state:       StateUnregistered,
		status:      StatusUnknown,
		now:         opts.Now,
	}
	if gateway.backoff.Initial <= 0 {
		gateway.backoff = DefaultBackoff()
	}
	if gateway.degradedFor <= 0 {
		gateway.degradedFor = 3
	}
	if gateway.now == nil {
		gateway.now = time.Now
	}
	if !opts.Config.Enabled {
		gateway.state = StateDisabled
		gateway.status = StatusDisabled
	}
	return gateway, nil
}

// State reports where the gateway is.
func (g *Gateway) State() State { return g.state }

// Status reports the last status published.
func (g *Gateway) Status() Status { return g.status }

// Attempt reports how many consecutive failures the gateway has seen.
func (g *Gateway) Attempt() int { return g.attempt }

// Registrar reports where the next REGISTER goes, which is the secondary after a failover.
func (g *Gateway) Registrar() string {
	if g.onSecondary && g.config.SecondaryRegistrar != "" {
		return g.config.SecondaryRegistrar
	}
	return g.config.Registrar
}

// Config reports the configuration this gateway was built from.
func (g *Gateway) Config() Config { return g.config }

// Step feeds one input to the machine.
func (g *Gateway) Step(in Input) Outcome {
	at := in.At
	if at.IsZero() {
		at = g.now()
	}
	from := g.state

	switch in.Trigger {
	case TriggerDisable:
		g.state = StateDisabled
		g.attempt = 0
		actions := g.statusActions(StatusDisabled, "administratively disabled")
		if from == StateRegistered {
			actions = append([]Action{{
				Kind: ActionSendUnregister, Registrar: g.Registrar(),
			}}, actions...)
		}
		return Outcome{From: from, To: g.state, Actions: actions}

	case TriggerStop:
		g.state = StateUnregistered
		g.attempt = 0
		if from == StateRegistered {
			return Outcome{From: from, To: g.state, Actions: []Action{{
				Kind: ActionSendUnregister, Registrar: g.Registrar(),
			}}}
		}
		return Outcome{From: from, To: g.state}

	case TriggerStart:
		if from == StateDisabled {
			// A disabled trunk is not started by a tick. It is started by being re-enabled, which
			// is a configuration change and comes in as a new Config.
			return Outcome{From: from, To: from}
		}
		if !g.config.Register {
			// A trunk that does not register is UP as soon as it is configured: there is nothing to
			// establish, and reporting `unknown` forever would make every ip-auth carrier look
			// broken on the dashboard.
			g.state = StateUnregistered
			return Outcome{From: from, To: g.state,
				Actions: g.statusActions(StatusUp, "ip-auth trunk; no registration to establish")}
		}
		g.state = StateTrying
		return Outcome{From: from, To: g.state, Actions: []Action{{
			Kind:      ActionSendRegister,
			Registrar: g.Registrar(),
			Expires:   time.Duration(g.config.ExpiresSeconds) * time.Second,
		}}}

	case TriggerAccepted:
		g.state = StateRegistered
		g.attempt = 0
		g.registered = at
		g.expires = in.GrantedExpires
		if g.expires <= 0 {
			g.expires = time.Duration(g.config.ExpiresSeconds) * time.Second
		}
		actions := []Action{{Kind: ActionScheduleRefresh, After: RefreshAfter(g.expires)}}
		return Outcome{From: from, To: g.state,
			Actions: append(actions, g.statusActions(StatusUp, "registered")...)}

	case TriggerRefreshDue:
		if from != StateRegistered {
			// A refresh timer that fires after the registration already failed. Ignored rather than
			// acted on: acting would put a REGISTER on the wire outside the backoff, which is the
			// one thing the backoff exists to prevent.
			return Outcome{From: from, To: from}
		}
		g.state = StateTrying
		return Outcome{From: from, To: g.state, Actions: []Action{{
			Kind:      ActionSendRegister,
			Registrar: g.Registrar(),
			Expires:   time.Duration(g.config.ExpiresSeconds) * time.Second,
		}}}

	case TriggerRetryDue:
		if from != StateFailing {
			return Outcome{From: from, To: from}
		}
		g.state = StateTrying
		return Outcome{From: from, To: g.state, Actions: []Action{{
			Kind:      ActionSendRegister,
			Registrar: g.Registrar(),
			Expires:   time.Duration(g.config.ExpiresSeconds) * time.Second,
		}}}

	case TriggerRejected, TriggerChallenged, TriggerTimeout:
		return g.fail(in, from)
	}
	return Outcome{From: from, To: from}
}

// fail is the whole failure path: count it, decide whether to fail over, arm the backoff, and
// publish a status if this failure changed it.
func (g *Gateway) fail(in Input, from State) Outcome {
	g.attempt++
	g.state = StateFailing

	actions := make([]Action, 0, 3)
	if g.shouldFailover(in) {
		g.onSecondary = !g.onSecondary
		actions = append(actions, Action{
			Kind:      ActionFailover,
			Registrar: g.Registrar(),
			Reason:    failoverReason(in),
		})
	}
	actions = append(actions, Action{
		Kind:  ActionScheduleRetry,
		After: g.backoff.After(g.attempt, in.Fraction),
	})

	status := StatusDegraded
	if g.attempt >= g.degradedFor {
		status = StatusDown
	}
	return Outcome{From: from, To: g.state,
		Actions: append(actions, g.statusActions(status, failureReason(in))...)}
}

// shouldFailover decides whether the OTHER registrar is worth trying.
//
// # The rule, and the one it replaces
//
// Failover is for a registrar that is unreachable or broken, not for a credential that is wrong. A
// 403 or a 404 means the carrier considered our identity and declined it, and the secondary
// registrar is the same carrier with the same identity — so moving to it produces a second refusal,
// twice the log noise and a trunk that flaps between two addresses while an operator looks for a
// network problem that does not exist. A timeout, a 5xx or a 6xx is the reachability case, and that
// is what a secondary is for.
func (g *Gateway) shouldFailover(in Input) bool {
	if g.config.SecondaryRegistrar == "" {
		return false
	}
	switch in.Trigger {
	case TriggerTimeout:
		return true
	case TriggerChallenged:
		// We could not answer the challenge. That is our credential, not their address.
		return false
	case TriggerRejected:
		return in.Status >= 500
	default:
		return false
	}
}

// statusActions publishes a status only when it CHANGED.
//
// Publishing on every retry of a long outage would put one event per backoff interval per trunk on
// a stream a durable consumer writes to the database from, and the column would be rewritten with
// the same value hundreds of times for one incident.
func (g *Gateway) statusActions(status Status, reason string) []Action {
	if g.status == status {
		return nil
	}
	g.status = status
	return []Action{{Kind: ActionPublishStatus, Status: status, Reason: reason}}
}

// RefreshAfter is when a live registration must be refreshed.
//
// Half the granted interval, floored at ten seconds and with a hard floor of the interval minus
// five seconds for very short grants. Half rather than "expiry minus thirty" because a carrier that
// grants sixty seconds would then be refreshed at thirty either way, while one that grants twenty
// would be refreshed at minus ten — which is a registration that lapses every time.
func RefreshAfter(expires time.Duration) time.Duration {
	if expires <= 0 {
		return 0
	}
	half := expires / 2
	if half < 10*time.Second {
		if expires <= 5*time.Second {
			return expires / 2
		}
		return expires - 5*time.Second
	}
	return half
}

func failureReason(in Input) string {
	switch in.Trigger {
	case TriggerTimeout:
		return "no response from the registrar"
	case TriggerChallenged:
		return "the registrar challenged and no credential answered it"
	default:
		return fmt.Sprintf("the registrar answered %d", in.Status)
	}
}

func failoverReason(in Input) string {
	if in.Trigger == TriggerTimeout {
		return "the primary registrar did not answer"
	}
	return fmt.Sprintf("the primary registrar answered %d", in.Status)
}
