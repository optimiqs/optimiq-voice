package invite

import (
	"errors"
	"strings"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
)

func trunkIntent() CallIntent {
	return CallIntent{
		LegID:          "leg-1",
		InstanceID:     "sipd-7c9f",
		Authentication: AuthenticationTrunkACL,
		Profile:        "external",
		RoutingContext: profile.ContextUntrusted,
		From:           Party{Number: "+441632960100", URI: "sip:+441632960100@carrier.example"},
		To:             Party{Number: "+441632960111", URI: "sip:+441632960111@acme.example.com"},
		SIPCallID:      "a84b4c76e66710@pc33",
		FromTag:        "from-tag",
		TrunkID:        "018f0000-0000-7000-8000-0000000000t1",
		SourceAddress:  "203.0.113.7:5060",
		Transport:      "udp",
		HasOffer:       true,
		SDPOffer:       "v=0\r\n",
	}
}

// A trunk INVITE has NO tenant, and the field must be OMITTED rather than sent empty. The
// responder's `z.uuid()` rejects "" — so an empty string would turn every carrier call into a
// `bad_request`, which is the failure this one branch exists to prevent.
func TestATrunkIntentOmitsTheTenantEntirely(t *testing.T) {
	request := admissionRequest(trunkIntent())

	if request.OrgID != nil {
		t.Fatalf("orgId = %v, want it omitted for a trunk INVITE", *request.OrgID)
	}
	if request.Authentication != contract.SipInviteRequestAuthenticationTrunkAcl {
		t.Fatalf("authentication = %q, want trunk-acl", request.Authentication)
	}
	if request.TrunkID == nil || *request.TrunkID == "" {
		t.Fatal("trunkId was not carried; the engine cannot attribute the call without it")
	}
}

// A digest INVITE carries the tenant the credential resolved, and the AOR rebuilt FROM the
// credential rather than copied from the From header.
func TestADigestIntentCarriesTheTenantAndTheCredentialAOR(t *testing.T) {
	intent := trunkIntent()
	intent.Authentication = AuthenticationDigest
	intent.OrgID = "018f0000-0000-7000-8000-000000000000"
	intent.RoutingContext = profile.ContextInternal
	intent.TrunkID = ""
	intent.From.AOR = "sip:1001@acme.example.com"

	request := admissionRequest(intent)

	if request.OrgID == nil || *request.OrgID != intent.OrgID {
		t.Fatalf("orgId = %v, want %q", request.OrgID, intent.OrgID)
	}
	if request.From.AOR == nil || *request.From.AOR != "sip:1001@acme.example.com" {
		t.Fatalf("from.aor = %v, want the credential's canonical form", request.From.AOR)
	}
	if request.TrunkID != nil {
		t.Fatalf("trunkId = %v, want it omitted for a digest INVITE", *request.TrunkID)
	}
	if request.RoutingContext != string(profile.ContextInternal) {
		t.Fatalf("routingContext = %q, want internal", request.RoutingContext)
	}
}

// The offer travels on the admission request. It is the one field on this contract whose placement
// was argued both ways: it is here because the engine is the courier for SDP and will hand these
// bytes to allocate-session within milliseconds, and the alternative is a broker round trip back to
// this edge in the middle of an INVITE.
func TestTheOfferTravelsWithTheAdmissionRequest(t *testing.T) {
	request := admissionRequest(trunkIntent())

	if !request.HasOffer {
		t.Fatal("hasOffer is false for an INVITE that carried a body")
	}
	if request.SDPOffer == nil || *request.SDPOffer != "v=0\r\n" {
		t.Fatalf("sdpOffer = %v, want the body verbatim", request.SDPOffer)
	}
}

// A delayed-offer INVITE is legal and rare. It must not send an empty sdpOffer, which would be a
// zero-length body the engine would hand to mediad and mediad would refuse.
func TestADelayedOfferInviteOmitsTheBody(t *testing.T) {
	intent := trunkIntent()
	intent.HasOffer = false
	intent.SDPOffer = ""

	request := admissionRequest(intent)

	if request.HasOffer {
		t.Fatal("hasOffer is true for an INVITE with no body")
	}
	if request.SDPOffer != nil {
		t.Fatalf("sdpOffer = %v, want it omitted", *request.SDPOffer)
	}
}

// The media hint is sent only when there is something to say. An always-present hint whose every
// field is empty would make `mismatch: false` indistinguishable from "nobody looked".
func TestTheMediaHintTravelsOnlyWhenItSaysSomething(t *testing.T) {
	silent := admissionRequest(trunkIntent())
	if silent.MediaHint != nil {
		t.Fatalf("mediaHint = %+v, want it omitted when there is nothing to report", silent.MediaHint)
	}

	intent := trunkIntent()
	intent.MediaHint = nat.MediaHint{
		SignallingSource: "203.0.113.7:5060",
		AdvertisedMedia:  "192.168.1.42",
		Mismatch:         true,
		Private:          true,
	}
	loud := admissionRequest(intent)
	if loud.MediaHint == nil {
		t.Fatal("mediaHint was dropped; mediad expects a latch and would be surprised instead")
	}
	if !loud.MediaHint.Mismatch || !loud.MediaHint.Private {
		t.Fatalf("mediaHint = %+v, want both flags preserved", loud.MediaHint)
	}
}

// A reply for a DIFFERENT leg is a responder bug, and acting on it would admit one call with
// another call's tenant — a billing attribution error before it is a routing one.
func TestAReplyForAnotherLegIsRefused(t *testing.T) {
	_, err := admissionFrom(contract.SipInviteResponse{Ok: true, LegID: "leg-2"}, "leg-1")
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("error = %v, want ErrNoAnswer", err)
	}
	if err == nil || !strings.Contains(err.Error(), "leg-2") {
		t.Fatalf("error = %v, want it to name the leg that was answered about", err)
	}
}

// An `ok` reply with no tenant is not admissible. Every `sip.evt.v1` subject needs a real org token
// and there is no `_unknown` to fall back on, so a call admitted without one would connect and
// never appear in a CDR.
func TestAnAdmissionWithNoTenantIsRefusedInternally(t *testing.T) {
	callID := "call-1"
	admission, err := admissionFrom(contract.SipInviteResponse{
		Ok: true, LegID: "leg-1", CallID: &callID,
	}, "leg-1")
	if err != nil {
		t.Fatalf("admissionFrom: %v", err)
	}
	if admission.OK {
		t.Fatal("a tenantless admission was accepted; nothing could ever publish an event for it")
	}
	if admission.Reason != ReasonInternal {
		t.Fatalf("reason = %q, want %q", admission.Reason, ReasonInternal)
	}
}

// A refusal with no reason is unusable in the log. Naming it `internal` makes the line say what
// happened rather than leaving a blank field somebody has to interpret.
func TestARefusalWithNoReasonBecomesInternal(t *testing.T) {
	admission, err := admissionFrom(contract.SipInviteResponse{Ok: false, LegID: "leg-1"}, "leg-1")
	if err != nil {
		t.Fatalf("admissionFrom: %v", err)
	}
	if admission.Reason != ReasonInternal {
		t.Fatalf("reason = %q, want %q", admission.Reason, ReasonInternal)
	}
	if admission.Detail == "" {
		t.Fatal("detail is empty; the log line would say nothing at all")
	}
}

// Every reason the contract knows must map to a status a stranger can act on, and the whole table is
// asserted rather than spot-checked — because each row is a different instruction to the caller.
func TestEveryContractRefusalReasonMapsToItsStatus(t *testing.T) {
	for _, row := range []struct {
		reason contract.SipInviteResponseReason
		status int
	}{
		{contract.SipInviteResponseReasonUnattributed, 404},
		{contract.SipInviteResponseReasonUnknownTarget, 404},
		{contract.SipInviteResponseReasonNotPermitted, 403},
		{contract.SipInviteResponseReasonCongestion, 503},
		{contract.SipInviteResponseReasonShuttingDown, 503},
		{contract.SipInviteResponseReasonBadRequest, 400},
		{contract.SipInviteResponseReasonInternal, 500},
	} {
		t.Run(string(row.reason), func(t *testing.T) {
			admission, err := admissionFrom(contract.SipInviteResponse{
				Ok: false, LegID: "leg-1", Reason: &row.reason,
			}, "leg-1")
			if err != nil {
				t.Fatalf("admissionFrom: %v", err)
			}
			if got := StatusFor(admission.Reason); got.Status != row.status {
				t.Fatalf("%s -> %d, want %d", row.reason, got.Status, row.status)
			}
		})
	}
}

// A drain's 503 carries a Retry-After, and that header is the entire point: without it a carrier
// retries HERE instead of failing over to another node.
func TestTheDrainRefusalCarriesARetryAfter(t *testing.T) {
	if refusal := StatusFor(ReasonShuttingDown); refusal.RetryAfter <= 0 {
		t.Fatal("shutting_down has no Retry-After; a carrier would retry at a node that is going away")
	}
	if refusal := StatusFor(ReasonCongestion); refusal.RetryAfter != 0 {
		t.Fatal("congestion carries a Retry-After; it is a capacity signal, not a drain")
	}
}

// A nil connection is a wiring mistake and not a runtime state, refused at construction rather than
// on the first call from a carrier.
func TestTheNATSPortRefusesANilConnection(t *testing.T) {
	if _, err := NewNATSPort(nil, NATSOptions{}); err == nil {
		t.Fatal("NewNATSPort accepted a nil connection")
	}
}
