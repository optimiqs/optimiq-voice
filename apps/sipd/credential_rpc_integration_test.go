//go:build integration

package sipd_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
)

// The provisioning → registration chain, end to end.
//
//	apps/api renders a phone's config with a password it DERIVED
//	    ↓ (the phone is configured, out of band)
//	the phone answers a digest challenge computed from that password
//	    ↓ REGISTER over a real UDP socket
//	sipd asks rpc.sip.v1.credential over a real NATS server
//	    ↓
//	the responder derives the same password, hashes it into an HA1, replies
//	    ↓
//	sipd verifies the digest and writes a binding
//
// The password the client authenticates with is NOT computed by this test. It is read from
// internal/credentials/testdata/derive_parity.json, which is emitted by the TypeScript
// implementation in apps/api. So a Go-side regression cannot be hidden by a Go-side expectation:
// the byte the phone would really have been given is the byte this test sends.
//
// # What is faked, and what that costs
//
// The RESPONDER is in-process: a NATS subscriber that runs the Go derivation and answers the
// contract shape. Booting apps/api instead would need PostgreSQL, a provisioned tenant, an
// org_setting realm mapping and a device row — a fixture an order of magnitude larger than the
// thing under test, and one that would make this suite fail for reasons that have nothing to do
// with SIP.
//
// Stated plainly, therefore: this proves the WIRE and the DERIVATION — subject, JSON shape,
// timeout, cache, digest verification, and that a TypeScript-derived password authenticates
// against a Go-derived HA1. It does NOT prove apps/api's SQL resolves the right secretRef. That
// half is covered by `pnpm --filter @optimiq-voice/api verify:provisioning` and by the service's
// own unit tests, and the seam between them — that both sides speak the same contract types — is
// held by codegen rather than by either test.

// credentialResponder answers rpc.sip.v1.credential in-process.
type credentialResponder struct {
	rootKey  string
	accounts map[string]responderAccount
	requests atomic.Int64
	sub      *nats.Subscription
}

type responderAccount struct {
	orgID     string
	secretRef string
	enabled   bool
}

func startCredentialResponder(t *testing.T, conn *nats.Conn, rootKey string, accounts map[string]responderAccount) *credentialResponder {
	t.Helper()

	responder := &credentialResponder{rootKey: rootKey, accounts: accounts}

	sub, err := conn.Subscribe(contract.SubjectSipCredentialRPC, func(msg *nats.Msg) {
		responder.requests.Add(1)

		var request contract.SipCredentialRequest
		if err := json.Unmarshal(msg.Data, &request); err != nil {
			_ = msg.Respond(mustJSON(t, contract.SipCredentialResponse{Found: false}))
			return
		}

		account, known := accounts[strings.ToLower(request.Realm)+"/"+request.Username]
		if !known {
			_ = msg.Respond(mustJSON(t, contract.SipCredentialResponse{Found: false}))
			return
		}
		if !account.enabled {
			_ = msg.Respond(mustJSON(t, contract.SipCredentialResponse{Found: true, Enabled: false}))
			return
		}

		// Exactly what apps/api's SipCredentialsService does: derive the password from
		// (orgId, secretRef), then hash it with the username and the realm.
		ha1, err := credentials.DeriveHA1(rootKey, account.orgID, account.secretRef, request.Username, request.Realm)
		if err != nil {
			t.Errorf("responder could not derive: %v", err)
			_ = msg.Respond(mustJSON(t, contract.SipCredentialResponse{Found: false}))
			return
		}

		orgID, username, realm := account.orgID, request.Username, request.Realm
		_ = msg.Respond(mustJSON(t, contract.SipCredentialResponse{
			Found: true, Enabled: true,
			OrgID: &orgID, Username: &username, Realm: &realm, Ha1: &ha1,
		}))
	})
	if err != nil {
		t.Fatalf("subscribing to %s: %v", contract.SubjectSipCredentialRPC, err)
	}
	if err := conn.Flush(); err != nil {
		t.Fatalf("flushing the subscription: %v", err)
	}

	responder.sub = sub
	t.Cleanup(func() { _ = sub.Unsubscribe() })
	return responder
}

// parityVectorForTest mirrors one entry of internal/credentials/testdata/derive_parity.json.
// Declared here rather than shared with the credentials package's own test because that one is an
// in-package test file and exporting the type just to reach it would widen the package's API for
// a test's convenience.
type parityVectorForTest struct {
	Name           string `json:"name"`
	RootKey        string `json:"rootKey"`
	OrganizationID string `json:"organizationId"`
	SecretRef      string `json:"secretRef"`
	Username       string `json:"username"`
	Realm          string `json:"realm"`
	Password       string `json:"password"`
	HA1            string `json:"ha1"`
}

func loadDeriveParity(t *testing.T) []parityVectorForTest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("internal", "credentials", "testdata", "derive_parity.json"))
	if err != nil {
		t.Fatalf("reading the derivation golden: %v "+
			"(regenerate with: pnpm --filter @optimiq-voice/api emit:sip-vectors)", err)
	}
	var document struct {
		Vectors []parityVectorForTest `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parsing the derivation golden: %v", err)
	}
	return document.Vectors
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding a reply: %v", err)
	}
	return raw
}

// theOrdinaryVector is the golden case whose realm and username already match this suite's
// constants, so the fixture and the wire agree without translation.
func theOrdinaryVector(t *testing.T) parityVectorForTest {
	t.Helper()
	for _, vector := range loadDeriveParity(t) {
		if vector.Name == "ordinary" {
			if vector.Realm != itRealm || vector.Username != itUser {
				t.Fatalf("the golden's ordinary vector is %s/%s, this suite is %s/%s",
					vector.Realm, vector.Username, itRealm, itUser)
			}
			return vector
		}
	}
	t.Fatal(`the golden has no "ordinary" vector`)
	return parityVectorForTest{}
}

func TestRegisterAuthenticatesAgainstACredentialDerivedByTheAPI(t *testing.T) {
	requireIntegration(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	url := startNATS(t)
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	defer conn.Close()

	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream.New: %v", err)
	}
	ensureRegistrationsStream(t, ctx, js)

	vector := theOrdinaryVector(t)

	responder := startCredentialResponder(t, conn, vector.RootKey, map[string]responderAccount{
		strings.ToLower(itRealm) + "/" + itUser: {
			orgID:     vector.OrganizationID,
			secretRef: vector.SecretRef,
			enabled:   true,
		},
		strings.ToLower(itRealm) + "/1099": {
			orgID:     vector.OrganizationID,
			secretRef: "ext/1099/sip",
			enabled:   false,
		},
	})

	store, err := credentials.NewNATSStore(conn, credentials.NATSOptions{
		// The contract's own deadline, unmodified: if 500 ms is not enough against a container on
		// the same host, the number in the contract is wrong and this suite should say so.
		Timeout: contract.TimeoutSipCredentialRPC,
		// Short enough that the cache assertions below do not need a sleep, long enough that the
		// second REGISTER of a pair is genuinely served from it.
		PositiveTTL: 5 * time.Second,
		NegativeTTL: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewNATSStore: %v", err)
	}

	edge := startEdgeWithStore(t, ctx, js, store)
	client := dialSIP(t, edge.addr)

	// --- the provisioned phone registers ------------------------------------------------------

	challenge := client.register("", ";expires=30")
	if challenge.StatusCode != 401 {
		t.Fatalf("first REGISTER = %d %s, want 401", challenge.StatusCode, challenge.Reason)
	}

	// vector.Password came out of the TypeScript renderer. Nothing in Go computed it.
	answer := client.authenticateAs(challenge, itUser, vector.Password)
	accepted := client.register(answer, ";expires=30")
	if accepted.StatusCode != 200 {
		t.Fatalf("REGISTER with the API-derived password = %d %s, want 200",
			accepted.StatusCode, accepted.Reason)
	}

	if got := responder.requests.Load(); got != 1 {
		t.Errorf("the responder was asked %d times for one REGISTER, want 1", got)
	}

	binding, found, err := edge.bindings.Get(ctx, vector.OrganizationID, edge.aorHash)
	if err != nil || !found {
		t.Fatalf("the accepted REGISTER wrote no binding: found=%v err=%v", found, err)
	}
	if binding.OrgID != vector.OrganizationID {
		t.Errorf("binding orgId = %q, want the tenant the responder named (%q) — the tenant on a "+
			"binding must come from the credential, never from the wire",
			binding.OrgID, vector.OrganizationID)
	}

	// --- the second REGISTER is served from the cache -----------------------------------------

	second := client.register(client.authenticateAs(client.register("", ";expires=30"), itUser, vector.Password), ";expires=30")
	if second.StatusCode != 200 {
		t.Fatalf("the re-REGISTER = %d %s, want 200", second.StatusCode, second.Reason)
	}
	if got := responder.requests.Load(); got != 1 {
		t.Errorf("the responder was asked %d times across two REGISTERs; the positive cache is not "+
			"working, and a thousand phones would be a thousand round trips per expiry cycle", got)
	}

	// --- a wrong password is refused ----------------------------------------------------------

	wrong := client.register(
		client.authenticateAs(client.register("", ";expires=30"), itUser, "not-the-derived-password"),
		";expires=30")
	if wrong.StatusCode != 403 {
		t.Fatalf("REGISTER with a wrong password = %d %s, want 403", wrong.StatusCode, wrong.Reason)
	}

	// --- an unknown account is refused indistinguishably --------------------------------------

	// Same status, and the reason phrase must not differ either: a caller that can tell "no such
	// user" from "wrong password" has an extension enumerator.
	unknownClient := dialSIPAs(t, edge.addr, "1098")
	unknownChallenge := unknownClient.register("", ";expires=30")
	if unknownChallenge.StatusCode != 401 {
		t.Fatalf("unknown-user REGISTER = %d, want a 401 challenge first", unknownChallenge.StatusCode)
	}
	unknown := unknownClient.register(
		unknownClient.authenticateAs(unknownChallenge, "1098", vector.Password), ";expires=30")
	if unknown.StatusCode != 403 {
		t.Fatalf("REGISTER for an unknown account = %d %s, want 403", unknown.StatusCode, unknown.Reason)
	}
	if unknown.Reason != wrong.Reason {
		t.Errorf("an unknown account answers %q and a wrong password answers %q; the difference is "+
			"an enumeration oracle", unknown.Reason, wrong.Reason)
	}

	// --- a disabled account is refused the same way -------------------------------------------

	disabledClient := dialSIPAs(t, edge.addr, "1099")
	disabledChallenge := disabledClient.register("", ";expires=30")
	disabled := disabledClient.register(
		disabledClient.authenticateAs(disabledChallenge, "1099", vector.Password), ";expires=30")
	if disabled.StatusCode != 403 {
		t.Fatalf("REGISTER for a disabled account = %d %s, want 403", disabled.StatusCode, disabled.Reason)
	}
	if disabled.Reason != wrong.Reason {
		t.Errorf("a disabled account answers %q and a wrong password answers %q; "+
			"`found` and `enabled` are distinct on the RPC and must be merged at SIP",
			disabled.Reason, wrong.Reason)
	}
}

func TestRegisterFailsClosedWhenNobodyAnswersTheCredentialRPC(t *testing.T) {
	requireIntegration(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	url := startNATS(t)
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	defer conn.Close()

	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream.New: %v", err)
	}
	ensureRegistrationsStream(t, ctx, js)

	// The broker is up and the subject has NO responder. This is the state during an apps/api
	// deploy, and it is the one where "fail open" would be catastrophic and tempting.
	vector := theOrdinaryVector(t)

	store, err := credentials.NewNATSStore(conn, credentials.NATSOptions{Timeout: 300 * time.Millisecond})
	if err != nil {
		t.Fatalf("NewNATSStore: %v", err)
	}

	edge := startEdgeWithStore(t, ctx, js, store)
	client := dialSIP(t, edge.addr)

	challenge := client.register("", ";expires=30")
	if challenge.StatusCode != 401 {
		t.Fatalf("first REGISTER = %d, want 401", challenge.StatusCode)
	}

	refused := client.register(client.authenticateAs(challenge, itUser, vector.Password), ";expires=30")
	if refused.StatusCode != 403 {
		t.Fatalf("REGISTER with no credential responder = %d %s, want 403 — an edge that cannot "+
			"check a password must not accept one", refused.StatusCode, refused.Reason)
	}

	if _, found, err := edge.bindings.Get(ctx, vector.OrganizationID, edge.aorHash); err != nil || found {
		t.Errorf("a refused REGISTER wrote a binding: found=%v err=%v", found, err)
	}

	// And the failure is not cached: the moment a responder appears, the same phone registers.
	startCredentialResponder(t, conn, vector.RootKey, map[string]responderAccount{
		strings.ToLower(itRealm) + "/" + itUser: {
			orgID: vector.OrganizationID, secretRef: vector.SecretRef, enabled: true,
		},
	})

	recovered := client.register(
		client.authenticateAs(client.register("", ";expires=30"), itUser, vector.Password), ";expires=30")
	if recovered.StatusCode != 200 {
		t.Fatalf("REGISTER after the responder came back = %d %s, want 200 — a transport failure "+
			"must not be cached, or an outage would outlive its cause",
			recovered.StatusCode, recovered.Reason)
	}
}
