//go:build e2e

// End-to-end scenarios against a RUNNING stack (see .scripts/local-stack). Nothing here starts a
// server: the point is the real sipd, api and broker on their real sockets.
//
//	SIPD_E2E=1 SIPD_E2E_PASS_1601=... go test -tags e2e -run TestE2E -v ./...
package sipd_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

const (
	e2eRealm = "local.test"
	e2eUDP   = "127.0.0.1:5160"
	e2eTLS   = "127.0.0.1:5161"
)

func requireE2E(t *testing.T) {
	t.Helper()
	if os.Getenv("SIPD_E2E") != "1" {
		t.Skip("set SIPD_E2E=1 to run against the running local stack")
	}
}

// e2ePassword is the derived SIP password for an extension, passed in rather than derived here:
// the derivation key belongs to the api deployment, not to this module.
func e2ePassword(t *testing.T, extension string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv("SIPD_E2E_PASS_" + extension))
	if value == "" {
		t.Skipf("set SIPD_E2E_PASS_%s to the derived SIP password", extension)
	}
	return value
}

// contactList joins every Contact header of a response: a registrar returns one per binding, and
// GetHeader would see only the first.
func contactList(response *sip.Response) string {
	values := make([]string, 0, 4)
	for _, header := range response.GetHeaders("Contact") {
		values = append(values, header.Value())
	}
	return strings.Join(values, ", ")
}

func dial(t *testing.T, transport sipua.Transport, remote, user, password string) *sipua.UA {
	t.Helper()
	ua, err := sipua.Dial(sipua.Options{
		Transport: transport, Remote: remote, Realm: e2eRealm,
		User: user, Password: password, Timeout: 8 * time.Second,
	})
	if err != nil {
		t.Fatalf("dialing %s %s: %v", transport, remote, err)
	}
	t.Cleanup(func() { _ = ua.Close() })
	return ua
}

// TestE2ERegisterTransports registers one extension over each transport the edge exposes.
func TestE2ERegisterTransports(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1601")

	for _, tc := range []struct {
		transport sipua.Transport
		remote    string
	}{
		{sipua.UDP, e2eUDP},
		{sipua.TCP, e2eUDP},
		{sipua.TLS, e2eTLS},
	} {
		t.Run(string(tc.transport), func(t *testing.T) {
			ua := dial(t, tc.transport, tc.remote, "1601", password)
			started := time.Now()
			response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
			if err != nil {
				t.Fatalf("REGISTER: %v", err)
			}
			if response.StatusCode != 200 {
				t.Fatalf("REGISTER over %s: got %d %s, want 200", tc.transport, response.StatusCode, response.Reason)
			}
			t.Logf("%s REGISTER 200 in %s; Contact: %v", tc.transport, time.Since(started).Round(time.Millisecond), contactList(response))
			if header := response.GetHeader("Contact"); header == nil {
				t.Error("a 200 to REGISTER must echo the binding in a Contact header (RFC 3261 §10.3 step 8)")
			}
		})
	}
}

// TestE2ERegisterWrongPassword expects a 403 and no binding.
func TestE2ERegisterWrongPassword(t *testing.T) {
	requireE2E(t)
	_ = e2ePassword(t, "1601")
	ua := dial(t, sipua.UDP, e2eUDP, "1601", "not-the-password")
	response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil {
		t.Fatalf("REGISTER: %v", err)
	}
	if response.StatusCode != 403 {
		t.Errorf("wrong password: got %d %s, want 403", response.StatusCode, response.Reason)
	}
}

// TestE2ERegisterRealmMismatch answers the challenge against a realm the edge did not send.
func TestE2ERegisterRealmMismatch(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1601")
	ua := dial(t, sipua.UDP, e2eUDP, "1601", password)
	response, err := ua.Register(sipua.RegisterOptions{Expires: 300, AuthRealm: "evil.example.com"})
	if err != nil {
		t.Fatalf("REGISTER: %v", err)
	}
	if response.StatusCode == 200 {
		t.Fatal("a digest computed against a foreign realm was accepted")
	}
	t.Logf("realm mismatch answered with %d %s", response.StatusCode, response.Reason)
}

// TestE2ERegisterUnknownUser expects a refusal that does not distinguish "no such account".
func TestE2ERegisterUnknownUser(t *testing.T) {
	requireE2E(t)
	ua := dial(t, sipua.UDP, e2eUDP, "1699", "whatever")
	response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil {
		t.Fatalf("REGISTER: %v", err)
	}
	if response.StatusCode == 200 {
		t.Fatal("an unknown account registered")
	}
	t.Logf("unknown user answered with %d %s", response.StatusCode, response.Reason)
}

// TestE2ERegisterExpiryPolicy checks the edge clamps a requested lifetime into its policy window.
func TestE2ERegisterExpiryPolicy(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1601")
	for _, requested := range []int{1, 300, 100000} {
		t.Run(fmt.Sprintf("expires-%d", requested), func(t *testing.T) {
			ua := dial(t, sipua.UDP, e2eUDP, "1601", password)
			response, err := ua.Register(sipua.RegisterOptions{Expires: requested})
			if err != nil {
				t.Fatalf("REGISTER: %v", err)
			}
			t.Logf("requested %d -> %d %s, Expires: %v, Contact: %v",
				requested, response.StatusCode, response.Reason,
				response.GetHeader("Expires"), contactList(response))
		})
	}
}

// TestE2EUnregister binds, then removes the binding with Expires: 0.
func TestE2EUnregister(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1602")
	ua := dial(t, sipua.UDP, e2eUDP, "1602", password)
	if response, err := ua.Register(sipua.RegisterOptions{Expires: 300}); err != nil || response.StatusCode != 200 {
		t.Fatalf("initial REGISTER: %v / %v", response, err)
	}
	response, err := ua.Register(sipua.RegisterOptions{ExpiresZero: true})
	if err != nil {
		t.Fatalf("un-REGISTER: %v", err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("un-REGISTER: got %d %s, want 200", response.StatusCode, response.Reason)
	}
	if listed := contactList(response); strings.Contains(listed, ua.LocalAddr()) {
		t.Errorf("the removed binding is still listed: %s", listed)
	}
}

// TestE2ETwoDevicesOneExtension registers two sockets on one AOR and expects both bindings to
// survive: a desk phone and a mobile ring together.
func TestE2ETwoDevicesOneExtension(t *testing.T) {
	requireE2E(t)
	password := e2ePassword(t, "1603")
	first := dial(t, sipua.UDP, e2eUDP, "1603", password)
	second := dial(t, sipua.UDP, e2eUDP, "1603", password)
	second.SetCallID(second.CallID() + "-b")

	for index, ua := range []*sipua.UA{first, second} {
		response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
		if err != nil {
			t.Fatalf("device %d REGISTER: %v", index, err)
		}
		if response.StatusCode != 200 {
			t.Fatalf("device %d REGISTER: got %d %s", index, response.StatusCode, response.Reason)
		}
		t.Logf("device %d bound; Contact: %v", index, contactList(response))
	}

	response, err := second.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil {
		t.Fatalf("re-REGISTER: %v", err)
	}
	contact := contactList(response)
	if !strings.Contains(contact, first.LocalAddr()) || !strings.Contains(contact, second.LocalAddr()) {
		t.Errorf("both devices must appear in the binding list, got %q (first %s, second %s)",
			contact, first.LocalAddr(), second.LocalAddr())
	}
}
