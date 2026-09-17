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
// The subject is served raw, not through Nest's framing: a payload wrapped as
// `{"pattern":…,"data":…}` is not answered at all, and here that means every INVITE times out into
// a 503. Core NATS and never JetStream, because a stream's redelivery would ring a phone minutes
// after the caller hung up. The request is flat — any engine may admit a call, and the reply's
// instance id exists only so a refusal can be attributed in the log. Nothing is cached.
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
	// Timeout is the per-request deadline. Defaults to the contract's TimeoutSipInviteRPC, 1000 ms.
	Timeout time.Duration
}

// NewNATSPort builds the port. A nil connection is a wiring mistake, refused here rather than on
// the first INVITE.
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

// Admit implements Port, keeping the two failure shapes apart. A transport failure — no responder,
// a broker outage, a deadline — returns a wrapped ErrNoAnswer. A well-formed reply with `ok:false`
// returns a refusal and no error. Only one of them is the engine's opinion.
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

// admissionRequest maps a CallIntent onto the contract's request. A function and not a method so
// the mapping is testable without a broker.
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
	// orgId is present only when a digest resolved a credential: a trunk has no tenant until the
	// engine's did-index lookup resolves one. An empty string would fail the responder's `z.uuid()`.
	request.OrgID = optional(intent.OrgID)
	// Digest only: a trunk INVITE resolves no credential and must assert no device.
	request.DeviceID = optional(intent.DeviceID)
	request.Profile = optional(intent.Profile)
	request.TrunkID = optional(intent.TrunkID)
	if intent.Transport != "" {
		request.Transport = new(contract.SIPTransport(intent.Transport))
	}
	if intent.HasOffer && intent.SDPOffer != "" {
		// The offer travels here because the engine is the courier for SDP and hands these bytes to
		// `rpc.media.v1.allocate-session` within milliseconds; the alternative is a second broker
		// round trip in the middle of an INVITE.
		request.SDPOffer = new(intent.SDPOffer)
	}
	if hint := intent.MediaHint; hint.Mismatch || hint.Private || hint.AdvertisedMedia != "" {
		request.MediaHint = &contract.SipInviteRequestMediaHint{
			SignallingSource: optional(hint.SignallingSource),
			AdvertisedMedia:  optional(hint.AdvertisedMedia),
			Mismatch:         hint.Mismatch,
			Private:          hint.Private,
		}
	}
	if !intent.Attestation.Empty() {
		request.Attestation = &contract.SipInviteRequestAttestation{
			Verstat:          optional(intent.Attestation.Verstat),
			AssertedIdentity: optional(intent.Attestation.AssertedIdentity),
			OrigID:           optional(intent.Attestation.OrigID),
			Signed:           intent.Attestation.Signed,
		}
		if level := intent.Attestation.Level; level != "" {
			request.Attestation.Level = new(contract.SipInviteRequestAttestationLevel(level))
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
// A reply naming a different leg is rejected: acting on it would admit one call with another call's
// tenant. An unrecognised refusal reason is passed through instead — StatusFor answers 500 for one,
// and rejecting it here would turn contract drift into a timeout.
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
			// StatusFor answers 500 for an empty reason, which is the right status and the wrong log
			// line; `internal` makes the log say what happened.
			admission.Reason = ReasonInternal
			if admission.Detail == "" {
				admission.Detail = "the engine refused without naming a reason"
			}
		}
		return admission, nil
	}
	// An `ok` reply with no tenant is not admissible: every `sip.evt.v1` subject needs a real org
	// token and there is no `_unknown` to fall back on, so such a call would connect and never
	// appear in a CDR.
	if admission.OrgID == "" {
		return Admission{
			LegID:  legID,
			Reason: ReasonInternal,
			Detail: "the engine admitted the call without resolving a tenant",
		}, nil
	}
	return admission, nil
}

// optional renders an empty string as an omitted field: a `*string` to "" and a nil `*string` are
// different bytes on the wire, and only one of them satisfies an optional `z.uuid()`.
func optional(value string) *string {
	if value == "" {
		return nil
	}
	return new(value)
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
