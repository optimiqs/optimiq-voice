package registrar_test

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/emiago/sipgo/siptest"
	"github.com/icholy/digest"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// Binding-lifecycle tests, driven through the real SIP handler with real digest credentials.
//
// The requests are parsed from wire text and the responses are produced by sipgo's own transaction
// recorder, so these exercise header parsing and response assembly rather than a Go-level mock of
// them. The digest answer is computed by github.com/icholy/digest — the CLIENT side of the same
// RFC — which means the server side here is checked against an independent implementation, not
// against itself.

const (
	testRealm = "acme.example.com"
	testOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testUser  = "1001"
	testPass  = "s3cret"
	testAOR   = "sip:1001@acme.example.com"
	testAgent = "Yealink SIP-T46U 108.86.0.40"
)

type harness struct {
	t         *testing.T
	registrar *registrar.Registrar
	store     *kv.MemoryStore
	publisher *events.RecordingPublisher
	parser    *sip.Parser
	now       time.Time
	cseq      int
	aorHash   string
}

type staticCredentials struct {
	credential credentials.Credential
	err        error
}

func (s staticCredentials) Lookup(_ context.Context, _, _ string) (credentials.Credential, error) {
	if s.err != nil {
		return credentials.Credential{}, s.err
	}
	return s.credential, nil
}

func newHarness(t *testing.T, lookup credentials.Store) *harness {
	t.Helper()

	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("test-nonce-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	h := &harness{
		t:         t,
		store:     kv.NewMemoryStore(),
		publisher: events.NewRecordingPublisher(),
		parser:    sip.NewParser(),
		now:       time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC),
	}
	hash, err := contract.AORSubjectToken(testAOR)
	if err != nil {
		t.Fatalf("AORSubjectToken: %v", err)
	}
	h.aorHash = hash

	if lookup == nil {
		lookup = staticCredentials{credential: credentials.Credential{
			OrgID:       testOrg,
			Username:    testUser,
			Realm:       testRealm,
			HA1:         credentials.HA1(testUser, testRealm, testPass),
			DeviceID:    "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50",
			ExtensionID: "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51",
		}}
	}

	reg, err := registrar.New(registrar.Options{
		Realm:       testRealm,
		Auth:        authenticator,
		Expiry:      registrar.ExpiryPolicy{Min: 60 * time.Second, Max: time.Hour, Default: 300 * time.Second},
		Credentials: lookup,
		Bindings:    h.store,
		Publisher:   h.publisher,
		Logger:      slog.New(slog.DiscardHandler),
		Source:      "sipd",
		BaseContext: context.Background(),
		Now:         func() time.Time { return h.now },
	})
	if err != nil {
		t.Fatalf("registrar.New: %v", err)
	}
	h.registrar = reg
	return h
}

// register performs the full two-legged digest exchange and returns the FINAL response.
func (h *harness) register(headers ...string) *sip.Response {
	h.t.Helper()

	challengeResponse := h.send(h.newRegister("", headers...))
	if challengeResponse.StatusCode != 401 {
		// Not a challenge: the registrar rejected the unauthenticated request outright, which is
		// itself the answer some tests are looking for.
		return challengeResponse
	}
	authorization := h.answerChallenge(challengeResponse)
	return h.send(h.newRegister(authorization, headers...))
}

func (h *harness) answerChallenge(res *sip.Response) string {
	h.t.Helper()
	header := res.GetHeader("WWW-Authenticate")
	if header == nil {
		h.t.Fatal("401 carried no WWW-Authenticate header")
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		h.t.Fatalf("the challenge is not parsable by a real client: %v", err)
	}
	answer, err := digest.Digest(challenge, digest.Options{
		Method:   "REGISTER",
		URI:      "sip:" + testRealm,
		Username: testUser,
		Password: testPass,
		Count:    1,
		Cnonce:   "0a4f113b",
	})
	if err != nil {
		h.t.Fatalf("computing the digest answer: %v", err)
	}
	return answer.String()
}

func (h *harness) newRegister(authorization string, extra ...string) *sip.Request {
	h.t.Helper()
	h.cseq++

	lines := []string{
		"REGISTER sip:" + testRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK" + strconv.Itoa(h.cseq) + ";rport",
		"Max-Forwards: 70",
		"From: <" + testAOR + ">;tag=fromtag",
		"To: <" + testAOR + ">",
		"Call-ID: 3c26700c1adf-6qgy0fkn7cvb",
		"CSeq: " + strconv.Itoa(h.cseq) + " REGISTER",
		"User-Agent: " + testAgent,
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, extra...)
	lines = append(lines, "Content-Length: 0", "", "")

	message, err := h.parser.ParseSIP([]byte(strings.Join(lines, "\r\n")))
	if err != nil {
		h.t.Fatalf("building the REGISTER: %v", err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		h.t.Fatalf("parsed a %T, want a request", message)
	}
	req.SetTransport("UDP")
	req.SetSource("203.0.113.9:5060")
	return req
}

func (h *harness) send(req *sip.Request) *sip.Response {
	h.t.Helper()
	tx := siptest.NewServerTxRecorder(req)
	h.registrar.HandleRegister(req, tx)
	results := tx.Result()
	if len(results) == 0 {
		h.t.Fatal("the handler produced no response; a transaction must always be answered")
	}
	return results[len(results)-1]
}

func contactHeader(uri string, params ...string) string {
	header := "Contact: <" + uri + ">"
	for _, param := range params {
		header += ";" + param
	}
	return header
}

func (h *harness) binding() (kv.Binding, bool) {
	h.t.Helper()
	binding, found, err := h.store.Get(context.Background(), testOrg, h.aorHash)
	if err != nil {
		h.t.Fatalf("reading the binding: %v", err)
	}
	return binding, found
}

// ---------------------------------------------------------------------------------------------

func TestRegisterChallengesThenBinds(t *testing.T) {
	h := newHarness(t, nil)

	unauthenticated := h.send(h.newRegister("", contactHeader("sip:1001@203.0.113.9:5060")))
	if unauthenticated.StatusCode != 401 {
		t.Fatalf("first response = %d, want 401", unauthenticated.StatusCode)
	}
	if unauthenticated.GetHeader("WWW-Authenticate") == nil {
		t.Fatal("the 401 must carry a challenge or the device has nothing to answer")
	}

	res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=600"))
	if res.StatusCode != 200 {
		t.Fatalf("authenticated response = %d %s, want 200", res.StatusCode, res.Reason)
	}

	binding, found := h.binding()
	if !found {
		t.Fatal("no binding was written to the location service")
	}
	if binding.OrgID != testOrg {
		t.Errorf("binding.OrgID = %q, want the org from the credential record", binding.OrgID)
	}
	if binding.AOR != testAOR {
		t.Errorf("binding.AOR = %q, want %q", binding.AOR, testAOR)
	}
	if binding.AORHash != h.aorHash {
		t.Errorf("binding.AORHash = %q, want the shared subject token", binding.AORHash)
	}
	if binding.Contact != "sip:1001@203.0.113.9:5060" {
		t.Errorf("binding.Contact = %q, want the device's contact verbatim", binding.Contact)
	}
	if binding.ExpiresInSeconds != 600 {
		t.Errorf("binding.ExpiresInSeconds = %d, want the requested 600", binding.ExpiresInSeconds)
	}
	if binding.Transport != contract.SIPTransportUDP {
		t.Errorf("binding.Transport = %q, want udp", binding.Transport)
	}
	if binding.UserAgent != testAgent {
		t.Errorf("binding.UserAgent = %q, want the device's User-Agent", binding.UserAgent)
	}
	if !binding.ExpiresAt.Time.Equal(h.now.Add(600 * time.Second)) {
		t.Errorf("binding.ExpiresAt = %s, want now+600s", binding.ExpiresAt.Time)
	}

	// The 200 must tell the device the GRANTED interval, not repeat what it asked for.
	if got := res.GetHeader("Expires"); got == nil || got.Value() != "600" {
		t.Errorf("Expires header = %v, want 600", got)
	}
	if res.Contact() == nil {
		t.Error("the 200 must echo the bound Contact")
	}

	registered := h.publisher.RegisteredEvents()
	if len(registered) != 1 {
		t.Fatalf("published %d registered events, want 1", len(registered))
	}
	event := registered[0]
	wantSubject := "sip.reg.v1." + testOrg + "." + h.aorHash + ".registered"
	if event.Subject != wantSubject {
		t.Errorf("subject = %q, want %q", event.Subject, wantSubject)
	}
	if event.Type != contract.EventTypeRegistrationRegistered {
		t.Errorf("type = %q", event.Type)
	}
	if event.Source != "sipd" {
		t.Errorf("source = %q, want sipd", event.Source)
	}
	if event.Data.AORHash != h.aorHash {
		t.Errorf("data.aorHash = %q, want it derived from the AOR", event.Data.AORHash)
	}
	if event.Data.Refreshed == nil || *event.Data.Refreshed {
		t.Error("the first REGISTER is not a refresh")
	}
	if event.Data.DeviceID == nil || *event.Data.DeviceID == "" {
		t.Error("the credential's deviceId must travel in the event so the UI can join to inventory")
	}
	if err := contract.CheckSubject(event.Subject, event); err != nil {
		t.Errorf("the published envelope is inconsistent with its subject: %v", err)
	}
}

func TestRefreshKeepsTheOriginalRegistrationInstant(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=120")); res.StatusCode != 200 {
		t.Fatalf("first REGISTER = %d", res.StatusCode)
	}
	first, _ := h.binding()

	h.now = h.now.Add(60 * time.Second)
	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=120")); res.StatusCode != 200 {
		t.Fatalf("refresh = %d", res.StatusCode)
	}
	second, _ := h.binding()

	if !second.RegisteredAt.Time.Equal(first.RegisteredAt.Time) {
		t.Errorf("RegisteredAt moved on refresh (%s -> %s); registeredForSeconds would then be wrong",
			first.RegisteredAt.Time, second.RegisteredAt.Time)
	}
	if !second.ExpiresAt.Time.Equal(h.now.Add(120 * time.Second)) {
		t.Errorf("ExpiresAt = %s, want the refresh to extend it", second.ExpiresAt.Time)
	}

	registered := h.publisher.RegisteredEvents()
	if len(registered) != 2 {
		t.Fatalf("published %d registered events, want 2", len(registered))
	}
	if registered[1].Data.Refreshed == nil || !*registered[1].Data.Refreshed {
		t.Error("the second REGISTER must be flagged as a refresh")
	}
}

func TestExpiresZeroDeregisters(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=300")); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d", res.StatusCode)
	}

	res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=0"))
	if res.StatusCode != 200 {
		t.Fatalf("de-register = %d %s, want 200", res.StatusCode, res.Reason)
	}
	if _, found := h.binding(); found {
		t.Error("the binding survived an explicit de-registration")
	}
	if h.registrar.TrackedBindings() != 0 {
		t.Error("the de-registered binding is still tracked for expiry")
	}

	unregistered := h.publisher.UnregisteredEvents()
	if len(unregistered) != 1 {
		t.Fatalf("published %d unregistered events, want 1", len(unregistered))
	}
	if unregistered[0].Data.Reason == nil ||
		*unregistered[0].Data.Reason != contract.RegistrationUnregisteredReasonClient {
		t.Errorf("reason = %v, want client", unregistered[0].Data.Reason)
	}

	// Idempotency: a device that repeats Expires: 0 must not produce a second event.
	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=0")); res.StatusCode != 200 {
		t.Fatalf("repeated de-register = %d", res.StatusCode)
	}
	if got := len(h.publisher.UnregisteredEvents()); got != 1 {
		t.Errorf("published %d unregistered events after a repeat, want 1", got)
	}
}

func TestWildcardContactRemovesEverything(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=300")); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d", res.StatusCode)
	}

	res := h.register("Contact: *", "Expires: 0")
	if res.StatusCode != 200 {
		t.Fatalf("wildcard de-register = %d %s, want 200", res.StatusCode, res.Reason)
	}
	if _, found := h.binding(); found {
		t.Error("`Contact: *` with Expires: 0 must drop the binding")
	}

	// A wildcard WITHOUT Expires: 0 is malformed and must not silently drop anything.
	h2 := newHarness(t, nil)
	if res := h2.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=300")); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d", res.StatusCode)
	}
	if res := h2.register("Contact: *", "Expires: 3600"); res.StatusCode != 400 {
		t.Errorf("wildcard with a non-zero Expires = %d, want 400", res.StatusCode)
	}
	if _, found := h2.binding(); !found {
		t.Error("a malformed wildcard REGISTER dropped the binding anyway")
	}
}

func TestExpiryClampingOverTheWire(t *testing.T) {
	t.Run("too brief is refused with Min-Expires", func(t *testing.T) {
		h := newHarness(t, nil)
		res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=10"))
		if res.StatusCode != 423 {
			t.Fatalf("status = %d, want 423 Interval Too Brief", res.StatusCode)
		}
		header := res.GetHeader("Min-Expires")
		if header == nil || header.Value() != "60" {
			t.Errorf("Min-Expires = %v, want 60 so the device knows what to ask for", header)
		}
		if _, found := h.binding(); found {
			t.Error("a refused REGISTER must not create a binding")
		}
	})

	t.Run("too long is clamped down silently", func(t *testing.T) {
		h := newHarness(t, nil)
		if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=86400")); res.StatusCode != 200 {
			t.Fatalf("status = %d, want 200", res.StatusCode)
		}
		binding, _ := h.binding()
		if binding.ExpiresInSeconds != 3600 {
			t.Errorf("granted %d seconds, want the 3600 maximum", binding.ExpiresInSeconds)
		}
	})

	t.Run("no interval at all uses the default", func(t *testing.T) {
		h := newHarness(t, nil)
		if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
			t.Fatalf("status = %d, want 200", res.StatusCode)
		}
		binding, _ := h.binding()
		if binding.ExpiresInSeconds != 300 {
			t.Errorf("granted %d seconds, want the 300 default", binding.ExpiresInSeconds)
		}
	})

	t.Run("a contact parameter beats the Expires header", func(t *testing.T) {
		h := newHarness(t, nil)
		res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=120"), "Expires: 3600")
		if res.StatusCode != 200 {
			t.Fatalf("status = %d", res.StatusCode)
		}
		binding, _ := h.binding()
		if binding.ExpiresInSeconds != 120 {
			t.Errorf("granted %d seconds, want the contact parameter's 120", binding.ExpiresInSeconds)
		}
	})
}

func TestSweeperExpiresLapsedBindings(t *testing.T) {
	h := newHarness(t, nil)

	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=60")); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d", res.StatusCode)
	}
	if h.registrar.TrackedBindings() != 1 {
		t.Fatalf("tracked %d bindings, want 1", h.registrar.TrackedBindings())
	}

	// Still inside the granted interval: nothing may expire yet.
	h.now = h.now.Add(59 * time.Second)
	if swept := h.registrar.Sweep(context.Background()); swept != 0 {
		t.Fatalf("swept %d bindings before the deadline", swept)
	}

	h.now = h.now.Add(2 * time.Second)
	if swept := h.registrar.Sweep(context.Background()); swept != 1 {
		t.Fatalf("swept %d bindings after the deadline, want 1", swept)
	}
	if _, found := h.binding(); found {
		t.Error("a lapsed binding must be removed from the location service")
	}
	if h.registrar.TrackedBindings() != 0 {
		t.Error("a swept binding is still tracked")
	}

	expired := h.publisher.ExpiredEvents()
	if len(expired) != 1 {
		t.Fatalf("published %d expired events, want 1", len(expired))
	}
	if expired[0].Type != contract.EventTypeRegistrationExpired {
		t.Errorf("type = %q", expired[0].Type)
	}
	if got := expired[0].Data.RegisteredForSeconds; got == nil || *got != 61 {
		t.Errorf("registeredForSeconds = %v, want 61", got)
	}

	// A second sweep must be a no-op: an `expired` event per tick would poison presence counting.
	if swept := h.registrar.Sweep(context.Background()); swept != 0 {
		t.Errorf("a repeat sweep expired %d bindings", swept)
	}
}

func TestRehydrateAdoptsExistingBindings(t *testing.T) {
	first := newHarness(t, nil)
	if res := first.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=60")); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d", res.StatusCode)
	}

	// A second registrar over the same bucket: the restart case.
	second := newHarness(t, nil)
	second.store = first.store
	second = rebuild(t, second)

	adopted, err := second.registrar.Rehydrate(context.Background())
	if err != nil {
		t.Fatalf("Rehydrate: %v", err)
	}
	if adopted != 1 {
		t.Fatalf("adopted %d bindings, want 1", adopted)
	}

	second.now = second.now.Add(61 * time.Second)
	if swept := second.registrar.Sweep(context.Background()); swept != 1 {
		t.Fatalf("the adopting instance swept %d bindings, want 1", swept)
	}
	if len(second.publisher.ExpiredEvents()) != 1 {
		t.Error("the adopting instance must publish the expired event the previous one never sent")
	}
}

// rebuild returns a harness whose registrar is wired to the (already replaced) store.
func rebuild(t *testing.T, h *harness) *harness {
	t.Helper()
	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("test-nonce-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	reg, err := registrar.New(registrar.Options{
		Realm:  testRealm,
		Auth:   authenticator,
		Expiry: registrar.ExpiryPolicy{Min: 60 * time.Second, Max: time.Hour, Default: 300 * time.Second},
		Credentials: staticCredentials{credential: credentials.Credential{
			OrgID: testOrg, Username: testUser, Realm: testRealm,
			HA1: credentials.HA1(testUser, testRealm, testPass),
		}},
		Bindings:    h.store,
		Publisher:   h.publisher,
		Logger:      slog.New(slog.DiscardHandler),
		Source:      "sipd",
		BaseContext: context.Background(),
		Now:         func() time.Time { return h.now },
	})
	if err != nil {
		t.Fatalf("registrar.New: %v", err)
	}
	h.registrar = reg
	return h
}

func TestUnknownAccountAndForeignAORAreRefused(t *testing.T) {
	t.Run("unknown account", func(t *testing.T) {
		h := newHarness(t, staticCredentials{err: credentials.ErrNotFound})
		res := h.register(contactHeader("sip:1001@203.0.113.9:5060"))
		if res.StatusCode != 403 {
			t.Errorf("status = %d, want 403", res.StatusCode)
		}
	})

	t.Run("disabled account", func(t *testing.T) {
		h := newHarness(t, staticCredentials{err: credentials.ErrDisabled})
		res := h.register(contactHeader("sip:1001@203.0.113.9:5060"))
		if res.StatusCode != 403 {
			t.Errorf("status = %d, want the same 403 an unknown account gets, so the response "+
				"cannot be used to enumerate extensions", res.StatusCode)
		}
	})

	t.Run("wrong password", func(t *testing.T) {
		h := newHarness(t, staticCredentials{credential: credentials.Credential{
			OrgID: testOrg, Username: testUser, Realm: testRealm,
			HA1: credentials.HA1(testUser, testRealm, "not-the-password"),
		}})
		res := h.register(contactHeader("sip:1001@203.0.113.9:5060"))
		if res.StatusCode != 403 {
			t.Errorf("status = %d, want 403 (re-challenging a wrong password loops forever on "+
				"some phones)", res.StatusCode)
		}
		if _, found := h.binding(); found {
			t.Error("a failed digest created a binding")
		}
	})
}

func TestRegisteringSomebodyElsesAORIsRefused(t *testing.T) {
	h := newHarness(t, nil)

	// Authenticate as 1001 but claim to be registering 1002. Without the ownership check this is
	// how any valid account on the realm silently steals another extension's calls.
	challenge := h.send(h.newRegisterFor("sip:1002@"+testRealm, ""))
	if challenge.StatusCode != 401 {
		t.Fatalf("first response = %d, want 401", challenge.StatusCode)
	}
	res := h.send(h.newRegisterFor("sip:1002@"+testRealm, h.answerChallenge(challenge),
		contactHeader("sip:1002@203.0.113.9:5060")))
	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
}

func (h *harness) newRegisterFor(aor, authorization string, extra ...string) *sip.Request {
	h.t.Helper()
	h.cseq++
	lines := []string{
		"REGISTER sip:" + testRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK" + strconv.Itoa(h.cseq) + ";rport",
		"Max-Forwards: 70",
		"From: <" + aor + ">;tag=fromtag",
		"To: <" + aor + ">",
		"Call-ID: other-call-id",
		"CSeq: " + strconv.Itoa(h.cseq) + " REGISTER",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, extra...)
	lines = append(lines, "Content-Length: 0", "", "")

	message, err := h.parser.ParseSIP([]byte(strings.Join(lines, "\r\n")))
	if err != nil {
		h.t.Fatalf("building the REGISTER: %v", err)
	}
	req := message.(*sip.Request)
	req.SetTransport("UDP")
	req.SetSource("203.0.113.9:5060")
	return req
}

func TestQueryReturnsTheCurrentBinding(t *testing.T) {
	h := newHarness(t, nil)
	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060", "expires=300")); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d", res.StatusCode)
	}

	// A REGISTER with no Contact at all is a query (RFC 3261 §10.2.3), not a de-registration.
	res := h.register()
	if res.StatusCode != 200 {
		t.Fatalf("query = %d, want 200", res.StatusCode)
	}
	if res.Contact() == nil {
		t.Fatal("a query must return the current binding")
	}
	if _, found := h.binding(); !found {
		t.Error("a query must not disturb the binding")
	}
}

func TestOptionsAndUnsupportedMethods(t *testing.T) {
	h := newHarness(t, nil)

	options := h.parseRequest(strings.Join([]string{
		"OPTIONS sip:" + testRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bKoptions",
		"From: <sip:probe@" + testRealm + ">;tag=t",
		"To: <sip:" + testRealm + ">",
		"Call-ID: options-1",
		"CSeq: 1 OPTIONS",
		"Content-Length: 0", "", "",
	}, "\r\n"))
	tx := siptest.NewServerTxRecorder(options)
	h.registrar.HandleOptions(options, tx)
	res := lastResponse(t, tx)
	if res.StatusCode != 200 {
		t.Errorf("OPTIONS = %d, want an unconditional 200 keepalive", res.StatusCode)
	}
	if allow := res.GetHeader("Allow"); allow == nil || !strings.Contains(allow.Value(), "REGISTER") {
		t.Errorf("Allow = %v, want the honest method list", allow)
	}
	if allow := res.GetHeader("Allow"); allow != nil && strings.Contains(allow.Value(), "INVITE") {
		t.Error("Allow advertises INVITE, but this edge has no proxy path yet")
	}

	invite := h.parseRequest(strings.Join([]string{
		"INVITE sip:1001@" + testRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bKinvite",
		"From: <sip:2002@" + testRealm + ">;tag=t",
		"To: <sip:1001@" + testRealm + ">",
		"Call-ID: invite-1",
		"CSeq: 1 INVITE",
		"Content-Length: 0", "", "",
	}, "\r\n"))
	tx = siptest.NewServerTxRecorder(invite)
	h.registrar.HandleUnsupported(invite, tx)
	res = lastResponse(t, tx)
	if res.StatusCode != 501 {
		t.Errorf("INVITE = %d, want 501 Not Implemented", res.StatusCode)
	}
}

func (h *harness) parseRequest(raw string) *sip.Request {
	h.t.Helper()
	message, err := h.parser.ParseSIP([]byte(raw))
	if err != nil {
		h.t.Fatalf("parsing: %v", err)
	}
	req := message.(*sip.Request)
	req.SetTransport("UDP")
	req.SetSource("203.0.113.9:5060")
	return req
}

func lastResponse(t *testing.T, tx *siptest.ServerTxRecorder) *sip.Response {
	t.Helper()
	results := tx.Result()
	if len(results) == 0 {
		t.Fatal("no response was produced")
	}
	return results[len(results)-1]
}

func TestNewRejectsInconsistentOptions(t *testing.T) {
	authenticator, err := registrar.NewAuthenticator("other.example.com", []byte("secret"), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	_, err = registrar.New(registrar.Options{
		Realm:       testRealm,
		Auth:        authenticator,
		Expiry:      registrar.ExpiryPolicy{Min: time.Minute, Max: time.Hour, Default: 5 * time.Minute},
		Credentials: staticCredentials{},
		Bindings:    kv.NewMemoryStore(),
		Publisher:   events.NewRecordingPublisher(),
	})
	if err == nil {
		t.Fatal("a registrar whose authenticator challenges for a different realm must not build")
	}
	if !strings.Contains(err.Error(), "challenges for") {
		t.Errorf("error = %v, want it to name the realm mismatch", err)
	}
}
