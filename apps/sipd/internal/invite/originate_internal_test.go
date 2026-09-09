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
