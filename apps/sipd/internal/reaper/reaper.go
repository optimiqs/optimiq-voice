// Package reaper keeps the `sip-dialogs` claims honest in both directions, from one ticker:
//
//  1. HEARTBEAT. Every live dialog on this instance gets its claim re-written with a fresh
//     expiresAt, so a busy instance's calls do not look dead to its neighbours.
//  2. REAP. Every claim belonging to some OTHER instance that is gone — its claim lease lapsed, or
//     its `sip-instances` lease did, which happens in seconds rather than in ninety of them —
//     produces a `dialog.terminated{reason: "instance-lost", cause: 41}` published on the dead
//     owner's behalf, and the claim is deleted.
//
// One package owns both because they are the same sweep seen from two sides; splitting them across
// two intervals could let a deployment reap faster than it heartbeats, and a process that reaps its
// own calls is the worst failure available here. dialog.Orphans encodes the rule that prevents it.
//
// Step 2 is why the bucket exists: a sipd that dies takes its dialogs with it (design §6.4), and
// without this sweep the engine holds channels for calls that ended when a pod was rescheduled and
// writes no CDR row for any of them — not a wrong bill, an absent one.
//
// The cause is Q.850 41, "temporary failure": the machine holding the call went away. 16 (normal
// clearing) would file a crash as a hang-up and make an availability incident invisible in the CDR;
// 31 (normal, unspecified) says nothing.
package reaper

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"strings"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
)

// CauseInstanceLost is Q.850 41, "temporary failure". See the package comment for why not 16. Taken
// from internal/dialog so this file cannot drift from the taxonomy the platform bills against.
const CauseInstanceLost = dialog.CauseTemporaryFailure

// Claims is the subset of dialog.ClaimStore this package needs. It is restated rather than reused
// so a test can supply a store that fails on exactly one method, which is the only way to prove
// that a reap whose delete fails still published its termination.
type Claims interface {
	Put(ctx context.Context, claim dialog.Claim) error
	Delete(ctx context.Context, legID string) error
	All(ctx context.Context) ([]dialog.Claim, error)
}

// Live reports the claims this instance currently holds, one per live dialog. *dialog.Store
// satisfies it; a test supplies a slice.
type Live interface {
	Claims() []dialog.Claim
}

// Leases is the read half of the `sip-instances` bucket: which sipd processes renewed recently.
// Optional, and deliberately so — without it the sweep still reaps on the claim's own lease, which
// is the behaviour that shipped before the bucket existed.
type Leases interface {
	Live(ctx context.Context, now time.Time) (map[string]struct{}, error)
}

// Options configures a Reaper. Every dependency is an interface, so the unit suite runs with no
// broker and no clock.
type Options struct {
	// Store is the bucket. Required.
	Store Claims
	// Dialogs is this instance's live dialog table, for the heartbeat half. Required.
	Dialogs Live
	// Events publishes the terminations reaped on a dead owner's behalf. Required: deleting claims
	// without publishing would destroy the evidence this reaper exists to deliver.
	Events sipevents.Publisher
	// Leases, when set, lets a sweep reap a dead owner's dialogs off its INSTANCE lease — seconds —
	// instead of waiting out each claim's own ninety-second one. Optional.
	Leases Leases
	// InstanceID is this process's token. Required: it is what dialog.Orphans compares against to
	// decide which claims are somebody else's.
	InstanceID string
	// Interval is how often the sweep runs. It must be half the claim lease or less, so a heartbeat
	// has more than one chance to land before a neighbour declares this instance dead.
	Interval time.Duration
	// ReapInterval is how often the REAP half runs, which is deliberately not every sweep. Zero
	// means twice the heartbeat interval. See Reaper.Sweep.
	ReapInterval time.Duration
	// Timeout bounds one sweep's I/O.
	Timeout time.Duration
	Logger  *slog.Logger
	// Now is injectable so lease expiry is testable without sleeping.
	Now func() time.Time
}

// Reaper runs the sweep.
type Reaper struct {
	store    Claims
	dialogs  Live
	events   sipevents.Publisher
	leases   Leases
	instance string
	interval time.Duration
	// reapInterval and nextReap gate the bucket listing. See Sweep.
	reapInterval time.Duration
	nextReap     time.Time
	timeout      time.Duration
	log          *slog.Logger
	now          func() time.Time
}

// New validates the options and builds a Reaper.
func New(opts Options) (*Reaper, error) {
	switch {
	case opts.Store == nil:
		return nil, errors.New("reaper: a claim store is required")
	case opts.Dialogs == nil:
		return nil, errors.New("reaper: a dialog table is required")
	case opts.Events == nil:
		return nil, errors.New("reaper: an event publisher is required: a reaper that deletes " +
			"claims without publishing their terminations destroys the evidence it exists to deliver")
	case strings.TrimSpace(opts.InstanceID) == "":
		return nil, errors.New("reaper: an instance id is required: without one every claim in the " +
			"bucket looks like somebody else's and this process would reap its own calls")
	}
	reaper := &Reaper{
		store:        opts.Store,
		dialogs:      opts.Dialogs,
		events:       opts.Events,
		leases:       opts.Leases,
		instance:     opts.InstanceID,
		interval:     opts.Interval,
		reapInterval: opts.ReapInterval,
		timeout:      opts.Timeout,
		log:          opts.Logger,
		now:          opts.Now,
	}
	if reaper.interval <= 0 {
		// Thirty seconds against the store's ninety-second default lease: three chances to land a
		// heartbeat before a neighbour concludes this instance is gone.
		reaper.interval = 30 * time.Second
	}
	if reaper.timeout <= 0 {
		reaper.timeout = 10 * time.Second
	}
	if reaper.log == nil {
		reaper.log = slog.Default()
	}
	if reaper.now == nil {
		reaper.now = time.Now
	}
	if reaper.reapInterval <= 0 {
		reaper.reapInterval = 2 * reaper.interval
	}
	return reaper, nil
}

// Run sweeps until the context is cancelled. The first sweep is immediate: a restarted pod's
// neighbours may hold claims that lapsed while it was down, and waiting one interval would add that
// delay to every CDR written after a rolling deploy.
func (r *Reaper) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	r.Sweep(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			r.Sweep(ctx)
		}
	}
}

// Sweep runs one heartbeat-and-reap pass, exported so a test can drive it without a ticker and a
// shutdown path can run one final pass.
//
// The reap half does not run every sweep. The heartbeat is O(this instance's dialogs); the reap is
// O(the whole fleet's dialogs) and every instance pays it, so it grows quadratically with cluster
// size. It therefore runs on its own longer interval with a random phase. The cost is latency on a
// CDR of last resort, which is safe because the claim's own lease decides whether it is an orphan,
// not when we look.
func (r *Reaper) Sweep(ctx context.Context) {
	sweepCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	r.heartbeat(sweepCtx)
	now := r.now()
	if now.Before(r.nextReap) {
		return
	}
	// Jittered so instances that started together do not list the bucket in the same millisecond
	// for ever after.
	jitter := time.Duration(rand.Int64N(int64(r.reapInterval) / 4))
	r.nextReap = now.Add(r.reapInterval - r.reapInterval/8 + jitter)
	r.reap(sweepCtx)
}

// heartbeat re-writes every live dialog's claim, unconditionally rather than only those close to
// expiry: tracking per-claim deadlines here would be a second copy of the lease that could disagree
// with the bucket's.
//
// A failure is logged and the sweep continues; abandoning the pass would leave every subsequent
// dialog's claim stale as well.
func (r *Reaper) heartbeat(ctx context.Context) {
	claims := r.dialogs.Claims()
	written, failed := 0, 0
	for _, claim := range claims {
		if err := r.store.Put(ctx, claim); err != nil {
			failed++
			r.log.Warn("cannot refresh a dialog claim", "legId", claim.LegID, "error", err)
			continue
		}
		written++
	}
	if failed > 0 {
		r.log.Warn("some dialog claims could not be refreshed",
			"refreshed", written, "failed", failed, "instanceId", r.instance)
		return
	}
	if written > 0 {
		r.log.Debug("refreshed dialog claims", "count", written, "instanceId", r.instance)
	}
}

// reap publishes a termination for every orphaned claim and then deletes it. The order is not
// interchangeable: deleting first would open a window in which a crash leaves the leg unreapable by
// anybody, for ever. Publishing first risks only a republish on the next sweep, which the stream's
// duplicate window collapses via the envelope's stable `Nats-Msg-Id`.
func (r *Reaper) reap(ctx context.Context) {
	claims, err := r.store.All(ctx)
	if err != nil {
		r.log.Warn("cannot list dialog claims; nothing was reaped this sweep", "error", err)
		return
	}
	orphans := dialog.Reapable(claims, r.instance, r.now(), r.liveInstances(ctx))
	if len(orphans) == 0 {
		return
	}

	r.log.Warn("reaping dialogs from instances that stopped heartbeating",
		"count", len(orphans), "instanceId", r.instance)

	for _, orphan := range orphans {
		if err := r.publishTermination(ctx, orphan); err != nil {
			// NOT deleted: the claim stays so the next sweep tries again, with the bucket's TTL as the
			// backstop. Deleting it would discard the only evidence that call ever ended.
			r.log.Error("cannot publish an orphaned dialog's termination; leaving the claim for the next sweep",
				"legId", orphan.LegID, "ownerInstanceId", orphan.InstanceID, "error", err)
			continue
		}
		if err := r.store.Delete(ctx, orphan.LegID); err != nil {
			r.log.Warn("reaped a dialog but could not delete its claim; the next sweep will republish",
				"legId", orphan.LegID, "error", err)
			continue
		}
		r.log.Info("reaped a dialog whose instance is gone",
			"legId", orphan.LegID,
			"orgId", orphan.OrgID,
			"callId", orphan.CallID,
			"ownerInstanceId", orphan.InstanceID,
			"state", orphan.State,
			"sipCallId", orphan.SIPCallID)
	}
}

// SweepPredecessor reaps the claims this instance id left behind in a PREVIOUS incarnation.
//
// The rule that keeps the ordinary sweep safe — never reap a claim carrying our own instance id,
// because our own expired claim is a late heartbeat and not a dead call — has a hole at boot when
// the instance id is stable across restarts, which it is under every orchestrator that names a pod
// deterministically and in every deployment that sets SIPD_INSTANCE_ID. A killed sipd's claims then
// look like the replacement's own for ever: nothing reaps them, no `dialog.terminated` is published
// for the calls that died, and the bucket accumulates one dead dialog per crashed call until the
// six-hour TTL. Observed live: 25 claims against zero live channels.
//
// It is safe precisely because it runs at BOOT: this process holds no dialogs yet, so every claim
// bearing its id belongs to an incarnation that is gone. The guard makes that explicit rather than
// trusting the call site, and a caller that runs it late reaps nothing instead of reaping live calls.
func (r *Reaper) SweepPredecessor(ctx context.Context) {
	if len(r.dialogs.Claims()) > 0 {
		r.log.Warn("refusing to sweep this instance id's older claims: it is already serving dialogs",
			"instanceId", r.instance)
		return
	}
	sweepCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	claims, err := r.store.All(sweepCtx)
	if err != nil {
		r.log.Warn("cannot list dialog claims at boot; a previous incarnation's calls are unreaped",
			"error", err)
		return
	}
	stale := make([]dialog.Claim, 0)
	for _, claim := range claims {
		if claim.InstanceID == r.instance {
			stale = append(stale, claim)
		}
	}
	if len(stale) == 0 {
		return
	}

	r.log.Warn("reaping the dialogs a previous incarnation of this instance id left behind",
		"count", len(stale), "instanceId", r.instance)
	for _, claim := range stale {
		if err := r.publishTermination(sweepCtx, claim); err != nil {
			r.log.Error("cannot publish a predecessor dialog's termination; leaving the claim",
				"legId", claim.LegID, "error", err)
			continue
		}
		if err := r.store.Delete(sweepCtx, claim.LegID); err != nil {
			r.log.Warn("reaped a predecessor dialog but could not delete its claim",
				"legId", claim.LegID, "error", err)
		}
	}
}

// liveInstances reads the instance leases, or returns nil when there is no lease evidence to be
// had. Nil is the safe answer in every failure: dialog.Reapable ignores an empty set, so a bucket
// that could not be listed falls back to judging each claim on its own lease rather than concluding
// that the whole fleet is dead.
func (r *Reaper) liveInstances(ctx context.Context) map[string]struct{} {
	if r.leases == nil {
		return nil
	}
	live, err := r.leases.Live(ctx, r.now())
	if err != nil {
		r.log.Warn("cannot read the instance liveness leases; reaping on claim leases alone",
			"error", err)
		return nil
	}
	return live
}

// publishTermination builds and publishes one orphan's `dialog.terminated`.
//
// It reports the DEAD OWNER's instance id, not this one, or the engine would address a follow-up
// command at a process that never held the call. `answeredForSeconds` is deliberately absent even
// for a confirmed claim: the claim records creation and lease expiry, neither of which is when the
// call was answered, and an absent field is the truth rather than an invented billsec.
func (r *Reaper) publishTermination(ctx context.Context, orphan dialog.Claim) error {
	role := contract.SIPDialogTerminatedRole(orphan.Role)
	if !role.Valid() {
		// A claim whose role is unreadable still names a leg that ended; refusing to publish would
		// withhold a CDR over a cosmetic field. `uas` is the conservative reading.
		role = contract.SIPDialogTerminatedRoleUas
	}
	envelope, err := contract.NewSIPDialogTerminatedEnvelope(
		contract.EnvelopeInput[contract.SIPDialogTerminatedData]{
			OrgID:  orphan.OrgID,
			Source: "sipd",
			At:     r.now(),
			Data: contract.SIPDialogTerminatedData{
				LegID:      orphan.LegID,
				CallID:     orphan.CallID,
				InstanceID: orphan.InstanceID,
				Role:       role,
				Identity: contract.SIPDialogTerminatedIdentity{
					SIPCallID: orphan.SIPCallID,
					LocalTag:  optional(orphan.LocalTag),
					RemoteTag: optional(orphan.RemoteTag),
				},
				Reason: contract.SIPDialogTerminatedReasonInstanceLost,
				Cause:  CauseInstanceLost,
				// The cause was chosen here from evidence about the PROCESS, not read off a SIP
				// Reason header — there was no BYE and there was no response. Saying so is what stops
				// a consumer treating it as the far end's own account of the call.
				CauseFromReasonHeader: false,
				// `timer` and not `local`: nobody decided this call should end. A lease expired.
				Initiator: contract.SIPDialogTerminatedInitiatorTimer,
			},
		})
	if err != nil {
		return err
	}
	return r.events.Terminated(ctx, envelope)
}

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return new(value)
}
