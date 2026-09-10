package registrar_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// The `scope=registration` ACL and the `auth-failed` report, both of which the E2E audit found
// accepted, stored and published by the control plane and enforced nowhere at the edge.

func blocklist(t *testing.T, entries ...profile.Entry) *profile.ACL {
	t.Helper()
	return profile.NewWatchedBlocklist(entries)
}

func denyEntry(t *testing.T, network string) profile.Entry {
	t.Helper()
	entry, err := profile.ParseEntry(network, profile.ActionDeny, 0, "", "e2e deny")
	if err != nil {
		t.Fatalf("ParseEntry(%q): %v", network, err)
	}
	return entry
}

func allowEntry(t *testing.T, network string) profile.Entry {
	t.Helper()
	entry, err := profile.ParseEntry(network, profile.ActionAllow, 0, "", "e2e allow")
	if err != nil {
		t.Fatalf("ParseEntry(%q): %v", network, err)
	}
	return entry
}

func withRegistrationACL(acl *profile.ACL) harnessOption {
	return func(opts *registrar.Options) { opts.RegistrationACL = acl }
}

func TestARegistrationDenyRefusesBeforeAnyChallenge(t *testing.T) {
	h := newHarness(t, nil, withRegistrationACL(blocklist(t, denyEntry(t, "203.0.113.0/24"))))

	res := h.send(h.newRegister("", contactHeader("sip:1001@203.0.113.9:5060")))
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	// 403 and not 401: a challenge would invite the retry loop the rule exists to stop.
	if res.GetHeader("WWW-Authenticate") != nil {
		t.Fatal("a denied source was challenged")
	}
	if len(h.publisher.RegisteredEvents()) != 0 {
		t.Fatal("a denied REGISTER produced a registration event")
	}
}

func TestAMoreSpecificAllowBeatsABroaderRegistrationDeny(t *testing.T) {
	h := newHarness(t, nil, withRegistrationACL(blocklist(t,
		denyEntry(t, "203.0.113.0/24"),
		allowEntry(t, "203.0.113.9/32"),
	)))

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}

// A registration ACL is a blocklist in front of a credential, so a rule naming somebody else's
// network leaves this source registering. That is what keeps one tenant's rule from stopping every
// other tenant's phones on an edge whose read model carries no organization.
func TestARegistrationDenyForAnotherNetworkLeavesThisOneRegistering(t *testing.T) {
	h := newHarness(t, nil, withRegistrationACL(blocklist(t, denyEntry(t, "198.51.100.0/24"))))

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}

func TestAnEmptyRegistrationACLBlocksNothing(t *testing.T) {
	h := newHarness(t, nil, withRegistrationACL(blocklist(t)))

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}

// The registrar is the only process that sees a digest, so a wrong password has no other possible
// reporter — before this, `sip_auth_event.bad-credentials` was a dead letter.
func TestAWrongPasswordIsReportedAsAnAuthFailure(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.registerWithPassword("wrong-password"); res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}

	reported := h.publisher.AuthFailedEvents()
	if len(reported) != 1 {
		t.Fatalf("recorded %d auth failures, want 1", len(reported))
	}
	event := reported[0]
	if event.OrgID != testOrg {
		t.Errorf("orgId = %q, want %q", event.OrgID, testOrg)
	}
	if event.Data.Reason != contract.RegistrationAuthFailedReasonBadCredentials {
		t.Errorf("reason = %q, want bad-credentials", event.Data.Reason)
	}
	if event.Data.Username != testUser || event.Data.AOR != testAOR {
		t.Errorf("account = %q / %q", event.Data.Username, event.Data.AOR)
	}
	if event.Data.SourceAddress == nil || *event.Data.SourceAddress != "203.0.113.9:5060" {
		t.Errorf("sourceAddress = %v", event.Data.SourceAddress)
	}
	if event.Data.AORHash != h.aorHash {
		t.Errorf("aorHash = %q, want %q", event.Data.AORHash, h.aorHash)
	}
	// Nothing derived from the offered password may reach the payload.
	if strings.Contains(event.Subject, testPass) {
		t.Error("the subject carries the password")
	}
}

// One report per source and account per window, or a credential spray becomes a JetStream write
// per packet and `sip_auth_event` becomes the disk the attacker fills.
func TestRepeatedWrongPasswordsAreReportedOnce(t *testing.T) {
	h := newHarness(t, nil)

	for range 5 {
		if res := h.registerWithPassword("wrong-password"); res.StatusCode != 403 {
			t.Fatalf("status = %d, want 403", res.StatusCode)
		}
	}
	if reported := h.publisher.AuthFailedEvents(); len(reported) != 1 {
		t.Fatalf("recorded %d auth failures for one source and account, want 1", len(reported))
	}

	// The window is measured against the registrar's clock, which the harness owns.
	h.now = h.now.Add(registrar.AuthFailureInterval)
	if res := h.registerWithPassword("wrong-password"); res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if reported := h.publisher.AuthFailedEvents(); len(reported) != 2 {
		t.Fatalf("recorded %d auth failures after the window, want 2", len(reported))
	}
}

func TestAnAcceptedRegistrationReportsNoAuthFailure(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if reported := h.publisher.AuthFailedEvents(); len(reported) != 0 {
		t.Fatalf("an accepted REGISTER reported %d auth failures", len(reported))
	}
}

// registerWithPassword runs the digest exchange with a password the account does not have and
// returns the final response.
func (h *harness) registerWithPassword(password string) *sip.Response {
	h.t.Helper()
	challenge := h.send(h.newRegister("", contactHeader("sip:1001@203.0.113.9:5060")))
	if challenge.StatusCode != 401 {
		h.t.Fatalf("expected a challenge, got %d", challenge.StatusCode)
	}
	parsed, err := digest.ParseChallenge(challenge.GetHeader("WWW-Authenticate").Value())
	if err != nil {
		h.t.Fatalf("the challenge is not parsable by a real client: %v", err)
	}
	answer, err := digest.Digest(parsed, digest.Options{
		Method: "REGISTER", URI: "sip:" + testRealm, Username: testUser,
		Password: password, Count: 1, Cnonce: "0a4f113b",
	})
	if err != nil {
		h.t.Fatalf("computing the digest answer: %v", err)
	}
	return h.send(h.newRegister(answer.String(), contactHeader("sip:1001@203.0.113.9:5060")))
}

// A WebSocket contact is reachable only over the connection that registered it (RFC 7118 §5.2), so
// a closed browser tab must not keep forking every later call to a socket nobody holds.

// fakeConnections is a set of live `network/address` pairs.
type fakeConnections struct {
	mu   sync.Mutex
	live map[string]bool
}

func newFakeConnections(live ...string) *fakeConnections {
	set := make(map[string]bool, len(live))
	for _, key := range live {
		set[key] = true
	}
	return &fakeConnections{live: set}
}

func (c *fakeConnections) Connected(network, address string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.live[strings.ToLower(network)+"/"+address]
}

func (c *fakeConnections) close(network, address string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.live, strings.ToLower(network)+"/"+address)
}

func withConnections(probe registrar.ConnectionProbe) harnessOption {
	return func(opts *registrar.Options) { opts.Connections = probe }
}

func TestAWebSocketBindingDiesWithItsConnection(t *testing.T) {
	const source = "203.0.113.9:51234"
	connections := newFakeConnections("ws/" + source)
	h := newHarness(t, nil, withConnections(connections))

	if res := h.registerOverWebSocket(source); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if swept := h.registrar.SweepUnreachable(t.Context()); swept != 0 {
		t.Fatalf("swept %d live bindings", swept)
	}
	if _, found, _ := h.store.Get(t.Context(), testOrg, h.aorHash); !found {
		t.Fatal("a live WebSocket binding was removed")
	}

	connections.close("ws", source)
	if swept := h.registrar.SweepUnreachable(t.Context()); swept != 1 {
		t.Fatalf("swept %d bindings after the socket closed, want 1", swept)
	}
	if _, found, _ := h.store.Get(t.Context(), testOrg, h.aorHash); found {
		t.Fatal("the binding for a closed WebSocket is still in the location service")
	}

	// Presence and the live registrations view are driven by the event, not by the bucket.
	removed := h.publisher.UnregisteredEvents()
	if len(removed) != 1 {
		t.Fatalf("published %d unregistered events, want 1", len(removed))
	}
	if removed[0].Data.Transport != contract.SIPTransportWS {
		t.Errorf("transport = %q, want ws", removed[0].Data.Transport)
	}
	if len(h.publisher.ExpiredEvents()) != 0 {
		t.Error("a closed connection was reported as an expiry")
	}
}

// UDP and TCP contacts carry a routable address and their connections legitimately idle out
// between calls, so the sweep must leave them alone.
func TestTheUnreachableSweepLeavesDatagramBindingsAlone(t *testing.T) {
	h := newHarness(t, nil, withConnections(newFakeConnections()))

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if swept := h.registrar.SweepUnreachable(t.Context()); swept != 0 {
		t.Fatalf("swept %d UDP bindings", swept)
	}
	if _, found, _ := h.store.Get(t.Context(), testOrg, h.aorHash); !found {
		t.Fatal("a UDP binding was removed by the connection sweep")
	}
}

func TestWithoutAProbeNothingIsSwept(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.registerOverWebSocket("203.0.113.9:51234"); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if swept := h.registrar.SweepUnreachable(t.Context()); swept != 0 {
		t.Fatalf("swept %d bindings with no probe configured", swept)
	}
}

// registerOverWebSocket runs the digest exchange over a ws transport from source.
func (h *harness) registerOverWebSocket(source string) *sip.Response {
	h.t.Helper()
	contact := contactHeader("sip:1001@df7jal23ls0d.invalid;transport=ws")
	build := func(authorization string) *sip.Request {
		req := h.newRegister(authorization, contact)
		req.SetTransport("WS")
		req.SetSource(source)
		return req
	}
	challenge := h.send(build(""))
	if challenge.StatusCode != 401 {
		h.t.Fatalf("expected a challenge, got %d", challenge.StatusCode)
	}
	return h.send(build(h.answerChallenge(challenge)))
}

// A rotated SIP secret used to cost the phone a whole positive TTL of 403s: the adapter
// re-REGISTERs correctly, and sipd verifies against the ha1 its cache still holds. There is no
// invalidation event to subscribe to, so the failed digest itself has to provoke the re-ask.

// rotatingCredentials answers with `current`, and counts how many times it was asked to refresh.
type rotatingCredentials struct {
	mu        sync.Mutex
	current   credentials.Credential
	refreshes int
	// pending is installed by Refresh, modelling the rotation having landed in the API between the
	// cached answer and the re-ask.
	pending *credentials.Credential
}

func (c *rotatingCredentials) Lookup(context.Context, string, string) (credentials.Credential, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current, nil
}

func (c *rotatingCredentials) Refresh(context.Context, string, string) (credentials.Credential, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshes++
	if c.pending != nil {
		c.current = *c.pending
		c.pending = nil
	}
	return c.current, nil
}

func (c *rotatingCredentials) refreshCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.refreshes
}

func rotating(stale, rotated string) *rotatingCredentials {
	account := func(password string) credentials.Credential {
		return credentials.Credential{
			OrgID: testOrg, Username: testUser, Realm: testRealm,
			HA1: credentials.HA1(testUser, testRealm, password),
		}
	}
	fresh := account(rotated)
	return &rotatingCredentials{current: account(stale), pending: &fresh}
}

func TestARotatedSecretIsPickedUpOnTheNextRegister(t *testing.T) {
	store := rotating("old-password", testPass)
	h := newHarness(t, store)

	// The phone answers with the NEW password while the store's cached answer is still the old one.
	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200; a rotated secret should not cost a positive TTL", res.StatusCode)
	}
	if store.refreshCount() != 1 {
		t.Fatalf("re-asked the credential store %d times, want exactly 1", store.refreshCount())
	}
	if reported := h.publisher.AuthFailedEvents(); len(reported) != 0 {
		t.Fatalf("a rotation reported %d auth failures", len(reported))
	}
}

func TestAWrongPasswordStillFailsAfterTheReFetch(t *testing.T) {
	// The store answers the same ha1 both times: nothing rotated, the password is simply wrong.
	store := &rotatingCredentials{current: credentials.Credential{
		OrgID: testOrg, Username: testUser, Realm: testRealm,
		HA1: credentials.HA1(testUser, testRealm, testPass),
	}}
	h := newHarness(t, store)

	if res := h.registerWithPassword("wrong-password"); res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if store.refreshCount() != 1 {
		t.Fatalf("re-asked the credential store %d times, want exactly 1", store.refreshCount())
	}
	if reported := h.publisher.AuthFailedEvents(); len(reported) != 1 {
		t.Fatalf("recorded %d auth failures, want 1", len(reported))
	}
}
