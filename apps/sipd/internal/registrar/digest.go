package registrar

import (
	"context"
	"errors"
	"net"
	"strings"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
)

// DigestOutcome is what one digest exchange decided. It carries no SIP status: REGISTER, INVITE,
// SUBSCRIBE and REFER answer the same decision with their own responses and their own events.
type DigestOutcome int

const (
	// DigestAccepted means the answer verified against the account's HA1.
	DigestAccepted DigestOutcome = iota
	// DigestChallenge means the request carried no usable credential for this realm. Re-challenge.
	DigestChallenge
	// DigestStale means the credential was well formed but its nonce has expired or been replayed.
	// Re-challenge with stale=true; the device retries without prompting its user.
	DigestStale
	// DigestMalformed means the Authorization header could not be parsed at all.
	DigestMalformed
	// DigestWrongIdentity means a valid-looking credential named a different account from the one
	// the request acts as. Never challenged: retrying cannot help.
	DigestWrongIdentity
	// DigestThrottled means the lockout refused before any credential was looked up.
	DigestThrottled
	// DigestUnknownAccount means the directory knows no such account on this realm.
	DigestUnknownAccount
	// DigestDisabled means the account exists and is switched off.
	DigestDisabled
	// DigestBadPassword means the digest did not verify, including after a credential refresh.
	DigestBadPassword
	// DigestBackendUnavailable means the credential store could not answer. It is NOT a claim about
	// the account, and must be answered 503 rather than 403 — see the comment in Authenticate.
	DigestBackendUnavailable
)

// Refusable reports whether the outcome must be answered identically to an unknown account, so that
// a spray cannot tell a locked account, an absent one, a disabled one and a wrong password apart.
func (o DigestOutcome) Refusable() bool {
	switch o {
	case DigestThrottled, DigestUnknownAccount, DigestDisabled, DigestBadPassword, DigestWrongIdentity:
		return true
	default:
		return false
	}
}

// DigestResult is one exchange's decision plus everything a handler needs to answer it.
type DigestResult struct {
	Outcome DigestOutcome
	// Credential is set only on DigestAccepted.
	Credential credentials.Credential
	// Auth is the parsed Authorization header, empty when there was none or it was malformed. Its
	// Username is what the request claimed to be, and is safe to log but never to trust.
	Auth Authorization
	// Realm is the realm the exchange ran against — the tenant's when the request named a domain
	// this deployment serves, the deployment default otherwise.
	Realm string
	// DefaultRealm reports that the request named no domain, so Realm is the deployment default.
	DefaultRealm bool
	// Refusal is set on DigestThrottled.
	Refusal LockoutRefusal
	// Replayed reports that DigestStale was caused by a repeated nonce count — a captured credential
	// being re-sent rather than an honest expiry.
	Replayed bool
	// OrgID and AOR name the account the exchange resolved to, when it resolved to one. They are
	// set on failures too, so a refusal can be reported on an org-scoped subject.
	OrgID string
	AOR   string
	// Err is the underlying cause for the log line. Never returned to the far end.
	Err error
}

// DigestGate is the one digest authentication pipeline: nonce handling, identity binding, throttle
// accounting, credential lookup, the stale-credential refresh, and failure classification.
//
// It exists because four handlers had four copies of it and they had already diverged — SUBSCRIBE
// and out-of-dialog REFER ran no lockout at all, so a spray that used them got an unthrottled
// budget, and only REGISTER re-fetched a rotated credential. The SIP responses stay with the
// handlers; only the policy is shared.
//
// Safe for concurrent use: it owns nothing mutable of its own, and the Authenticator and Lockout it
// holds are themselves concurrent.
type DigestGate struct {
	auth    *Authenticator
	creds   credentials.Store
	lockout *Lockout
}

// NewDigestGate builds the pipeline. A nil lockout disables throttling, which is what a deployment
// with SIPD_AUTH_LOCKOUT_THRESHOLD=0 asks for.
func NewDigestGate(auth *Authenticator, creds credentials.Store, lockout *Lockout) *DigestGate {
	return &DigestGate{auth: auth, creds: creds, lockout: lockout}
}

// Authenticate runs the exchange for one request.
//
// `identity` is the account the request acts as — the AOR user for REGISTER, the From user for
// INVITE, SUBSCRIBE and REFER. A credential naming anybody else is refused: otherwise any valid
// account on the realm could register somebody's extension, call as them, or read their mailbox.
// Empty skips the binding, for a method where the request names no account of its own.
//
// `aor` is what a failure is recorded against, so a later refusal served without a lookup is still
// attributable to an org. Empty derives one from the credential when there is one.
func (g *DigestGate) Authenticate(ctx context.Context, req *sip.Request, identity, aor string) DigestResult {
	accountAuth := g.auth.ForRequest(req)
	result := DigestResult{
		Realm:        accountAuth.Realm(),
		DefaultRealm: RequestRealm(req) == "",
		AOR:          aor,
	}

	auth, err := ParseAuthorization(headerValue(req, "Authorization"))
	if err != nil {
		result.Err = err
		result.Outcome = DigestMalformed
		if errors.Is(err, ErrNoAuthorization) {
			result.Outcome = DigestChallenge
		}
		return result
	}
	result.Auth = auth

	if auth.Realm != accountAuth.Realm() {
		result.Outcome = DigestChallenge
		return result
	}
	if err := accountAuth.CheckNonce(auth.Nonce); err != nil {
		result.Err = err
		result.Outcome = DigestChallenge
		if errors.Is(err, ErrNonceStale) {
			result.Outcome = DigestStale
			result.Replayed = errors.Is(err, ErrNonceReplayed)
		}
		return result
	}
	if identity != "" && auth.Username != identity {
		result.Outcome = DigestWrongIdentity
		return result
	}

	source, account := SourceIdentity(req), lockoutAccount(accountAuth.Realm(), auth.Username)

	// Before the lookup, and answered exactly as an unknown account is: a spray that could tell a
	// locked account from an absent one would have an enumeration oracle, and one that reached the
	// directory at all would cost an RPC per packet.
	if refusal, locked := g.lockout.Locked(source, account); locked {
		result.Refusal = refusal
		result.OrgID = refusal.OrgID
		if result.AOR == "" {
			result.AOR = refusal.AOR
		}
		result.Outcome = DigestThrottled
		return result
	}

	credential, err := g.creds.Lookup(ctx, accountAuth.Realm(), auth.Username)
	if err != nil {
		result.Err = err
		switch {
		case errors.Is(err, credentials.ErrNotFound):
			// A guess at an account that exists nowhere still counts: a spray that walked extension
			// numbers rather than passwords would otherwise never trip the source cap.
			g.lockout.Fail(source, account, "", "")
			result.Outcome = DigestUnknownAccount
		case errors.Is(err, credentials.ErrDisabled):
			result.Outcome = DigestDisabled
		default:
			// No answer from the credential RPC is not a claim about this account: a 403 tells the
			// phone its credentials are wrong and most handsets stop retrying, so a burst that
			// exceeds the responder's deadline would black out a fleet until somebody re-provisions
			// it. 503 is the retriable answer (RFC 3261 §21.5.4).
			result.Outcome = DigestBackendUnavailable
		}
		return result
	}
	result.OrgID = credential.OrgID
	if result.AOR == "" {
		result.AOR = "sip:" + credential.Username + "@" + strings.ToLower(credential.Realm)
	}

	// HA2 is hash(method:uri), so a credential minted for another method verifies nothing here.
	if err := accountAuth.VerifyRequest(req, auth, credential.HA1); err != nil {
		result.Err = err
		if errors.Is(err, ErrNonceStale) {
			result.Outcome = DigestStale
			result.Replayed = errors.Is(err, ErrNonceReplayed)
			return result
		}
		// The rotation grace: apps/api sends the pre-rotation digest alongside the current one while
		// the window it was rotated with is still open, so a phone that has not been reflashed yet
		// authenticates rather than being locked out. Tried before the re-ask below because it costs
		// nothing and answers the same question.
		if credential.HA1Previous != "" {
			if grace := accountAuth.VerifyRequest(req, auth, credential.HA1Previous); grace == nil {
				g.lockout.Succeed(source, account)
				result.Credential, result.Outcome, result.Err = credential, DigestAccepted, nil
				return result
			}
		}
		// A digest that does not verify is the ONLY signal this edge gets that the HA1 it holds may
		// be the previous one: the credential RPC is pull-only and apps/api publishes nothing when a
		// SIP secret is rotated, so there is no invalidation to subscribe to. Re-ask once — the
		// store rate-bounds it — and re-verify, or a rotation refuses a correctly re-authenticating
		// phone for a whole positive TTL.
		if fresh, refreshed := g.refresh(ctx, accountAuth.Realm(), auth.Username, credential); refreshed {
			if retry := accountAuth.VerifyRequest(req, auth, fresh.HA1); retry == nil {
				g.lockout.Succeed(source, account)
				result.Credential, result.Outcome, result.Err = fresh, DigestAccepted, nil
				return result
			}
		}
		g.lockout.Fail(source, account, credential.OrgID, result.AOR)
		result.Outcome = DigestBadPassword
		return result
	}

	g.lockout.Succeed(source, account)
	result.Credential, result.Outcome = credential, DigestAccepted
	return result
}

// refresh re-asks the credential store for an account whose digest just failed, reporting whether it
// came back with a DIFFERENT ha1 — the only case worth re-verifying.
//
// A store that does not cache implements no Refresher and this is a no-op; the NATS store bounds the
// re-ask per account, so a credential spray cannot turn one wrong password into one RPC.
func (g *DigestGate) refresh(
	ctx context.Context,
	realm, username string,
	stale credentials.Credential,
) (credentials.Credential, bool) {
	refresher, ok := g.creds.(credentials.Refresher)
	if !ok {
		return credentials.Credential{}, false
	}
	fresh, err := refresher.Refresh(ctx, realm, username)
	if err != nil || fresh.HA1 == stale.HA1 {
		return credentials.Credential{}, false
	}
	return fresh, true
}

// SourceIdentity is the address a throttle counter is kept against: the HOST of the request's
// source, with the port dropped.
//
// A UDP phone picks a new ephemeral port whenever its NAT rebinds, and every counter kept against
// `host:port` would split on that churn — so an attacker that changed source port between attempts
// got a fresh budget each time, and an honest device's failures were scattered across counters.
func SourceIdentity(req *sip.Request) string {
	source := req.Source()
	host, _, err := net.SplitHostPort(source)
	if err != nil {
		return strings.ToLower(source)
	}
	return strings.ToLower(host)
}

// lockoutAccount scopes a throttle counter to its realm. Two tenants may both have an extension
// 1001, and one tenant's failures must not lock the other's account out.
func lockoutAccount(realm, username string) string {
	return strings.ToLower(realm) + "/" + username
}
