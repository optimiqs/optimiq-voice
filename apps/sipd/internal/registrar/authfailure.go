package registrar

import (
	"context"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
)

// AuthFailureInterval is the window in which one source and account pair produces at most one
// `auth-failed` event.
//
// The rate bound belongs HERE and not in the consumer: a credential spray is thousands of REGISTERs
// a second and the whole point of the event is that it is raised on the path an attacker paces. An
// unbounded publisher would turn the attack into a JetStream write per packet, and `sip_auth_event`
// into the disk the attacker fills. One row a minute per (source, account) is enough to answer both
// questions the table exists for — which address, and which account.
const AuthFailureInterval = time.Minute

// maxTrackedAuthFailures bounds the rate limiter's table. An attacker choosing source ports chooses
// the key space, so a full table is emptied rather than grown: losing the memory of who was
// refused costs at most one extra row each, and it is the only ceiling the attacker cannot move.
const maxTrackedAuthFailures = 10000

// authFailureLimiter admits one report per source and account per AuthFailureInterval.
//
// Best-effort and per-instance, like nonceGuard: a fleet reports at most one row per instance per
// window, which is a constant factor and not a flood.
type authFailureLimiter struct {
	mu       sync.Mutex
	lastSeen map[string]time.Time
	interval time.Duration
	max      int
}

func newAuthFailureLimiter(interval time.Duration) *authFailureLimiter {
	return &authFailureLimiter{
		lastSeen: make(map[string]time.Time),
		interval: interval,
		max:      maxTrackedAuthFailures,
	}
}

// admit reports whether this refusal should be published, and records it when it should.
func (l *authFailureLimiter) admit(source, account string, now time.Time) bool {
	key := source + "\x00" + account
	l.mu.Lock()
	defer l.mu.Unlock()
	if last, seen := l.lastSeen[key]; seen && now.Sub(last) < l.interval {
		return false
	}
	if len(l.lastSeen) >= l.max {
		l.sweepLocked(now)
	}
	l.lastSeen[key] = now
	return true
}

// sweepLocked drops every entry whose window has passed, and everything if that was not enough.
func (l *authFailureLimiter) sweepLocked(now time.Time) {
	for key, last := range l.lastSeen {
		if now.Sub(last) >= l.interval {
			delete(l.lastSeen, key)
		}
	}
	if len(l.lastSeen) >= l.max {
		clear(l.lastSeen)
	}
}

// publishAuthFailure reports a REGISTER whose digest did not verify.
//
// Needs an organization, because the subject carries one: an attempt against an account that
// exists nowhere is filed by apps/api from the credential lookup instead. A refusal served from the
// lockout table has one only when an earlier failure on the same account resolved it. Nothing
// derived from the offered password — not the response, not the nonce — reaches the payload.
//
// `locked` marks the refusals that cost no credential lookup at all.
func (r *Registrar) publishAuthFailure(
	ctx context.Context,
	req *sip.Request,
	orgID, aor, username string,
	reason contract.RegistrationAuthFailedReason,
	locked bool,
) {
	if orgID == "" || aor == "" {
		return
	}
	source := req.Source()
	if !r.authFailures.admit(source, username, r.now()) {
		return
	}
	data := contract.RegistrationAuthFailedData{
		AOR:           aor,
		Transport:     transportOf(req),
		SourceAddress: optional(source),
		UserAgent:     optional(headerValue(req, "User-Agent")),
		Username:      username,
		Reason:        reason,
	}
	if locked {
		// Set only when true: an explicit `false` on every ordinary refusal is noise in a table
		// whose whole purpose is being read by hand.
		data.Locked = new(true)
	}
	envelope, err := contract.NewRegistrationAuthFailedEnvelope(
		contract.EnvelopeInput[contract.RegistrationAuthFailedData]{
			OrgID: orgID, Source: r.source, At: r.now(),
			Data: data,
		})
	if err == nil {
		err = r.publisher.AuthFailed(ctx, envelope)
	}
	if err != nil {
		r.log.Error("cannot publish an authentication failure", "error", err)
	}
}

// refresh re-asks the credential store for an account whose digest just failed, reporting whether
// it came back with a DIFFERENT ha1 — the only case worth re-verifying.
//
// A store that does not cache implements no Refresher and this is a no-op; the NATS store bounds
// the re-ask per account, so a credential spray cannot turn one wrong password into one RPC.
func (r *Registrar) refresh(
	ctx context.Context,
	realm, username string,
	stale credentials.Credential,
) (credentials.Credential, bool) {
	refresher, ok := r.creds.(credentials.Refresher)
	if !ok {
		return credentials.Credential{}, false
	}
	fresh, err := refresher.Refresh(ctx, realm, username)
	if err != nil || fresh.HA1 == stale.HA1 {
		return credentials.Credential{}, false
	}
	return fresh, true
}
