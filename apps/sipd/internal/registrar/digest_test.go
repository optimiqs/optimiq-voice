package registrar_test

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// gate is the shared pipeline plus enough scaffolding to drive it as any of the four methods.
type gate struct {
	t       *testing.T
	auth    *registrar.Authenticator
	gate    *registrar.DigestGate
	lockout *registrar.Lockout
	store   *scriptedCredentials
	cseq    int
}

// scriptedCredentials answers whatever the test last set, and counts refreshes so the
// stale-credential path can be asserted rather than inferred.
type scriptedCredentials struct {
	accounts map[string]credentials.Credential
	err      error

	lookups  atomic.Int64
	refreshs atomic.Int64
	// refreshed replaces the answer once Refresh is called, which is a rotation seen from here.
	refreshed map[string]credentials.Credential
}

func (s *scriptedCredentials) Lookup(_ context.Context, realm, username string) (credentials.Credential, error) {
	s.lookups.Add(1)
	if s.err != nil {
		return credentials.Credential{}, s.err
	}
	credential, found := s.accounts[realm+"/"+username]
	if !found {
		return credentials.Credential{}, credentials.ErrNotFound
	}
	return credential, nil
}

func (s *scriptedCredentials) Refresh(_ context.Context, realm, username string) (credentials.Credential, error) {
	s.refreshs.Add(1)
	credential, found := s.refreshed[realm+"/"+username]
	if !found {
		return credentials.Credential{}, credentials.ErrNotFound
	}
	s.accounts[realm+"/"+username] = credential
	return credential, nil
}

func newGate(t *testing.T, policy registrar.LockoutPolicy) *gate {
	t.Helper()
	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("digest-gate-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	store := &scriptedCredentials{
		accounts: map[string]credentials.Credential{
			testRealm + "/" + testUser: {
				OrgID: testOrg, Username: testUser, Realm: testRealm,
				HA1: credentials.HA1(testUser, testRealm, testPass),
			},
		},
		refreshed: map[string]credentials.Credential{},
	}
	lockout := registrar.NewLockout(policy, newClock().now)
	return &gate{
		t: t, auth: authenticator, store: store, lockout: lockout,
		gate: registrar.NewDigestGate(authenticator, store, lockout),
	}
}

// request builds a request for `method` from `source`, answering the gate's own challenge with
// `password`. An empty password sends no Authorization at all.
func (g *gate) request(method, source, username, password string) *sip.Request {
	g.t.Helper()
	g.cseq++

	challenge, err := g.auth.Challenge(false)
	if err != nil {
		g.t.Fatalf("Challenge: %v", err)
	}
	parsed, err := digest.ParseChallenge(challenge)
	if err != nil {
		g.t.Fatalf("ParseChallenge: %v", err)
	}
	uri := "sip:" + testRealm
	authorization := ""
	if password != "" {
		answer, err := digest.Digest(parsed, digest.Options{
			Method: method, URI: uri, Username: username, Password: password, Count: 1, Cnonce: "0a4f113b",
		})
		if err != nil {
			g.t.Fatalf("Digest: %v", err)
		}
		authorization = answer.String()
	}

	lines := []string{
		method + " " + uri + " SIP/2.0",
		"Via: SIP/2.0/UDP " + source + ";branch=z9hG4bK" + strconv.Itoa(g.cseq),
		"Max-Forwards: 70",
		"From: <sip:" + username + "@" + testRealm + ">;tag=fromtag",
		"To: <sip:" + username + "@" + testRealm + ">",
		"Call-ID: digest-gate-" + strconv.Itoa(g.cseq),
		"CSeq: " + strconv.Itoa(g.cseq) + " " + method,
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")

	message, err := sip.NewParser().ParseSIP([]byte(strings.Join(lines, "\r\n")))
	if err != nil {
		g.t.Fatalf("parsing the request: %v", err)
	}
	req := message.(*sip.Request)
	req.SetTransport("udp")
	req.SetSource(source)
	return req
}

func (g *gate) run(method, source, username, password string) registrar.DigestResult {
	g.t.Helper()
	return g.gate.Authenticate(g.t.Context(), g.request(method, source, username, password), username, "")
}

// The four methods must reach the same decision for the same wrong password. Before the shared
// pipeline, SUBSCRIBE and out-of-dialog REFER ran no throttle at all.
func TestEveryMethodRefusesAWrongPasswordIdentically(t *testing.T) {
	for _, method := range []string{"REGISTER", "INVITE", "SUBSCRIBE", "REFER"} {
		t.Run(method, func(t *testing.T) {
			g := newGate(t, testPolicy())
			result := g.run(method, "203.0.113.9:5060", testUser, "not-the-password")
			if result.Outcome != registrar.DigestBadPassword {
				t.Fatalf("outcome = %v, want DigestBadPassword", result.Outcome)
			}
			if result.OrgID != testOrg {
				t.Errorf("OrgID = %q, want the account's org so the failure is attributable", result.OrgID)
			}
			if !result.Outcome.Refusable() {
				t.Error("a wrong password must be answered like every other refusal")
			}
		})
	}
}

// The whole point of one pipeline: a spray that alternates methods must share one budget.
func TestASprayAcrossMethodsSharesOneThrottleBudget(t *testing.T) {
	policy := testPolicy()
	g := newGate(t, policy)

	for _, method := range []string{"REGISTER", "INVITE", "SUBSCRIBE"} {
		if result := g.run(method, "203.0.113.9:5060", testUser, "wrong"); result.Outcome != registrar.DigestBadPassword {
			t.Fatalf("%s outcome = %v, want DigestBadPassword", method, result.Outcome)
		}
	}
	// Three failures is the test policy's threshold, so the fourth attempt — on the fourth method —
	// must be refused without reaching the directory at all.
	before := g.store.lookups.Load()
	result := g.run("REFER", "203.0.113.9:5060", testUser, testPass)
	if result.Outcome != registrar.DigestThrottled {
		t.Fatalf("outcome = %v, want DigestThrottled after the shared budget ran out", result.Outcome)
	}
	if g.store.lookups.Load() != before {
		t.Error("a throttled request still cost a credential lookup")
	}
	if result.Refusal.RetryAfter <= 0 {
		t.Error("the refusal carried no retry interval")
	}
}

// A UDP phone picks a new source port on every NAT rebind; so does an attacker. Counters keyed on
// host:port split on that churn and hand out a fresh budget per port.
func TestSourcePortChurnDoesNotSplitTheThrottleCounter(t *testing.T) {
	policy := testPolicy()
	g := newGate(t, policy)

	for port := range policy.Threshold {
		source := "203.0.113.9:" + strconv.Itoa(50000+port)
		if result := g.run("REGISTER", source, testUser, "wrong"); result.Outcome != registrar.DigestBadPassword {
			t.Fatalf("outcome = %v, want DigestBadPassword", result.Outcome)
		}
	}
	if result := g.run("REGISTER", "203.0.113.9:60000", testUser, testPass); result.Outcome != registrar.DigestThrottled {
		t.Fatalf("outcome = %v, want DigestThrottled: changing source port must not buy a new budget", result.Outcome)
	}
}

// Two tenants may both have an extension 1001. One tenant's failures must not lock out the other's.
func TestTheSameUsernameInTwoRealmsHasSeparateCounters(t *testing.T) {
	policy := testPolicy()
	g := newGate(t, policy)

	other := "other.example.test"
	g.store.accounts[other+"/"+testUser] = credentials.Credential{
		OrgID: "other-org", Username: testUser, Realm: other,
		HA1: credentials.HA1(testUser, other, testPass),
	}

	for range policy.Threshold {
		if result := g.run("REGISTER", "203.0.113.9:5060", testUser, "wrong"); result.Outcome != registrar.DigestBadPassword {
			t.Fatalf("outcome = %v", result.Outcome)
		}
	}
	// The gate's authenticator serves one realm per process, so the second realm's counter is
	// exercised through the Lockout directly — the key the gate builds is realm-scoped.
	if _, locked := g.lockout.Locked("203.0.113.9", other+"/"+testUser); locked {
		t.Error("failures against one realm's 1001 locked another realm's 1001")
	}
	if _, locked := g.lockout.Locked("203.0.113.9", testRealm+"/"+testUser); !locked {
		t.Error("the realm-scoped counter did not lock the account that was actually guessed at")
	}
}

// A rotated SIP secret is invisible here — the credential RPC is pull-only — so a digest that does
// not verify is the only signal the cached HA1 may be the previous one. Every method needs it, not
// only REGISTER.
func TestAStaleCredentialIsRefreshedForEveryMethod(t *testing.T) {
	for _, method := range []string{"REGISTER", "INVITE", "SUBSCRIBE", "REFER"} {
		t.Run(method, func(t *testing.T) {
			g := newGate(t, testPolicy())
			const rotated = "the-new-password"
			g.store.refreshed[testRealm+"/"+testUser] = credentials.Credential{
				OrgID: testOrg, Username: testUser, Realm: testRealm,
				HA1: credentials.HA1(testUser, testRealm, rotated),
			}

			result := g.run(method, "203.0.113.9:5060", testUser, rotated)
			if result.Outcome != registrar.DigestAccepted {
				t.Fatalf("outcome = %v, want DigestAccepted against the re-fetched credential", result.Outcome)
			}
			if g.store.refreshs.Load() != 1 {
				t.Errorf("refreshes = %d, want exactly one", g.store.refreshs.Load())
			}
			if _, locked := g.lockout.Locked("203.0.113.9", testRealm+"/"+testUser); locked {
				t.Error("an accepted refresh still counted as a failure")
			}
		})
	}
}

func TestTheGateClassifiesTheDirectorysAnswers(t *testing.T) {
	t.Run("a disabled account is refused, not challenged", func(t *testing.T) {
		g := newGate(t, testPolicy())
		g.store.err = credentials.ErrDisabled
		if result := g.run("INVITE", "203.0.113.9:5060", testUser, testPass); result.Outcome != registrar.DigestDisabled {
			t.Fatalf("outcome = %v, want DigestDisabled", result.Outcome)
		}
	})

	t.Run("an unknown account still counts against the spray cap", func(t *testing.T) {
		g := newGate(t, testPolicy())
		result := g.run("REGISTER", "203.0.113.9:5060", "9999", testPass)
		if result.Outcome != registrar.DigestUnknownAccount {
			t.Fatalf("outcome = %v, want DigestUnknownAccount", result.Outcome)
		}
		if stats := g.lockout.Stats(); stats.Failures != 1 {
			t.Errorf("failures = %d, want a walk through extension numbers to count", stats.Failures)
		}
	})

	t.Run("a store that cannot answer is not a claim about the account", func(t *testing.T) {
		g := newGate(t, testPolicy())
		g.store.err = errors.New("the credential RPC timed out")
		result := g.run("REGISTER", "203.0.113.9:5060", testUser, testPass)
		if result.Outcome != registrar.DigestBackendUnavailable {
			t.Fatalf("outcome = %v, want DigestBackendUnavailable so the answer is a retriable 503", result.Outcome)
		}
		if stats := g.lockout.Stats(); stats.Failures != 0 {
			t.Error("a backend failure was counted against the account")
		}
	})

	t.Run("no credentials at all is a challenge", func(t *testing.T) {
		g := newGate(t, testPolicy())
		if result := g.run("SUBSCRIBE", "203.0.113.9:5060", testUser, ""); result.Outcome != registrar.DigestChallenge {
			t.Fatalf("outcome = %v, want DigestChallenge", result.Outcome)
		}
	})

	t.Run("a credential for somebody else is refused without a challenge", func(t *testing.T) {
		g := newGate(t, testPolicy())
		req := g.request("REFER", "203.0.113.9:5060", testUser, testPass)
		result := g.gate.Authenticate(t.Context(), req, "somebody-else", "")
		if result.Outcome != registrar.DigestWrongIdentity {
			t.Fatalf("outcome = %v, want DigestWrongIdentity", result.Outcome)
		}
		if g.store.lookups.Load() != 0 {
			t.Error("an identity mismatch reached the directory")
		}
	})
}
