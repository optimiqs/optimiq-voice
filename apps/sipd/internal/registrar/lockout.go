package registrar

import (
	"sync"
	"sync/atomic"
	"time"
)

// LockoutPolicy bounds how fast one address may guess a password.
//
// The rate limiter in authfailure.go bounds the audit ROW; this bounds the ATTEMPT. Without it a
// credential spray costs one credential RPC and one MD5 per packet, which is a denial of service
// against the credential responder before it is a password problem.
type LockoutPolicy struct {
	// Threshold is how many failures against one (source, account) pair open the first lockout.
	Threshold int
	// SourceThreshold is the same count summed over every account one source has guessed at, so a
	// spray spread thin across a thousand extensions still trips. Zero disables the source cap.
	SourceThreshold int
	// Base is the first lockout, doubled on each subsequent one up to Max.
	Base time.Duration
	// Max is the ceiling on the doubling.
	Max time.Duration
	// Window is how long a counter survives with no further failures. A phone that fat-fingered its
	// password in the morning must not be one attempt from a lockout in the afternoon.
	Window time.Duration
	// MaxTracked bounds the two tables.
	MaxTracked int
}

// DefaultLockoutPolicy is the shipped policy: five wrong passwords buys thirty seconds, doubling to
// half an hour, and fifty failures from one address locks the address whatever it was guessing at.
//
// Five is above any plausible retry burst from a handset re-registering with a stale secret and far
// below what a dictionary needs.
func DefaultLockoutPolicy() LockoutPolicy {
	return LockoutPolicy{
		Threshold:       5,
		SourceThreshold: 50,
		Base:            30 * time.Second,
		Max:             30 * time.Minute,
		Window:          15 * time.Minute,
		MaxTracked:      20000,
	}
}

// LockoutStats is the counter set a metrics exporter reads. Monotonic since boot.
type LockoutStats struct {
	// Failures is every digest that did not verify.
	Failures uint64
	// Lockouts is how many times a key entered a cooling window.
	Lockouts uint64
	// Refused is how many requests were answered 403 without a credential lookup. The ratio of this
	// to Failures is what the whole mechanism buys.
	Refused uint64
}

// Lockout counts digest failures per (source, account) and per source, and refuses while cooling.
//
// Safe for concurrent use and shared by every handler that authenticates — a spray that alternated
// REGISTER and INVITE against two separate counters would get twice the budget.
type Lockout struct {
	policy LockoutPolicy
	now    func() time.Time

	failures atomic.Uint64
	lockouts atomic.Uint64
	refused  atomic.Uint64

	mu       sync.Mutex
	accounts map[string]*failureCount
	sources  map[string]*failureCount
}

// failureCount is one key's state. `orgID` and `aor` are remembered from the last failure that
// resolved an account, so a refusal served WITHOUT a credential lookup can still be reported on an
// org-scoped subject — see Registrar.publishAuthFailure.
type failureCount struct {
	failures int
	lockouts int
	until    time.Time
	seen     time.Time
	orgID    string
	aor      string
}

// NewLockout builds a Lockout. A non-positive Threshold returns nil, which every method accepts and
// treats as "no lockout", so a deployment can turn it off without a branch at each call site.
func NewLockout(policy LockoutPolicy, now func() time.Time) *Lockout {
	if policy.Threshold <= 0 {
		return nil
	}
	if policy.Base <= 0 {
		policy.Base = time.Second
	}
	if policy.Max < policy.Base {
		policy.Max = policy.Base
	}
	if policy.Window <= 0 {
		policy.Window = policy.Max
	}
	if policy.MaxTracked <= 0 {
		policy.MaxTracked = 20000
	}
	if now == nil {
		now = time.Now
	}
	return &Lockout{
		policy:   policy,
		now:      now,
		accounts: make(map[string]*failureCount),
		sources:  make(map[string]*failureCount),
	}
}

// Locked reports whether this (source, account) pair is cooling, and how long is left.
//
// Consulted BEFORE the credential lookup: that ordering is the point of the type. The org and AOR
// come back so the refusal can be reported without asking the directory who this account is.
func (l *Lockout) Locked(source, account string) (LockoutRefusal, bool) {
	if l == nil {
		return LockoutRefusal{}, false
	}
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	refusal, locked := LockoutRefusal{}, false
	if entry := l.accounts[accountKey(source, account)]; entry != nil && entry.until.After(now) {
		refusal = LockoutRefusal{RetryAfter: entry.until.Sub(now), OrgID: entry.orgID, AOR: entry.aor}
		locked = true
	}
	if entry := l.sources[source]; entry != nil && entry.until.After(now) {
		if remaining := entry.until.Sub(now); remaining > refusal.RetryAfter {
			refusal.RetryAfter = remaining
		}
		refusal.Source = true
		locked = true
	}
	if locked {
		l.refused.Add(1)
	}
	return refusal, locked
}

// LockoutRefusal describes a refusal served from the table rather than from a credential.
type LockoutRefusal struct {
	// RetryAfter is how long the longest applicable lockout still has to run.
	RetryAfter time.Duration
	// Source is true when the whole address is locked, not merely this account on it.
	Source bool
	// OrgID and AOR are what the last resolved failure on this account said, and are empty when the
	// lockout was tripped entirely by attempts against accounts that resolved to nothing.
	OrgID string
	AOR   string
}

// Fail records one digest that did not verify. orgID and aor may be empty when the account did not
// resolve; they are remembered when they do so a later refusal is still attributable.
func (l *Lockout) Fail(source, account, orgID, aor string) {
	if l == nil {
		return
	}
	now := l.now()
	l.failures.Add(1)

	l.mu.Lock()
	defer l.mu.Unlock()

	entry := l.entryLocked(l.accounts, accountKey(source, account), now)
	if orgID != "" {
		entry.orgID, entry.aor = orgID, aor
	}
	l.tripLocked(entry, l.policy.Threshold, now)

	if l.policy.SourceThreshold > 0 {
		l.tripLocked(l.entryLocked(l.sources, source, now), l.policy.SourceThreshold, now)
	}
}

// Succeed forgets an account's failures after a digest that verified.
//
// The SOURCE counter is deliberately left alone: an attacker holding one valid account behind the
// same address would otherwise clear the distributed-spray cap on every successful REGISTER.
func (l *Lockout) Succeed(source, account string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	delete(l.accounts, accountKey(source, account))
	l.mu.Unlock()
}

// Stats returns the counters. Cheap enough to serve from a scrape handler.
func (l *Lockout) Stats() LockoutStats {
	if l == nil {
		return LockoutStats{}
	}
	return LockoutStats{
		Failures: l.failures.Load(),
		Lockouts: l.lockouts.Load(),
		Refused:  l.refused.Load(),
	}
}

// entryLocked fetches or creates a counter, resetting one that has been idle for a whole Window.
func (l *Lockout) entryLocked(table map[string]*failureCount, key string, now time.Time) *failureCount {
	entry := table[key]
	if entry == nil {
		if len(table) >= l.policy.MaxTracked {
			l.sweepLocked(table, now)
		}
		entry = &failureCount{}
		table[key] = entry
	} else if now.Sub(entry.seen) >= l.policy.Window && !entry.until.After(now) {
		*entry = failureCount{orgID: entry.orgID, aor: entry.aor}
	}
	entry.seen = now
	return entry
}

// tripLocked counts one failure against a threshold and opens the next lockout when it is reached.
func (l *Lockout) tripLocked(entry *failureCount, threshold int, now time.Time) {
	if entry.until.After(now) {
		// Already cooling. The attempt still cost nothing, so it does not extend the window either:
		// otherwise a spray that ignores the 403 would hold itself locked out for ever, which reads
		// as a permanent outage to the honest phone behind the same NAT.
		return
	}
	entry.failures++
	if entry.failures < threshold {
		return
	}
	entry.failures = 0
	entry.lockouts++
	entry.until = now.Add(l.backoff(entry.lockouts))
	l.lockouts.Add(1)
}

// backoff doubles from Base on each successive lockout, capped at Max. The shift is bounded before
// it is taken: 1<<63 on a Duration is negative, which would unlock instead of lock.
func (l *Lockout) backoff(lockouts int) time.Duration {
	if lockouts > 32 {
		return l.policy.Max
	}
	return min(l.policy.Base<<(lockouts-1), l.policy.Max)
}

// sweepLocked drops every counter that is neither cooling nor recent, and empties the table if that
// was not enough — an attacker choosing source ports chooses the key space, so the ceiling has to be
// one they cannot move.
func (l *Lockout) sweepLocked(table map[string]*failureCount, now time.Time) {
	for key, entry := range table {
		if !entry.until.After(now) && now.Sub(entry.seen) >= l.policy.Window {
			delete(table, key)
		}
	}
	if len(table) >= l.policy.MaxTracked {
		clear(table)
	}
}

func accountKey(source, account string) string { return source + "\x00" + account }
