// Package reaper keeps the `sip-dialogs` claims honest, in both directions.
//
// # The two halves, and why one package owns both
//
// A claim is a lease. It is only useful if somebody REFRESHES the ones that are still true and
// somebody ACTS on the ones that have stopped being refreshed — and those are the same sweep seen
// from two sides. Splitting them across two goroutines with two intervals would let a deployment
// end up heartbeating faster than it reaps or the reverse, and the failure mode of the second is a
// process that reaps its OWN calls.
//
// So: one ticker, two steps.
//
//  1. HEARTBEAT. Every live dialog on this instance gets its claim re-written with a fresh
//     expiresAt. This is what keeps a busy instance's calls from looking dead to its neighbours.
//  2. REAP. Every claim belonging to some OTHER instance whose lease has lapsed produces a
//     `dialog.terminated{reason: "instance-lost", cause: 41}` published on the dead owner's behalf,
//     and the claim is deleted.
//
// # Why step 2 is the point of the whole bucket
//
// A sipd that dies takes its dialogs with it — there is no re-INVITE that can be sent from a process
// that does not hold the CSeq, and the far end's BYE is addressed to a Contact that is gone (design
// §6.4). What must not die with it is the ENGINE's knowledge that those calls ended. Without this
// sweep the engine holds channels for calls that ended when a pod was rescheduled and writes no CDR
// row for any of them: not a wrong bill, an ABSENT one. That is design §6.2's whole point, and
// `dialog.Orphans` already encodes the one rule that makes it safe — it never reaps this instance's
// own expired claims, because our own late heartbeat is a broker blip and reaping it would turn a
// network hiccup into dropped calls.
//
// # Q.850 41, and not 16 or 31
//
// "Temporary failure". The call did not end normally, nobody rejected it and no timer inside the
// call expired — the machine holding it went away. 16 (normal clearing) would file a crash as a
// hang-up and make an availability incident invisible in the CDR; 31 (normal, unspecified) is the
// shrug that means nothing. 41 is the one code that says "infrastructure", which is what a customer
// asking why forty calls dropped at 03:14 is entitled to see.
package reaper

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
)

// CauseInstanceLost is Q.850 41, "temporary failure". See the package comment for why not 16.
//
// Taken from internal/dialog rather than written as a literal, so this file cannot drift from the
// generated taxonomy the rest of the platform bills against.
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

// Options configures a Reaper. Every dependency is an interface, so the unit suite runs with no
// broker and no clock.
type Options struct {
	// Store is the bucket. Required.
	Store Claims
	// Dialogs is this instance's live dialog table, for the heartbeat half. Required.
	Dialogs Live
	// Events publishes the terminations reaped on a dead owner's behalf. Required: a reaper that
	// deleted claims without publishing would be a reaper that DESTROYS the evidence it exists to
	// deliver, which is strictly worse than not running at all.
	Events sipevents.Publisher
	// InstanceID is this process's token. Required, and load-bearing rather than cosmetic: it is
	// what dialog.Orphans compares against to decide which claims are somebody else's.
	InstanceID string
	// Interval is how often the sweep runs. It must be comfortably shorter than the claim lease —
	// half of it or less — so a heartbeat has more than one chance to land through a broker blip
	// before a neighbour declares this instance dead and reaps its live calls.
	Interval time.Duration
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
	instance string
	interval time.Duration
	timeout  time.Duration
	log      *slog.Logger
	now      func() time.Time
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
		store:    opts.Store,
		dialogs:  opts.Dialogs,
		events:   opts.Events,
		instance: opts.InstanceID,
		interval: opts.Interval,
		timeout:  opts.Timeout,
		log:      opts.Logger,
		now:      opts.Now,
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
	return reaper, nil
}

// Run sweeps until the context is cancelled.
//
// The first sweep is IMMEDIATE rather than one interval in. A restarted pod's neighbours may be
// holding claims that lapsed while it was down, and making the fleet wait thirty seconds to notice
// would add that delay to every CDR written after a rolling deploy — which is precisely the window
// this whole mechanism exists to close.
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

// Sweep runs one heartbeat-and-reap pass. It is exported so a test can drive it without a ticker,
// and so a shutdown path can run one final pass.
func (r *Reaper) Sweep(ctx context.Context) {
	sweepCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	r.heartbeat(sweepCtx)
	r.reap(sweepCtx)
}

// heartbeat re-writes every live dialog's claim.
//
// One write per dialog per interval, unconditionally, and not "only the ones close to expiry". The
// arithmetic is what makes that fine: at a thirty-second interval an instance holding a thousand
// calls writes thirty-three keys a second, which is nothing to a KV bucket; and the alternative —
// tracking per-claim deadlines here — would be a second copy of the lease that could disagree with
// the one in the bucket.
//
// A failure is logged and the sweep continues. A claim that could not be refreshed costs REAPING
// for that one leg, not the call, and abandoning the pass would leave every subsequent dialog's
// claim stale as well.
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

// reap publishes a termination for every orphaned claim and then deletes it.
//
// # The order is publish-then-delete, and it is not interchangeable
//
// Deleting first would open a window in which the claim is gone and the engine has not been told
// the leg ended — and if this process died in that window the call would be unreapable by anybody,
// for ever. Publishing first risks the opposite: a publish that succeeds and a delete that fails,
// so the next sweep publishes the same termination again. That duplicate is HARMLESS, because the
// envelope carries a stable id as `Nats-Msg-Id` and the stream's duplicate window collapses it. One
// failure mode is bounded and idempotent; the other is a call that is never billed.
func (r *Reaper) reap(ctx context.Context) {
	claims, err := r.store.All(ctx)
	if err != nil {
		r.log.Warn("cannot list dialog claims; nothing was reaped this sweep", "error", err)
		return
	}
	orphans := dialog.Orphans(claims, r.instance, r.now())
	if len(orphans) == 0 {
		return
	}

	r.log.Warn("reaping dialogs from instances that stopped heartbeating",
		"count", len(orphans), "instanceId", r.instance)

	for _, orphan := range orphans {
		if err := r.publishTermination(ctx, orphan); err != nil {
			// NOT deleted. The claim stays so the next sweep tries again; the bucket's own TTL is the
			// backstop if it never succeeds. Deleting a claim whose termination was never published
			// would silently discard the only evidence that call ever ended.
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

// publishTermination builds and publishes one orphan's `dialog.terminated`.
//
// # What it can and cannot say
//
// It reports the DEAD OWNER's instance id, not this one. The event describes a leg that lived on
// that process, and stamping the reaper's id would make the engine address a follow-up command at a
// process that never held the call.
//
// `answeredForSeconds` is deliberately absent even for a claim in state `confirmed`. The claim
// records when the dialog was CREATED and when its lease expires, and neither of those is when the
// call was answered; deriving a billsec from them would be inventing a number that looks
// authoritative. An absent field says "this leg's duration is not known", which is the truth, and
// the engine has the `dialog.answered` it received earlier to reconcile against.
func (r *Reaper) publishTermination(ctx context.Context, orphan dialog.Claim) error {
	role := contract.SIPDialogTerminatedRole(orphan.Role)
	if !role.Valid() {
		// A claim whose role is unreadable still names a leg that ended, and refusing to publish it
		// would withhold a CDR over a cosmetic field. `uas` is the conservative reading: it is what
		// an inbound call is, and inbound is what the overwhelming majority of legs on this edge are.
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
	copied := value
	return &copied
}
