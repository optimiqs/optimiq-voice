package invite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// NATSPort is the production Port: one core NATS request against `rpc.sip.v1.invite`.
//
// # Raw, and never a Nest client
//
// The responder is a NestJS service, which is exactly the case where reaching for Nest's own framing
// is tempting and wrong in the other direction. `rpc.sip.v1.invite` is served RAW — the same
// inversion `rpc.sip.v1.transfer` already has, and the same obligation `transfer/client.go` already
// carries: a payload wrapped as `{"pattern":…,"data":…}` is not answered at all, and on THIS subject
// "not answered" means every INVITE times out into a 503.
//
// # Core NATS, never JetStream
//
// Admission is a synchronous question whose answer is worthless a second later: a person is holding
// a handset, `100 Trying` is already on the wire, and the whole budget is one second. Persisting it
// would be storage for a message nobody will replay, and a stream's redelivery would admit a call
// minutes after the caller hung up — which, unlike a redelivered transfer, would ring a phone.
//
// # Queue-grouped and FLAT, unlike everything the engine sends back
//
// The five commands in the other direction carry an instance token because a dialog lives on one
// process (design §10.2). This one does not: ANY engine may admit a call, the reply names the one
// that did, and the edge addresses nothing back at it — the engine's own instance id travels on the
// reply purely so a refusal can be attributed in the log.
//
// # No caching, positive or negative
//
// Every request is unique and every answer is about one moment in one call's life. There is nothing
// to reuse — the same reason `transfer/client.go` gives, and the opposite of the credential store
// next door, whose answers are about an account rather than about a call.
type NATSPort struct {
	conn    *nats.Conn
	subject string
	timeout time.Duration
}

var _ Port = (*NATSPort)(nil)

// NATSOptions configures a NATSPort. Every field has a working default.
type NATSOptions struct {
	// Subject overrides the contract subject. Only tests should set it.
	Subject string
	// Timeout is the per-request deadline. Defaults to the contract's own TimeoutSipInviteRPC —
	// 1000 ms, argued at length on SIP_INVITE_RPC: not the 500 ms of `credential`, because nothing
	// retransmits behind a `100 Trying`, and not the 2000 ms of `transfer`, because that one is
	// bounded by somebody WATCHING a handset and this one by somebody HOLDING one.
	Timeout time.Duration
}

// NewNATSPort builds the port. A nil connection is refused here rather than on the first INVITE,
// because it is a wiring mistake and not a runtime state — and a wiring mistake discovered on the
// first call from a carrier is one discovered by a customer.
func NewNATSPort(conn *nats.Conn, opts NATSOptions) (*NATSPort, error) {
	if conn == nil {
		return nil, errors.New("invite: a NATS connection is required for the admission RPC")
	}
	port := &NATSPort{conn: conn, subject: opts.Subject, timeout: opts.Timeout}
	if port.subject == "" {
		port.subject = contract.SubjectSipInviteRPC
	}
	if port.timeout <= 0 {
		port.timeout = contract.TimeoutSipInviteRPC
	}
	return port, nil
}

// Subject reports the subject this port requests on. Diagnostics and the boot log.
func (p *NATSPort) Subject() string { return p.subject }

// Timeout reports the per-request deadline, for the boot log.
func (p *NATSPort) Timeout() time.Duration { return p.timeout }

// Admit implements Port.
//
// # The two failure shapes, kept apart
//
// A transport failure — no responder, a broker outage, a deadline — returns ErrNoAnswer wrapped, and
// the handler answers `503` with a Retry-After on its own authority. A well-formed reply with
// `ok:false` returns a REFUSAL, with no error, and the handler maps the reason to the status a
// stranger sees. Both become a failure the caller hears; only one of them is the engine's opinion,
// and an operator staring at a log needs to know which. That is the distinction
// `transfer/client.go:14-19` draws for REFER, restated here because it costs one branch and it is
// the difference between "the engine is down" and "the engine said no".
func (p *NATSPort) Admit(ctx context.Context, intent CallIntent) (Admission, error) {
	request := admissionRequest(intent)
	payload, err := json.Marshal(request)
	if err != nil {
		return Admission{}, fmt.Errorf("%w: encoding the request: %w", ErrNoAnswer, err)
	}

	// The deadline is the smaller of the contract's and whatever the caller's context has left, so a
	// shutting-down process does not start a fresh one-second wait it cannot honour.
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	message, err := p.conn.RequestWithContext(ctx, p.subject, payload)
	if err != nil {
		return Admission{}, fmt.Errorf("%w: %s: %w", ErrNoAnswer, p.subject, err)
	}

	var reply contract.SipInviteResponse
	if err := json.Unmarshal(message.Data, &reply); err != nil {
		return Admission{}, fmt.Errorf("%w: malformed reply on %s: %w", ErrNoAnswer, p.subject, err)
	}
	return admissionFrom(reply, intent.LegID)
}

// admissionRequest maps a CallIntent onto the contract's request.
//
// It is a function and not a method so it is testable without a broker, which is the only way to
// prove the mapping before an engine exists to try it against — the same reason
// `trunk/status.go`'s statusEnvelope is separate from its publisher.
func admissionRequest(intent CallIntent) contract.SipInviteRequest {
	request := contract.SipInviteRequest{
		LegID:          intent.LegID,
		SipdInstanceID: intent.InstanceID,
		Authentication: contract.SipInviteRequestAuthentication(intent.Authentication),
		RoutingContext: string(intent.RoutingContext),
		From: contract.SipInviteRequestFrom{
			Number: intent.From.Number,
			Name:   optional(intent.From.Name),
			AOR:    optional(intent.From.AOR),
			URI:    optional(intent.From.URI),
		},
		To: contract.SipInviteRequestTo{
			Number: intent.To.Number,
			Name:   optional(intent.To.Name),
			AOR:    optional(intent.To.AOR),
			URI:    optional(intent.To.URI),
		},
		SIPCallID:     intent.SIPCallID,
		FromTag:       optional(intent.FromTag),
		SourceAddress: optional(intent.SourceAddress),
		HasOffer:      intent.HasOffer,
		UserAgent:     optional(intent.UserAgent),
	}
	// orgId is present ONLY when a digest resolved a credential. Sending an empty string instead of
	// omitting it would fail the responder's `z.uuid()` and turn every trunk call into a
	// `bad_request` — the field is optional precisely because a trunk has no tenant yet (design
	// §4.2), and the engine's did-index lookup is the thing that resolves it.
	request.OrgID = optional(intent.OrgID)
	request.Profile = optional(intent.Profile)
	request.TrunkID = optional(intent.TrunkID)
	if intent.Transport != "" {
		transport := contract.SIPTransport(intent.Transport)
		request.Transport = &transport
	}
	if intent.HasOffer && intent.SDPOffer != "" {
		// The one field on this contract whose placement was argued both ways (design §10.3, §11.7).
		// It travels HERE because the engine is the courier for SDP and will hand these bytes to
		// `rpc.media.v1.allocate-session` within milliseconds; the alternative is a second broker
		// round trip back to this edge for them, in the middle of an INVITE, for no gain.
		offer := intent.SDPOffer
		request.SDPOffer = &offer
	}
	if hint := intent.MediaHint; hint.Mismatch || hint.Private || hint.AdvertisedMedia != "" {
		request.MediaHint = &contract.SipInviteRequestMediaHint{
			SignallingSource: optional(hint.SignallingSource),
			AdvertisedMedia:  optional(hint.AdvertisedMedia),
			Mismatch:         hint.Mismatch,
			Private:          hint.Private,
		}
	}
	if intent.Replaces != nil {
		request.Replaces = &contract.SipInviteRequestReplaces{
			CallID:    intent.Replaces.CallID,
			ToTag:     intent.Replaces.ToTag,
			FromTag:   intent.Replaces.FromTag,
			EarlyOnly: intent.Replaces.EarlyOnly,
		}
	}
	request.ReplacesLegID = optional(intent.ReplacesLegID)
	return request
}

// admissionFrom maps the contract's reply onto an Admission, refusing the replies that cannot be
// acted on.
//
// Two checks, and neither is defensive programming:
//
//   - A reply for a DIFFERENT leg is a responder bug, and acting on it would admit one call with
//     another call's tenant — which is a billing attribution error before it is a routing one. The
//     contract says `legId` is echoed "so a reply cannot be applied to the wrong leg"; this is the
//     half of that sentence the edge is responsible for.
//   - A refusal reason this edge does not know is contract drift. StatusFor already answers 500 for
//     an unrecognised reason rather than guessing 503 or 403, and rejecting it here as well would
//     turn a drift into a timeout — so it is passed through, and the LOG carries the unknown token.
func admissionFrom(reply contract.SipInviteResponse, legID string) (Admission, error) {
	if reply.LegID != "" && reply.LegID != legID {
		return Admission{}, fmt.Errorf("%w: asked about leg %q, answered about %q",
			ErrNoAnswer, legID, reply.LegID)
	}

	admission := Admission{
		OK:         reply.Ok,
		LegID:      legID,
		OrgID:      deref(reply.OrgID),
		CallID:     deref(reply.CallID),
		InstanceID: deref(reply.InstanceID),
		Direction:  string(derefDirection(reply.Direction)),
	}
	if reply.RoutingContext != nil {
		admission.RoutingContext = *reply.RoutingContext
	}
	if reply.Reason != nil {
		admission.Reason = RefusalReason(*reply.Reason)
	}
	admission.Detail = deref(reply.Error)

	if !admission.OK {
		if admission.Reason == "" {
			// A refusal with no reason is unusable: StatusFor would answer 500 for an empty string,
			// which is the right STATUS and the wrong log line. Naming it `internal` here makes the
			// log say what happened rather than leaving a blank field somebody has to interpret.
			admission.Reason = ReasonInternal
			if admission.Detail == "" {
				admission.Detail = "the engine refused without naming a reason"
			}
		}
		return admission, nil
	}
	// An `ok` reply with no tenant is not admissible, and failing it here is the whole reason the
	// event family starts after admission (design §4.2): every `sip.evt.v1` subject needs a real org
	// token, and there is no `_unknown` to fall back on. A call admitted without one would be a
	// dialog nothing could ever publish an event for — it would connect, and it would never appear in
	// a CDR.
	if admission.OrgID == "" {
		return Admission{
			LegID:  legID,
			Reason: ReasonInternal,
			Detail: "the engine admitted the call without resolving a tenant",
		}, nil
	}
	return admission, nil
}

// optional renders an empty string as an omitted field. It exists once so no call site above has to
// remember that a `*string` to "" and a nil `*string` are different bytes on the wire and only one
// of them satisfies an optional `z.uuid()`.
func optional(value string) *string {
	if value == "" {
		return nil
	}
	copied := value
	return &copied
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefDirection(value *contract.CallDirection) contract.CallDirection {
	if value == nil {
		return ""
	}
	return *value
}
