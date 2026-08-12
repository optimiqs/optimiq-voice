package invite

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrNoAnswer marks "the engine did not answer at all", as distinct from "the engine refused".
//
// The distinction matters to the log and barely to the phone: both become a 503 on the wire,
// because a caller has one behaviour for a call that did not happen. It matters a great deal to an
// operator, where a timeout is an engine that is down and a refusal is a call that was considered
// and declined — the same distinction `transfer/client.go` already draws for REFER.
var ErrNoAnswer = errors.New("invite: the admission request was not answered")

// RefusalReason is the engine's vocabulary for declining a call.
//
// # Why this list is small, and why the mapping lives here
//
// Every entry must become a SIP status a STRANGER sees. Choosing that mapping in the engine would
// put SIP vocabulary in the engine; choosing it here from a free-text string would put guesswork on
// the edge. So the list is closed, the table is in this file, and every entry is justified by what
// the caller should do next (design §10.4).
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

// refusals is the table. Every row's justification is in the design document's §10.4 and is
// reproduced in one line here, because the next person to add a row needs the rule and not the
// precedent.
var refusals = map[RefusalReason]Refusal{
	// Today's INVALID_PROFILE hangup, on the wire: nobody owns the number, so it does not exist.
	ReasonUnattributed:  {Status: 404, Reason: "Not Found"},
	ReasonUnknownTarget: {Status: 404, Reason: "Not Found"},
	// Authenticated and not allowed here. 403 rather than 404 because the caller IS known, and a
	// 404 would tell them to try a different number when the problem is the context.
	ReasonNotPermitted: {Status: 403, Reason: "Forbidden"},
	ReasonCongestion:   {Status: 503, Reason: "Service Unavailable"},
	// The Retry-After is the entire point: a 503 without one makes a carrier retry here.
	ReasonShuttingDown: {Status: 503, Reason: "Service Unavailable", RetryAfter: 30 * time.Second},
	ReasonBadRequest:   {Status: 400, Reason: "Bad Request"},
	ReasonInternal:     {Status: 500, Reason: "Server Internal Error"},
}

// StatusFor maps a refusal reason onto the response a stranger sees.
//
// An unrecognised reason becomes 500. Not 503 and not 403: a reason this edge does not know is a
// contract drift, and answering "try again later" or "you may not" would both be claims we cannot
// support. 500 is the honest "this is our fault".
func StatusFor(reason RefusalReason) Refusal {
	if refusal, found := refusals[reason]; found {
		return refusal
	}
	return Refusal{Status: 500, Reason: "Server Internal Error"}
}

// TimeoutRefusal is what a sipd whose admission request went unanswered answers on its own
// authority.
//
// A refusal is always a reply and never a silence — the rule stated on MEDIA_REFUSAL_REASONS. Here
// it has teeth beyond good manners: a silent engine leaves this edge holding an INVITE transaction
// until the caller's Timer B, and the caller hears thirty-two seconds of nothing.
func TimeoutRefusal() Refusal {
	return Refusal{Status: 503, Reason: "Service Unavailable", RetryAfter: 5 * time.Second}
}

// Admission is the engine's answer.
//
// # The contract the engine must serve, stated once
//
// Request: CallIntent, marshalled as the `rpc.sip.v1.invite` payload of design §10.3. Reply: this,
// on a queue-grouped flat subject with a 1000 ms deadline. The engine ATTRIBUTES the tenant — from
// the credential org when one is present, from the did-index otherwise — and answers with the org
// it resolved, the call id it minted, its own instance id, the routing context it will resolve in
// and the direction it filed the call under. It does not answer "did the call connect": a routing
// walk rings for thirty seconds and a request-reply with a sixty-second deadline is a subscription
// wearing one's clothes (design §4.2).
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
	// InstanceID is the ENGINE's instance, for the paths that need to address it back.
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

// Port is the engine seam.
//
// One method, synchronous, bounded. Everything AFTER admission is asynchronous — commands arrive on
// per-instance subjects and events leave on JetStream — and that asymmetry is the design's central
// decision (§4.2): exactly one step is synchronous and it decides admission only, not the outcome.
type Port interface {
	Admit(ctx context.Context, intent CallIntent) (Admission, error)
}

// RefusingPort is the Port a deployment gets when no engine responder exists.
//
// It is not a stub and not a mock: it is the honest production behaviour for the state this
// repository is in. Every INVITE is answered 503 with a Retry-After, the log says why, and nothing
// pretends a call could have been placed. The alternative — wiring a fake that admits — would make
// a broken deployment look like a working one until the first person picked up a handset.
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

// FakePort is the test double. It answers from a script and records what it was asked.
//
// It is exported because the handler's tests are not the only ones that need it: a future
// integration test that runs the SIP path with no broker wants the same thing, and two copies of a
// fake are two chances to disagree about the contract.
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
			OrgID:          orDefault(intent.OrgID, "018f0000-0000-7000-8000-000000000000"),
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
	return append([]CallIntent(nil), f.requests...)
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

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
