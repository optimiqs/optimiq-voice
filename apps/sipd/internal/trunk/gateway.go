// Package trunk is the outbound gateway registration state machine: when to register, where, how
// long to wait after a failure, when to fail over, and what status to publish.
//
// Every decision is a pure function of its inputs and a clock, so it is table-testable. Trunk
// configuration is supplied by the caller; the intended ingestion seam is a `trunks` KV read model
// written by apps/api and watched here.
package trunk

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

// State is where one gateway registration is. `failing` is deliberately distinct from
// `unregistered`: a failing trunk is being retried on a backoff and must report as degraded, not as
// unconfigured.
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
	// StateDisabled means the trunk is administratively off. A state rather than an absence so a
	// disabled trunk reports `disabled` instead of falling silent.
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

// Config is one trunk's registration configuration. Field names mirror
// `packages/pbx-db/src/schema/trunks-schema.ts` where they overlap, so ingestion is a rename-free
// mapping.
type Config struct {
	// TrunkID is the trunk ROW id, the subject token for its status events. Not the name: a rename
	// would move the subject and strand a durable consumer mid-outage.
	TrunkID string
	// OrgID is the tenant. Required, because every status event's subject carries it.
	OrgID string
	// Name is the human label, for logs and for the status payload.
	Name string
	// Enabled is the administrative switch.
	Enabled bool
	// Register says whether this trunk registers OUTWARD at all. `ip-auth` trunks do not; for those
	// the machine stays at StateUnregistered, which is correct rather than a failure.
	Register bool
	// Kind is the carrier's authentication shape: `register` or `ip-auth`. Register is derived from
	// it at ingestion.
	Kind string
	// SIPDomain is the domain presented in From and To — the carrier's realm, not our own. A
	// carrier that does not recognise it refuses the INVITE, usually with a bare 403.
	SIPDomain string
	// SIPProxy is where INVITEs go, as a host or host:port. Distinct from Registrar: a carrier may
	// take registrations at one address and calls at another.
	SIPProxy string
	// Transport is the transport to use, lower-cased. Empty means "let the stack decide", which in
	// practice is UDP.
	Transport string
	// Registrar is where the REGISTER goes, as a host or host:port.
	Registrar string
	// SecondaryRegistrar is the failover target. Empty means there is none, and a failing trunk
	// simply retries the primary.
	SecondaryRegistrar string
	// OutboundProxy is where the REGISTER is SENT when the carrier is fronted by an SBC, while the
	// Request-URI still names the registrar.
	OutboundProxy string
	// AuthUser and AuthRealm are the digest identity. The secret never appears here; it is resolved
	// through the credential store.
	AuthUser  string
	AuthRealm string
	// SecretRef identifies the carrier credential; the password is resolved only when needed.
	SecretRef string
	// Contact is the address of record we bind. Usually this edge's own contact.
	Contact string
	// ExpiresSeconds is the registration interval to request.
	ExpiresSeconds int
	// MaxChannels is the concurrency cap, carried here for whoever enforces it.
	MaxChannels int
	// SRTPPolicy is this carrier's SDES-SRTP policy — `none`, `prefer` or `require` — overriding the
	// media plane's own default. Empty means the media plane decides, which is what a trunk written
	// before the column existed means. Carried here for whoever builds the media command; the
	// registration state machine never reads it.
	SRTPPolicy string
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

// Backoff is the retry policy for a failing registration. Exponential with a cap and jitter: a
// carrier is down for every replica at once, and without jitter the fleet retries in lockstep and
// storms the registrar during its recovery.
type Backoff struct {
	// Initial is the first wait after a failure.
	Initial time.Duration
	// Max caps it.
	Max time.Duration
	// Factor multiplies each attempt.
	Factor float64
	// Jitter is the fraction of the computed interval that is randomised, in [0,1]. 0.2 means the
	// wait lands anywhere in ±20% of the nominal value.
	Jitter float64
}

// DefaultBackoff is what a trunk gets when nothing is configured: two seconds, doubling, capped at
// two minutes, with 20% jitter. The cap is short because a trunk must not stay dark for long after
// the carrier returns; the initial wait is non-zero because a first failure is usually transient.
func DefaultBackoff() Backoff {
	return Backoff{Initial: 2 * time.Second, Max: 2 * time.Minute, Factor: 2, Jitter: 0.2}
}

// After computes the wait before attempt number `attempt`, counting the first failure as 1.
// `fraction` is the jitter draw in [0,1) — rand.Float64() in production, a constant in tests.
func (b Backoff) After(attempt int, fraction float64) time.Duration {
	attempt = max(attempt, 1)
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

	nominal := min(float64(initial)*math.Pow(factor, float64(attempt-1)), float64(maximum))
	jitter := b.Jitter
	switch {
	case jitter <= 0:
		return time.Duration(nominal)
	case jitter > 1:
		jitter = 1
	}
	fraction = max(fraction, 0)
	if fraction >= 1 {
		fraction = 0.999999
	}
	// Centred on the nominal value: (1-jitter) to (1+jitter). A one-sided jitter would make the
	// fleet retry faster than configured under load.
	scale := 1 - jitter + 2*jitter*fraction
	return time.Duration(nominal * scale)
}

// Trigger is one input to the gateway machine.
type Trigger int

const (
	// TriggerStart begins registration, or resumes it after a stop.
	TriggerStart Trigger = iota
	// TriggerAccepted is a 200 to our REGISTER, carrying the GRANTED expiry — often shorter than
	// the one requested, and the one the refresh must be based on.
	TriggerAccepted
	// TriggerRejected is a final failure response; its status decides whether failover is worth
	// trying (see shouldFailover).
	TriggerRejected
	// TriggerChallenged is a 401 or 407 that we could NOT answer — no credential, or an unknown
	// realm. sipgo answers answerable challenges inside the same transaction.
	TriggerChallenged
	// TriggerTimeout is Timer F on the REGISTER: no answer at all.
	TriggerTimeout
	// TriggerRefreshDue is the refresh point of a live registration.
	TriggerRefreshDue
	// TriggerRetryDue is the end of a backoff.
	TriggerRetryDue
	// TriggerDisable turns the trunk administratively off; TriggerStop unregisters without
	// disabling (a draining pod).
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
	// ActionSendUnregister sends a REGISTER with Expires: 0. Without it the carrier keeps routing
	// calls to a departed node for the rest of the registration interval.
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

// Status is the vocabulary of `trunk.status.changed`, mirrored verbatim here so this pure state
// machine does not depend on the contract module.
type Status string

const (
	// StatusUnknown is a trunk nothing has been established about yet.
	StatusUnknown Status = "unknown"
	// StatusUp is registered, or a non-registering trunk that is reachable.
	StatusUp Status = "up"
	// StatusDown is a trunk that has failed past the degraded threshold.
	StatusDown Status = "down"
	// StatusDegraded is a trunk that has failed and is being retried. A single lost REGISTER is not
	// an outage and must not page anyone.
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
	return slices.ContainsFunc(o.Actions, func(action Action) bool { return action.Kind == kind })
}

// Gateway is one trunk's registration machine. Not safe for concurrent use: one goroutine drives
// one gateway, so a refresh racing a rejection has exactly one winner.
type Gateway struct {
	config  Config
	backoff Backoff
	// degradedFor is how many consecutive failures are reported as `degraded` before `down`.
	degradedFor int

	state State
	// attempt counts consecutive failures; it resets on every success so the backoff recovers fully.
	attempt int
	// onSecondary records which registrar the next attempt uses.
	onSecondary bool
	// status is the last status published, so a transition is published once per change.
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
			// A trunk that does not register is UP as soon as it is configured: there is nothing
			// to establish, and `unknown` forever would make every ip-auth carrier look broken.
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
			// A refresh timer that fired after the registration already failed. Acting on it would
			// put a REGISTER on the wire outside the backoff.
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

// shouldFailover decides whether the OTHER registrar is worth trying. Failover is for a registrar
// that is unreachable or broken (timeout, 5xx, 6xx), never for a credential that is wrong: the
// secondary is the same carrier with the same identity, so a 4xx would just be refused twice.
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

// statusActions publishes a status only when it CHANGED: a long outage must not emit one event per
// backoff interval onto the stream a durable consumer writes to the database from.
func (g *Gateway) statusActions(status Status, reason string) []Action {
	if g.status == status {
		return nil
	}
	g.status = status
	return []Action{{Kind: ActionPublishStatus, Status: status, Reason: reason}}
}

// RefreshAfter is when a live registration must be refreshed: half the granted interval, falling
// back to expiry-minus-five when half would be under ten seconds. A fixed "expiry minus thirty"
// would go negative on short grants and lapse the registration every time.
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
