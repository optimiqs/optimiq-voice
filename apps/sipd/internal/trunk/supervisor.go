package trunk

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"sync"
	"time"
)

// Registrar sends one REGISTER and reports the outcome in the machine's own vocabulary — accepted,
// rejected, challenged or timed out — rather than as an error. Returning an error would force the
// supervisor to classify it, which is a second opinion about what a 403 means.
//
// It is an interface so the supervisor is testable with no socket.
type Registrar interface {
	Register(ctx context.Context, config Config, registrar string, expires time.Duration) Result
}

// Result is one REGISTER's outcome, in the machine's vocabulary.
type Result struct {
	// Trigger is TriggerAccepted, TriggerRejected, TriggerChallenged or TriggerTimeout.
	Trigger Trigger
	// Status is the SIP status for a rejection.
	Status int
	// GrantedExpires is what the registrar actually gave us — often shorter than what was asked
	// for, and the one the refresh must be based on.
	GrantedExpires time.Duration
	// Err is for the log only. The machine never sees it.
	Err error
}

// Supervisor owns one gateway per trunk from the directory and drives each on its own goroutine,
// because a Gateway is not safe for concurrent use. The supervisor's map is the only shared state.
//
// An `ip-auth` trunk gets a gateway too; it never registers and reports `up` once configured.
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
	// Publisher emits `trunk.status.changed`. Required: a supervisor that told nobody would be a
	// dashboard that is always green.
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

// Apply reconciles the running gateways against a set of configurations, so a boot and a watch
// update take the same path.
//
// An EDITED trunk is stopped and restarted rather than mutated: a Gateway's state (which registrar
// it is on, its failure count, when its refresh is due) is only meaningful relative to the
// configuration it was built from.
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

// Stop stops every gateway and waits for them. It does NOT unregister: that needs a bounded
// context Stop does not have, so registrations lapse on their granted interval.
//
// TODO: wire a drain that feeds TriggerStop and sends the resulting ActionSendUnregister, once Stop
// takes a context.
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
		log:     s.log,
	}
	s.wait.Go(func() { s.run(runnerCtx, runner) })
	// Jittered, not immediate: the first registration after a fleet restart or a directory replay is
	// N trunks x M instances REGISTERing in the same millisecond at a carrier that is UP. The spread
	// is a fraction of the backoff's own initial interval.
	delay := time.Duration(rand.Float64() * float64(s.backoff.Initial)) //nolint:gosec // de-synchronising registrations, not a secret
	runner.arm(&runner.retry, delay, func() { runner.post(Input{Trigger: TriggerStart}) })
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
		// On its own goroutine, so a carrier that does not answer cannot stop this gateway from
		// processing a Stop or a configuration change. The RESULT comes back through the mailbox,
		// which is what keeps the machine single-threaded.
		s.wait.Go(func() {
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
		})

	case ActionSendUnregister:
		s.wait.Go(func() {
			// Expires zero is the unregister. Its outcome is not fed back: the machine has already
			// moved on and the binding lapses on its own interval either way.
			_ = s.registrar.Register(ctx, runner.config, action.Registrar, 0)
		})

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
			// A status that cannot be published costs a stale column, not a call.
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
	log     *slog.Logger

	mu      sync.Mutex
	refresh *time.Timer
	retry   *time.Timer
	stopped bool
}

// post enqueues an input, dropping it only if the runner has STOPPED — a response arriving after
// the trunk was deleted has nowhere to go, and a blocking send would leak its goroutine.
//
// A running runner's send is bounded rather than non-blocking: a TriggerAccepted dropped behind
// three timer ticks would leave the gateway reporting `degraded` for a trunk that is up.
func (r *gatewayRunner) post(in Input) {
	r.mu.Lock()
	stopped := r.stopped
	r.mu.Unlock()
	if stopped {
		return
	}
	select {
	case r.inputs <- in:
		return
	default:
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case r.inputs <- in:
	case <-timer.C:
		r.log.Warn("dropping a trunk gateway input: the mailbox stayed full",
			"trunkId", r.config.TrunkID, "trigger", in.Trigger.String())
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

// sameConfig reports whether two configurations would produce the same registration behaviour. It
// compares only the fields the machine READS, so a rename (or any other field the machine ignores,
// MaxChannels included) does not restart a gateway and put a REGISTER on the wire.
func sameConfig(left, right Config) bool {
	return left.Enabled == right.Enabled &&
		left.Register == right.Register &&
		left.Registrar == right.Registrar &&
		left.SecondaryRegistrar == right.SecondaryRegistrar &&
		left.OutboundProxy == right.OutboundProxy &&
		left.AuthUser == right.AuthUser &&
		left.AuthRealm == right.AuthRealm &&
		left.SecretRef == right.SecretRef &&
		left.Contact == right.Contact &&
		left.Transport == right.Transport &&
		left.ExpiresSeconds == right.ExpiresSeconds
}
