package invite

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// originateTestHandler is the minimum a buildOriginateInvite call touches: an identity to present
// as, a server string, a logger and a tag minter.
func originateTestHandler() *Handler {
	return &Handler{
		contact: sip.Uri{Scheme: "sip", User: "sipd", Host: "edge.example"},
		server:  "optimiq-sipd",
		log:     slog.Default(),
		newTag:  func() string { return "test-tag" },
	}
}

// The Call-Info header names the appearance so the phone lights the right line key: the shared
// line's number, and the request-URI's host.
func TestBuildOriginateInviteStampsCallInfoForAnAppearance(t *testing.T) {
	h := originateTestHandler()
	number := "2000"
	index := 3
	target := dialTarget{
		requestURI:       sip.Uri{Scheme: "sip", User: "1001", Host: "phone.example"},
		from:             h.contact,
		sharedLineNumber: &number,
		appearanceIndex:  &index,
	}

	req, _ := h.buildOriginateInvite(
		contract.SipOriginateRequest{LegID: "leg-1", SDPOffer: "v=0\r\n"}, target)

	header := req.GetHeader("Call-Info")
	if header == nil {
		t.Fatal("an appearance target must carry a Call-Info header, got none")
	}
	value := header.Value()
	if !strings.Contains(value, "appearance-index=3") {
		t.Errorf("Call-Info = %q, want it to carry appearance-index=3", value)
	}
	if !strings.Contains(value, "<sip:2000@phone.example>") {
		t.Errorf("Call-Info = %q, want the shared-line number and the request-URI host", value)
	}
}

// With no shared-line number the appearance-index still goes out, addressed to the target user.
func TestBuildOriginateInviteCallInfoFallsBackToTheTargetUser(t *testing.T) {
	h := originateTestHandler()
	index := 1
	target := dialTarget{
		requestURI:      sip.Uri{Scheme: "sip", User: "1001", Host: "phone.example"},
		from:            h.contact,
		appearanceIndex: &index,
	}

	req, _ := h.buildOriginateInvite(
		contract.SipOriginateRequest{LegID: "leg-1", SDPOffer: "v=0\r\n"}, target)

	header := req.GetHeader("Call-Info")
	if header == nil {
		t.Fatal("an appearance target must carry a Call-Info header, got none")
	}
	if value := header.Value(); !strings.Contains(value, "<sip:1001@phone.example>") {
		t.Errorf("Call-Info = %q, want it to fall back to the target user", value)
	}
}

// An ordinary extension gets no Call-Info header: it is an SLA-only signal.
func TestBuildOriginateInviteOmitsCallInfoWithoutAnAppearance(t *testing.T) {
	h := originateTestHandler()
	target := dialTarget{
		requestURI: sip.Uri{Scheme: "sip", User: "1001", Host: "phone.example"},
		from:       h.contact,
	}

	req, _ := h.buildOriginateInvite(
		contract.SipOriginateRequest{LegID: "leg-1", SDPOffer: "v=0\r\n"}, target)

	if header := req.GetHeader("Call-Info"); header != nil {
		t.Errorf("an ordinary target must not carry a Call-Info header, got %q", header.Value())
	}
}

// trunkDialTarget is the shape resolveTrunk builds: a carrier proxy in the Request-URI and the
// trunk's configured SIP domain in the From/PAI host.
func trunkDialTarget() dialTarget {
	return dialTarget{
		requestURI: sip.Uri{Scheme: "sip", User: "15551230000", Host: "proxy.carrier.example"},
		from:       sip.Uri{Scheme: "sip", Host: "acme.carrier.example"},
		trunkID:    "018f0000-0000-7000-8000-0000000000t1",
	}
}

// Every outbound trunk INVITE asserts the tenant's identity (RFC 3325 §7): carriers authenticate on
// PAI and treat From as display-only. With presentation allowed the From is unchanged and there is
// no Privacy header.
func TestBuildOriginateInviteAssertsIdentityOnEveryTrunkInvite(t *testing.T) {
	h := originateTestHandler()
	number, name := "15559990000", "Acme Ltd"
	allowed := contract.SipOriginateRequestCallerIDPresentationAllowed

	req, _ := h.buildOriginateInvite(contract.SipOriginateRequest{
		LegID: "leg-1", SDPOffer: "v=0\r\n",
		CallerIDNumber: &number, CallerIDName: &name, CallerIDPresentation: &allowed,
	}, trunkDialTarget())

	pai := req.GetHeader("P-Asserted-Identity")
	if pai == nil {
		t.Fatal("a trunk INVITE went out with no P-Asserted-Identity")
	}
	if want := `"Acme Ltd" <sip:15559990000@acme.carrier.example>`; pai.Value() != want {
		t.Errorf("P-Asserted-Identity = %q, want %q", pai.Value(), want)
	}
	from := req.From()
	if from.Address.User != number || from.Address.Host != "acme.carrier.example" {
		t.Errorf("From = %q, want the real identity when presentation is allowed", from.Address.String())
	}
	if from.DisplayName != name {
		t.Errorf("From display name = %q, want %q", from.DisplayName, name)
	}
	if header := req.GetHeader("Privacy"); header != nil {
		t.Errorf("Privacy = %q, want none when presentation is allowed", header.Value())
	}
}

// A restricted presentation anonymises the From (RFC 3323 §4.1.1.3), keeps the real identity in PAI
// so the carrier's authorisation still resolves, and asks the trust-domain edge to strip it with
// `Privacy: id` (§4.2). The Contact keeps the real signalling address — it is transport.
func TestBuildOriginateInviteWithholdsTheNumberOnARestrictedTrunkInvite(t *testing.T) {
	h := originateTestHandler()
	number, name := "15559990000", "Acme Ltd"
	restricted := contract.SipOriginateRequestCallerIDPresentationRestricted

	req, _ := h.buildOriginateInvite(contract.SipOriginateRequest{
		LegID: "leg-1", SDPOffer: "v=0\r\n",
		CallerIDNumber: &number, CallerIDName: &name, CallerIDPresentation: &restricted,
	}, trunkDialTarget())

	from := req.From()
	if want := "sip:anonymous@anonymous.invalid"; from.Address.String() != want {
		t.Errorf("From = %q, want %q", from.Address.String(), want)
	}
	if from.DisplayName != "Anonymous" {
		t.Errorf("From display name = %q, want %q", from.DisplayName, "Anonymous")
	}
	if _, ok := from.Params.Get("tag"); !ok {
		t.Error("the anonymised From lost its local tag")
	}
	pai := req.GetHeader("P-Asserted-Identity")
	if pai == nil || !strings.Contains(pai.Value(), "sip:15559990000@acme.carrier.example") {
		t.Fatalf("P-Asserted-Identity = %v, want the real identity", pai)
	}
	privacy := req.GetHeader("Privacy")
	if privacy == nil || privacy.Value() != "id" {
		t.Fatalf("Privacy = %v, want %q", privacy, "id")
	}
	if contact := req.Contact(); contact == nil || contact.Address.Host != "edge.example" {
		t.Fatalf("Contact = %v, want the real signalling address", contact)
	}
	if strings.Contains(string(req.Body()), "anonymous") {
		t.Error("the body was rewritten; CLIR is a header concern")
	}
}

// An internal leg gets no P-Asserted-Identity — it is only valid inside a trust domain and a
// registered handset is not one — but a restricted call is still anonymised toward it.
func TestBuildOriginateInviteKeepsAssertedIdentityOffAnInternalLeg(t *testing.T) {
	h := originateTestHandler()
	number := "1001"
	restricted := contract.SipOriginateRequestCallerIDPresentationRestricted
	target := dialTarget{
		requestURI: sip.Uri{Scheme: "sip", User: "1002", Host: "phone.example"},
		from:       h.contact,
	}

	req, _ := h.buildOriginateInvite(contract.SipOriginateRequest{
		LegID: "leg-1", SDPOffer: "v=0\r\n",
		CallerIDNumber: &number, CallerIDPresentation: &restricted,
	}, target)

	if header := req.GetHeader("P-Asserted-Identity"); header != nil {
		t.Errorf("P-Asserted-Identity = %q, want none toward an untrusted UA", header.Value())
	}
	if want := "sip:anonymous@anonymous.invalid"; req.From().Address.String() != want {
		t.Errorf("From = %q, want %q", req.From().Address.String(), want)
	}

	plain := dialTarget{requestURI: target.requestURI, from: h.contact}
	ordinary, _ := h.buildOriginateInvite(contract.SipOriginateRequest{
		LegID: "leg-2", SDPOffer: "v=0\r\n", CallerIDNumber: &number,
	}, plain)
	if ordinary.From().Address.User != number {
		t.Errorf("From user = %q, want the number presented normally", ordinary.From().Address.User)
	}
	if header := ordinary.GetHeader("Privacy"); header != nil {
		t.Errorf("Privacy = %q, want none on an unrestricted internal leg", header.Value())
	}
}

// The To is the address of record and the Request-URI the contact it is registered at. A phone
// builds its in-dialog requests' From from the To (RFC 3261 §12.2), so a contact URI here is what
// made the callee's REFER arrive as an anonymous instance URI.
func TestBuildOriginateInviteAddressesTheAORAndDialsTheContact(t *testing.T) {
	h := originateTestHandler()
	contactURI := sip.Uri{Scheme: "sip", User: "mdokeqt0", Host: "bnttdi537va5.invalid"}
	target := dialTarget{requestURI: contactURI, aor: "sip:1203@acme.example.com", from: h.contact}

	req, _ := h.buildOriginateInvite(
		contract.SipOriginateRequest{LegID: "leg-1", SDPOffer: "v=0\r\n"}, target)

	to := req.To()
	if to == nil || to.Address.String() != "sip:1203@acme.example.com" {
		t.Errorf("To = %v, want the address of record", to)
	}
	if req.Recipient.String() != contactURI.String() {
		t.Errorf("Request-URI = %v, want the registered contact", req.Recipient)
	}
}

// A trunk or a bare URI has no address of record, so the To stays the Request-URI.
func TestBuildOriginateInviteAddressesTheRequestURIWithoutAnAOR(t *testing.T) {
	h := originateTestHandler()
	uri := sip.Uri{Scheme: "sip", User: "+15551230000", Host: "carrier.example"}
	target := dialTarget{requestURI: uri, from: h.contact}

	req, _ := h.buildOriginateInvite(
		contract.SipOriginateRequest{LegID: "leg-1", SDPOffer: "v=0\r\n"}, target)

	if to := req.To(); to == nil || to.Address.String() != uri.String() {
		t.Errorf("To = %v, want %v", to, uri)
	}
}
