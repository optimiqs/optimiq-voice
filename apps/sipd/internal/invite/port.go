package invite

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"sync"
	"time"
)

// ErrNoAnswer marks "the engine did not answer at all", as distinct from "the engine refused". Both
// become a 503 on the wire; only the log tells an engine that is down from a call that was declined.
var ErrNoAnswer = errors.New("invite: the admission request was not answered")

// RefusalReason is the engine's vocabulary for declining a call. The list is closed and the mapping
// onto SIP status lives here: choosing it in the engine would put SIP vocabulary there, and choosing
// it here from free text would put guesswork on the edge.
type RefusalReason string

const (
	// ReasonUnattributed means no credential org and no did-index entry: nobody owns this call.
	ReasonUnattributed RefusalReason = "unattributed"
	// ReasonUnknownTarget means the dialled number resolves to nothing in this tenant's plan.
	ReasonUnknownTarget RefusalReason = "unknown_target"
	// ReasonNotPermitted means authenticated, but not for this context — the toll-fraud boundary.
	ReasonNotPermitted RefusalReason = "not_permitted"
	// ReasonCongestion is a tenant or trunk channel cap.
	ReasonCongestion RefusalReason = "congestion"
	// ReasonShuttingDown is a drain. Its Retry-After is what makes a carrier fail over to another
	// node instead of retrying at this one.
	ReasonShuttingDown RefusalReason = "shutting_down"
	// ReasonBadRequest is a malformed payload.
	ReasonBadRequest RefusalReason = "bad_request"
	// ReasonInternal is anything else.
	ReasonInternal RefusalReason = "internal"
)

// Refusal describes what a refused admission becomes on the wire.
type Refusal struct {
	Status     int
	Reason     string
	RetryAfter time.Duration
}

// refusals maps each reason onto the response a stranger sees.
var refusals = map[RefusalReason]Refusal{
	// Nobody owns the number, so as far as the caller is concerned it does not exist.
	ReasonUnattributed:  {Status: 404, Reason: "Not Found"},
	ReasonUnknownTarget: {Status: 404, Reason: "Not Found"},
	// Authenticated and not allowed here. 403 rather than 404 because the caller is known, and a
	// 404 would tell them to try a different number when the problem is the context.
	ReasonNotPermitted: {Status: 403, Reason: "Forbidden"},
	ReasonCongestion:   {Status: 503, Reason: "Service Unavailable"},
	// The Retry-After is the entire point: a 503 without one makes a carrier retry here.
	ReasonShuttingDown: {Status: 503, Reason: "Service Unavailable", RetryAfter: 30 * time.Second},
	ReasonBadRequest:   {Status: 400, Reason: "Bad Request"},
	ReasonInternal:     {Status: 500, Reason: "Server Internal Error"},
}

// StatusFor maps a refusal reason onto the response a stranger sees. An unrecognised reason becomes
// 500 rather than 503 or 403: contract drift is not a claim about the caller or about retrying.
func StatusFor(reason RefusalReason) Refusal {
	if refusal, found := refusals[reason]; found {
		return refusal
	}
	return Refusal{Status: 500, Reason: "Server Internal Error"}
}

// TimeoutRefusal is what a sipd whose admission request went unanswered answers on its own
// authority. A refusal is always a reply and never a silence: staying quiet leaves the caller
// holding an INVITE transaction until Timer B.
func TimeoutRefusal() Refusal {
	return Refusal{Status: 503, Reason: "Service Unavailable", RetryAfter: 5 * time.Second}
}

// Admission is the engine's answer to a CallIntent, on a queue-grouped flat subject with a 1000 ms
// deadline. The engine attributes the tenant — from the credential org when one is present, from the
// did-index otherwise — and answers with the ids and context it resolved. It does not answer "did
// the call connect": that arrives later as an event.
type Admission struct {
	// OK is whether the call is admitted at all.
	OK bool
	// LegID echoes the intent's, so a reply cannot be applied to the wrong leg.
	LegID string
	// OrgID is the tenant the engine resolved. For a trunk call this is the first time this edge
	// learns it, and it is what makes every `sip.evt.v1` subject carry a real tenant.
	OrgID string
	// CallID is the engine's call id.
	CallID string
	// InstanceID is the engine's instance, for the paths that need to address it back.
	InstanceID string
	// RoutingContext is what the engine actually resolved in, which may be narrower than what was
	// asked for and must never be wider.
	RoutingContext string
	// Direction is "inbound" or "outbound" as the engine filed it.
	Direction string
	// Reason and Detail describe a refusal.
	Reason RefusalReason
	Detail string
}

// Port is the engine seam: one method, synchronous, bounded. Everything after admission is
// asynchronous, and this one synchronous step decides admission only, never the outcome.
type Port interface {
	Admit(ctx context.Context, intent CallIntent) (Admission, error)
}

// RefusingPort is the Port a deployment gets when no engine responder exists. Not a stub: every
// INVITE is answered 503 with a Retry-After rather than a fake admission that would make a broken
// deployment look like a working one.
type RefusingPort struct {
	// Reason is what to report. Defaults to `internal`, which becomes a 500; a deployment that is
	// deliberately without an engine should set `shutting_down` so carriers fail over.
	Reason RefusalReason
}

var _ Port = RefusingPort{}

// Admit implements Port.
func (p RefusingPort) Admit(_ context.Context, intent CallIntent) (Admission, error) {
	reason := p.Reason
	if reason == "" {
		reason = ReasonInternal
	}
	return Admission{
		LegID:  intent.LegID,
		Reason: reason,
		Detail: "no engine is serving rpc.sip.v1.invite in this deployment",
	}, nil
}

// FakePort is the test double: it answers from a script and records what it was asked. Exported so
// integration tests share one fake rather than keeping a second that can disagree with it.
type FakePort struct {
	mu sync.Mutex
	// Answer is consulted for every request. A nil Answer admits everything with generated ids,
	// which is the shape most tests want.
	Answer func(intent CallIntent) (Admission, error)

	requests []CallIntent
}

var _ Port = (*FakePort)(nil)

// Admit implements Port.
func (f *FakePort) Admit(_ context.Context, intent CallIntent) (Admission, error) {
	f.mu.Lock()
	f.requests = append(f.requests, intent)
	answer := f.Answer
	f.mu.Unlock()

	if answer == nil {
		return Admission{
			OK:             true,
			LegID:          intent.LegID,
			OrgID:          cmp.Or(intent.OrgID, "018f0000-0000-7000-8000-000000000000"),
			CallID:         "018f0000-0000-7000-8000-00000000ca11",
			InstanceID:     "engine-test",
			RoutingContext: string(intent.RoutingContext),
			Direction:      "inbound",
		}, nil
	}
	return answer(intent)
}

// Requests returns a copy of everything the port was asked.
func (f *FakePort) Requests() []CallIntent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.requests)
}

// Last returns the most recent request, and whether there was one.
func (f *FakePort) Last() (CallIntent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		return CallIntent{}, false
	}
	return f.requests[len(f.requests)-1], true
}
