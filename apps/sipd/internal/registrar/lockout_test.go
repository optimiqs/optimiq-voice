package registrar_test

import (
	"context"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

const (
	lockoutSource  = "203.0.113.9:5060"
	lockoutAccount = "1001"
)

func testPolicy() registrar.LockoutPolicy {
	return registrar.LockoutPolicy{
		Threshold:       3,
		SourceThreshold: 10,
		Base:            30 * time.Second,
		Max:             2 * time.Minute,
		Window:          10 * time.Minute,
		MaxTracked:      64,
	}
}

// clock is a hand-wound time source, so a lockout window is asserted rather than slept through.
type clock struct {
	mu sync.Mutex
	at time.Time
}

func newClock() *clock {
	return &clock{at: time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)}
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.at = c.at.Add(d)
	c.mu.Unlock()
}

func TestALockoutOpensOnlyAtTheThreshold(t *testing.T) {
	c := newClock()
	lock := registrar.NewLockout(testPolicy(), c.now)

	for i := range 2 {
		lock.Fail(lockoutSource, lockoutAccount, "org", "sip:1001@example.test")
		if _, locked := lock.Locked(lockoutSource, lockoutAccount); locked {
			t.Fatalf("locked after %d failures, want 3", i+1)
		}
	}
	lock.Fail(lockoutSource, lockoutAccount, "org", "sip:1001@example.test")
	refusal, locked := lock.Locked(lockoutSource, lockoutAccount)
	if !locked {
		t.Fatal("not locked after the third failure")
	}
	if refusal.RetryAfter != 30*time.Second {
		t.Fatalf("retryAfter = %s, want 30s", refusal.RetryAfter)
	}
	if refusal.OrgID != "org" || refusal.AOR != "sip:1001@example.test" {
		// Carried so a refusal served without a credential lookup is still attributable.
		t.Fatalf("refusal lost the account identity: %+v", refusal)
	}
}

func TestALockoutBacksOffExponentiallyUpToTheCeiling(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	lock := registrar.NewLockout(policy, c.now)

	for _, want := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 2 * time.Minute} {
		for range policy.Threshold {
			lock.Fail(lockoutSource, lockoutAccount, "", "")
		}
		refusal, locked := lock.Locked(lockoutSource, lockoutAccount)
		if !locked || refusal.RetryAfter != want {
			t.Fatalf("lockout = %s (locked=%v), want %s", refusal.RetryAfter, locked, want)
		}
		c.advance(want)
	}
}

// A spray that ignores the 403 must not hold itself locked out for ever: an honest phone behind the
// same NAT would read that as a permanent outage.
func TestFailuresDuringALockoutDoNotExtendIt(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	lock := registrar.NewLockout(policy, c.now)

	for range policy.Threshold {
		lock.Fail(lockoutSource, lockoutAccount, "", "")
	}
	for range 100 {
		lock.Fail(lockoutSource, lockoutAccount, "", "")
	}
	c.advance(30 * time.Second)
	if _, locked := lock.Locked(lockoutSource, lockoutAccount); locked {
		t.Fatal("the lockout outlived its own window")
	}
}

func TestTheSourceCapCatchesASprayAcrossManyAccounts(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	lock := registrar.NewLockout(policy, c.now)

	// One failure per account, so no account counter ever reaches its own threshold of 3.
	for account := range policy.SourceThreshold {
		lock.Fail(lockoutSource, string(rune('a'+account)), "", "")
	}
	refusal, locked := lock.Locked(lockoutSource, "never-guessed")
	if !locked {
		t.Fatal("a spray spread across accounts never tripped the source cap")
	}
	if !refusal.Source {
		t.Fatal("the refusal did not name the source counter")
	}
}

func TestASuccessClearsTheAccountButNotTheSource(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	lock := registrar.NewLockout(policy, c.now)

	lock.Fail(lockoutSource, lockoutAccount, "", "")
	lock.Fail(lockoutSource, lockoutAccount, "", "")
	lock.Succeed(lockoutSource, lockoutAccount)
	lock.Fail(lockoutSource, lockoutAccount, "", "")
	if _, locked := lock.Locked(lockoutSource, lockoutAccount); locked {
		t.Fatal("a success did not clear the account counter")
	}
	// An attacker holding one valid account behind the address must not be able to clear the
	// distributed-spray cap by registering it.
	for range policy.SourceThreshold - 3 {
		lock.Fail(lockoutSource, "other", "", "")
	}
	if _, locked := lock.Locked(lockoutSource, "other"); !locked {
		t.Fatal("the success reset the source counter")
	}
}

func TestACounterIsForgottenAfterAnIdleWindow(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	lock := registrar.NewLockout(policy, c.now)

	lock.Fail(lockoutSource, lockoutAccount, "", "")
	lock.Fail(lockoutSource, lockoutAccount, "", "")
	c.advance(policy.Window)
	lock.Fail(lockoutSource, lockoutAccount, "", "")
	if _, locked := lock.Locked(lockoutSource, lockoutAccount); locked {
		t.Fatal("failures from before the idle window still counted")
	}
}

// The key space belongs to the attacker — source ports are theirs to choose — so the table's
// ceiling has to be one they cannot move.
func TestTheLockoutTableStaysBounded(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	lock := registrar.NewLockout(policy, c.now)

	for i := range 10_000 {
		lock.Fail("198.51.100.7:"+string(rune('0'+i%10))+string(rune('0'+i/10%10))+
			string(rune('0'+i/100%10))+string(rune('0'+i/1000%10)), lockoutAccount, "", "")
	}
	if stats := lock.Stats(); stats.Failures != 10_000 {
		t.Fatalf("failures = %d, want 10000", stats.Failures)
	}
}

func TestALockoutIsSafeUnderConcurrentUse(t *testing.T) {
	c := newClock()
	lock := registrar.NewLockout(testPolicy(), c.now)

	var wg sync.WaitGroup
	for worker := range 8 {
		wg.Go(func() {
			for i := range 500 {
				account := string(rune('a' + (worker+i)%16))
				lock.Fail(lockoutSource, account, "", "")
				lock.Locked(lockoutSource, account)
				if i%50 == 0 {
					lock.Succeed(lockoutSource, account)
				}
			}
		})
	}
	wg.Wait()
	if stats := lock.Stats(); stats.Failures != 4000 {
		t.Fatalf("failures = %d, want 4000", stats.Failures)
	}
}

func TestAZeroThresholdDisablesTheLockout(t *testing.T) {
	policy := testPolicy()
	policy.Threshold = 0
	lock := registrar.NewLockout(policy, nil)
	if lock != nil {
		t.Fatal("a zero threshold built a lockout")
	}
	// Every method is nil-safe so a disabled deployment needs no branch at the call sites.
	lock.Fail(lockoutSource, lockoutAccount, "", "")
	lock.Succeed(lockoutSource, lockoutAccount)
	if _, locked := lock.Locked(lockoutSource, lockoutAccount); locked {
		t.Fatal("a disabled lockout locked somebody out")
	}
}

// countingCredentials is the credential RPC, counted. The whole point of the lockout is that a
// spray stops reaching it.
type countingCredentials struct {
	credential credentials.Credential
	lookups    atomic.Int64
}

func (c *countingCredentials) Lookup(_ context.Context, _, _ string) (credentials.Credential, error) {
	c.lookups.Add(1)
	return c.credential, nil
}

func withLockout(lock *registrar.Lockout) harnessOption {
	return func(opts *registrar.Options) { opts.Lockout = lock }
}

// withClock puts the registrar on the same hand-wound clock as the lockout, so the audit rate limit
// and the cooling window advance together.
func withClock(c *clock) harnessOption {
	return func(opts *registrar.Options) { opts.Now = c.now }
}

// answerChallengeWith answers a challenge with an arbitrary password, which is what a spray does.
func (h *harness) answerChallengeWith(res *sip.Response, password string, count int) string {
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
		Password: password,
		Count:    count,
		Cnonce:   "0a4f113b",
	})
	if err != nil {
		h.t.Fatalf("computing the digest answer: %v", err)
	}
	return answer.String()
}

// The P0 this whole mechanism exists for: a thousand wrong passwords must not buy a thousand
// credential lookups. This is the load rig's scenario at unit scale — same shape, no broker.
func TestASprayOfAThousandWrongPasswordsCostsAHandfulOfLookups(t *testing.T) {
	c := newClock()
	policy := testPolicy()
	// Longer than AuthFailureInterval, so the spray can be observed to still be locked out at the
	// moment the audit limiter admits a second row.
	policy.Base, policy.Max = 5*time.Minute, 10*time.Minute
	lock := registrar.NewLockout(policy, c.now)
	store := &countingCredentials{credential: credentials.Credential{
		OrgID:    testOrg,
		Username: testUser,
		Realm:    testRealm,
		HA1:      credentials.HA1(testUser, testRealm, testPass),
	}}
	h := newHarness(t, store, withLockout(lock), withClock(c))

	for attempt := range 1000 {
		challenge := h.send(h.newRegister("", contactHeader("sip:1001@203.0.113.9:5060")))
		if challenge.StatusCode != 401 {
			t.Fatalf("attempt %d: status = %d, want a challenge", attempt, challenge.StatusCode)
		}
		authorization := h.answerChallengeWith(challenge, "wrong-"+strconv.Itoa(attempt), attempt+1)
		res := h.send(h.newRegister(authorization, contactHeader("sip:1001@203.0.113.9:5060")))
		if res.StatusCode != 403 {
			t.Fatalf("attempt %d: status = %d, want 403", attempt, res.StatusCode)
		}
		// Identical to the answer an unknown account gets: no enumeration difference.
		if res.GetHeader("WWW-Authenticate") != nil {
			t.Fatalf("attempt %d: a refused password was re-challenged", attempt)
		}
	}

	if lookups := store.lookups.Load(); lookups > 6 {
		t.Fatalf("a 1000-attempt spray cost %d credential lookups, want at most 6", lookups)
	}
	stats := lock.Stats()
	if stats.Lockouts == 0 || stats.Refused == 0 {
		t.Fatalf("the spray never tripped the lockout: %+v", stats)
	}

	// One more attempt past the audit limiter's minute, still inside the cooling window.
	c.advance(registrar.AuthFailureInterval + time.Second)
	challenge := h.send(h.newRegister("", contactHeader("sip:1001@203.0.113.9:5060")))
	if res := h.send(h.newRegister(h.answerChallengeWith(challenge, "wrong-again", 1),
		contactHeader("sip:1001@203.0.113.9:5060"))); res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}

	// The refusal is reported, once per window, and says it was served from the table.
	events := h.publisher.AuthFailedEvents()
	if len(events) == 0 {
		t.Fatal("a 1000-attempt spray published no auth-failed event")
	}
	marked := false
	for _, event := range events {
		if event.Data.Locked != nil && *event.Data.Locked {
			marked = true
		}
	}
	if !marked {
		t.Fatal("no auth-failed event carried the locked marker")
	}

	// Past the window the legitimate phone registers again — the lockout is a cooling period and
	// not a ban.
	c.advance(policy.Max + time.Second)
	if res := h.register(contactHeader("sip:1001@203.0.113.9:5060")); res.StatusCode != 200 {
		t.Fatalf("the honest phone was still refused after the window: %d", res.StatusCode)
	}
}
