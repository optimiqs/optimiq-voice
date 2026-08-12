package trunk

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"sync"
	"time"
)

// Registrar sends one REGISTER and reports what came back.
//
// # Why the seam is "send and tell me the outcome" and not "send"
//
// The gateway machine is a pure function of triggers and a clock, and it stays that way only if the
// thing that touches a socket hands back a TRIGGER rather than an error. So this returns the
// outcome in the machine's own vocabulary — accepted with a granted expiry, rejected with a status,
// challenged, or timed out — and the supervisor feeds it straight in. An implementation that
// returned `error` would force the supervisor to classify a transport failure as one of four
// triggers, which is a second opinion about what a 403 means.
//
// It is an interface so the supervisor is testable with no socket at all, which is the only way the
// backoff, the failover and the status-publication rules can be table-tested.
type Registrar interface {
	Register(ctx context.Context, config Config, registrar string, expires time.Duration) Result
}

// Result is one REGISTER's outcome, in the machine's vocabulary.
type Result struct {
	// Trigger is TriggerAccepted, TriggerRejected, TriggerChallenged or TriggerTimeout.
	Trigger Trigger
	// Status is the SIP status for a rejection.
	Status int
	// GrantedExpires is what the registrar actually gave us, which is frequently shorter than what
	// was asked for and is the one the refresh must be based on.
	GrantedExpires time.Duration
	// Err is for the log only. The machine never sees it.
	Err error
}

// Supervisor owns one gateway per registering trunk and drives it.
//
// # One goroutine per trunk, and the reason is the same one everywhere else in this service
//
// A Gateway is explicitly not safe for concurrent use, because a refresh racing a rejection has to
// have exactly one winner. So each gets a goroutine, its timers are that goroutine's own, and the
// supervisor's map is the only shared thing.
//
// # What it does with the directory
//
// It takes the trunk rows the `trunks` bucket delivered and starts a gateway for each. That is the
// sentence internal/trunk's package comment has been waiting for: the machine "decides WHEN to
// register, WHERE to register, how long to wait after a failure, when to fail over" and until now
// nothing delivered it any trunks to decide about. A trunk whose row says `ip-auth` gets a gateway
// too — it just never registers, and reports `up` as soon as it is configured, because reporting
// `unknown` for ever would make every ip-auth carrier look broken on a dashboard.
type Supervisor struct {
	registrar Registrar
	publisher Publisher
	backoff   Backoff
	log       *slog.Logger

	mu      sync.Mutex
	running map[string]*gatewayRunner
	wait    sync.WaitGroup
}

// SupervisorOptions configures a Supervisor.
type SupervisorOptions struct {
	// Registrar sends the REGISTERs. Required.
	Registrar Registrar
	// Publisher emits `trunk.status.changed`. Required — a supervisor that tracked carrier state and
	// told nobody would be a dashboard that is always green.
	Publisher Publisher
	// Backoff is the retry policy. Zero means DefaultBackoff.
	Backoff Backoff
	Logger  *slog.Logger
}

// NewSupervisor validates the options and builds a Supervisor.
func NewSupervisor(opts SupervisorOptions) (*Supervisor, error) {
	switch {
	case opts.Registrar == nil:
		return nil, errors.New("trunk: a registrar is required to supervise gateways")
	case opts.Publisher == nil:
		return nil, errors.New("trunk: a status publisher is required: a supervisor that tracked " +
			"carrier state and told nobody would be a dashboard that is always green")
	}
	supervisor := &Supervisor{
		registrar: opts.Registrar,
		publisher: opts.Publisher,
		backoff:   opts.Backoff,
		log:       opts.Logger,
		running:   make(map[string]*gatewayRunner),
	}
	if supervisor.backoff.Initial <= 0 {
		supervisor.backoff = DefaultBackoff()
	}
	if supervisor.log == nil {
		supervisor.log = slog.Default()
	}
	return supervisor, nil
}

// Apply reconciles the running gateways against a set of configurations.
//
// # Reconcile rather than "start", so a watch update is the same call as a boot
//
// The directory is watched, so a trunk can be added, edited or deleted at any moment. Modelling
// that as three operations would mean three code paths that could disagree about what an edit is;
// modelling it as "make the world look like this list" means the boot and the hundredth edit take
// the same path, and the only thing that varies is how much of it is a no-op.
//
// An EDITED trunk is stopped and restarted rather than mutated in place. That is the blunt choice
// and it is the right one: a Gateway's state — which registrar it is on, how many failures it has
// seen, when its refresh is due — is only meaningful relative to the configuration it was built
// from, and carrying it across a change of proxy or credential would mean a trunk that fails over
// to an address that no longer exists. The cost is one REGISTER, which is what a configuration
// change deserves anyway.
func (s *Supervisor) Apply(ctx context.Context, configs []Config) {
	desired := make(map[string]Config, len(configs))
	for _, config := range configs {
		desired[config.TrunkID] = config
	}

	s.mu.Lock()
	// Stop the ones that left or changed.
	for id, runner := range s.running {
		config, wanted := desired[id]
		if wanted && sameConfig(runner.config, config) {
			continue
		}
		runner.stop()
		delete(s.running, id)
		if wanted {
			s.log.Info("restarting a trunk whose configuration changed",
				"trunkId", id, "trunk", config.Name)
		} else {
			s.log.Info("stopping a trunk that left the directory", "trunkId", id)
		}
	}
	// Start the ones that arrived.
	for id, config := range desired {
		if _, already := s.running[id]; already {
			continue
		}
		runner, err := s.start(ctx, config)
		if err != nil {
			s.log.Error("cannot supervise a trunk", "trunkId", id, "trunk", config.Name, "error", err)
			continue
		}
		s.running[id] = runner
	}
	s.mu.Unlock()
}

// Len reports how many gateways are running.
func (s *Supervisor) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.running)
}

// Stop stops every gateway and waits for them.
//
// It does NOT unregister. A drain that unregistered would be the right thing and it needs a bounded
// context to do it in, which Stop does not have; the gateway machine already produces
// ActionSendUnregister on TriggerStop, and wiring a shutdown that uses it is the follow-up. Until
// then a stopped instance's registrations lapse on their granted interval, which is what a crash
// would do anyway.
func (s *Supervisor) Stop() {
	s.mu.Lock()
	for id, runner := range s.running {
		runner.stop()
		delete(s.running, id)
	}
	s.mu.Unlock()
	s.wait.Wait()
}

func (s *Supervisor) start(ctx context.Context, config Config) (*gatewayRunner, error) {
	gateway, err := New(Options{Config: config, Backoff: s.backoff})
	if err != nil {
		return nil, err
	}
	runnerCtx, cancel := context.WithCancel(ctx)
	runner := &gatewayRunner{
		gateway: gateway,
		config:  config,
		inputs:  make(chan Input, 4),
		cancel:  cancel,
	}
	s.wait.Add(1)
	go func() {
		defer s.wait.Done()
		s.run(runnerCtx, runner)
	}()
	runner.post(Input{Trigger: TriggerStart})
	return runner, nil
}

// run is one gateway's goroutine: read an input, step the machine, perform the actions.
func (s *Supervisor) run(ctx context.Context, runner *gatewayRunner) {
	defer runner.stopTimers()
	for {
		select {
		case <-ctx.Done():
			return
		case in := <-runner.inputs:
			if in.Fraction == 0 {
				// The jitter draw. Taken here rather than inside the machine so the machine stays a
				// pure function of its inputs and a test can supply a constant.
				in.Fraction = rand.Float64() //nolint:gosec // de-synchronising retries, not a secret
			}
			outcome := runner.gateway.Step(in)
			for _, action := range outcome.Actions {
				s.perform(ctx, runner, action)
			}
		}
	}
}

// perform executes one action from the machine.
func (s *Supervisor) perform(ctx context.Context, runner *gatewayRunner, action Action) {
	switch action.Kind {
	case ActionSendRegister:
		// On a goroutine of its own, so a carrier that does not answer for thirty-two seconds does not
		// stop this gateway from processing a Stop or a configuration change in the meantime. The
		// RESULT comes back through the mailbox, which is what keeps the machine single-threaded.
		s.wait.Add(1)
		go func() {
			defer s.wait.Done()
			result := s.registrar.Register(ctx, runner.config, action.Registrar, action.Expires)
			if result.Err != nil {
				s.log.Warn("a trunk REGISTER failed",
					"trunkId", runner.config.TrunkID, "registrar", action.Registrar, "error", result.Err)
			}
			runner.post(Input{
				Trigger:        result.Trigger,
				Status:         result.Status,
				GrantedExpires: result.GrantedExpires,
			})
		}()

	case ActionSendUnregister:
		s.wait.Add(1)
		go func() {
			defer s.wait.Done()
			// Expires zero is the unregister. Its outcome is not fed back: the machine has already
			// moved to its new state and a failure changes nothing it would do differently — the
			// binding lapses on its own interval either way.
			_ = s.registrar.Register(ctx, runner.config, action.Registrar, 0)
		}()

	case ActionScheduleRefresh:
		runner.arm(&runner.refresh, action.After, func() {
			runner.post(Input{Trigger: TriggerRefreshDue})
		})

	case ActionScheduleRetry:
		runner.arm(&runner.retry, action.After, func() {
			runner.post(Input{Trigger: TriggerRetryDue})
		})

	case ActionFailover:
		s.log.Warn("a trunk failed over to its secondary registrar",
			"trunkId", runner.config.TrunkID, "registrar", action.Registrar, "reason", action.Reason)

	case ActionPublishStatus:
		publishCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := s.publisher.StatusChanged(publishCtx, runner.config, action.Status, action.Reason); err != nil {
			// A status that cannot be published costs a stale column, not a call. Failing the gateway
			// here would take a working carrier down because a stream was slow.
			s.log.Warn("cannot publish a trunk status change",
				"trunkId", runner.config.TrunkID, "status", string(action.Status), "error", err)
		}
	}
}

// gatewayRunner is one gateway plus its mailbox and its two timers.
type gatewayRunner struct {
	gateway *Gateway
	config  Config
	inputs  chan Input
	cancel  context.CancelFunc

	mu      sync.Mutex
	refresh *time.Timer
	retry   *time.Timer
	stopped bool
}

// post enqueues an input, dropping it if the runner has stopped.
//
// Dropping rather than blocking, and it matters on exactly one path: a REGISTER whose response
// arrives after the trunk was deleted has nowhere to go, and a blocking send would leak the
// goroutine that is holding it.
func (r *gatewayRunner) post(in Input) {
	r.mu.Lock()
	stopped := r.stopped
	r.mu.Unlock()
	if stopped {
		return
	}
	select {
	case r.inputs <- in:
	default:
	}
}

func (r *gatewayRunner) arm(slot **time.Timer, after time.Duration, fire func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return
	}
	if *slot != nil {
		(*slot).Stop()
	}
	if after <= 0 {
		after = time.Second
	}
	*slot = time.AfterFunc(after, fire)
}

func (r *gatewayRunner) stop() {
	r.mu.Lock()
	r.stopped = true
	r.mu.Unlock()
	r.stopTimers()
	r.cancel()
}

func (r *gatewayRunner) stopTimers() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.refresh != nil {
		r.refresh.Stop()
		r.refresh = nil
	}
	if r.retry != nil {
		r.retry.Stop()
		r.retry = nil
	}
}

// sameConfig reports whether two configurations would produce the same registration behaviour.
//
// It compares the fields the machine READS and not the whole struct, deliberately: a trunk renamed
// in the admin UI, or one whose codec preferences changed, must not produce a REGISTER — and a
// struct comparison would restart the gateway for both. MaxChannels is likewise excluded; it is
// carried so a capacity refusal has somewhere to read it from and the machine never looks at it.
func sameConfig(left, right Config) bool {
	return left.Enabled == right.Enabled &&
		left.Register == right.Register &&
		left.Registrar == right.Registrar &&
		left.SecondaryRegistrar == right.SecondaryRegistrar &&
		left.OutboundProxy == right.OutboundProxy &&
		left.AuthUser == right.AuthUser &&
		left.AuthRealm == right.AuthRealm &&
		left.Contact == right.Contact &&
		left.Transport == right.Transport &&
		left.ExpiresSeconds == right.ExpiresSeconds
}
