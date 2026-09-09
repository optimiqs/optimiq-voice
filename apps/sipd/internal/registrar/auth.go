package registrar

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
)

// HTTP digest authentication (RFC 2617 / RFC 3261 §22) for REGISTER.
//
// # Why the nonce is stateless
//
// sipd is horizontally scalable and sits behind a load balancer that will happily send a device's
// challenge to instance A and its answer to instance B. A nonce held in a map on one instance
// therefore breaks every deployment with more than one replica — the classic registrar bug, and the
// exact shape of sipgo's own example ("NOTE: This server only supports 1 REGISTRATION/Challenge").
//
// So the nonce CARRIES its own validity: expiry + randomness + an HMAC over both, keyed by a secret
// every instance shares. Verification is a recomputation, needs no shared state, and a nonce cannot
// be forged without the secret or used after its deadline.
//
//	nonce = <expiryUnixHex> "." <random16Hex> "." <hmacSHA256(secret, expiry "." random)[:16]Hex>
//
// # Replay, and why there is per-instance nonce-count state after all
//
// The digest covers the method, the request URI and the nonce. It does NOT cover the Contact. So a
// replayed Authorization header is not "the same device re-binding the same contact": within the
// nonce TTL an observer on an unencrypted transport can resend the identical credentials in a
// REGISTER carrying THEIR contact, and inbound calls for the victim fork to the attacker. The
// stale-CSeq guard in contacts.go does not catch it, because it only fires for the same contact URI.
//
// The fix is the RFC 2617 §3.2.1 nonce count: a nonce may be answered with a given nc exactly once,
// and a legitimate re-REGISTER increments it. That is per-instance, best-effort state — an answer
// load-balanced to an instance that has not seen the nonce is accepted on its first use there — so
// it narrows the replay window rather than closing it, and TLS remains the real boundary on an
// untrusted network. It costs one bounded map and it removes the trivial single-instance attack.
//
// Still NOT here: rate limiting and credential-stuffing detection, which are the anti-fraud
// consumer's job on the REGISTRATIONS stream (plan §5 T1), not a registrar one.

// Digest failure modes. The registrar maps these to SIP statuses; they are distinct types so the
// mapping lives in one place and so tests can assert the reason, not the status.
var (
	// ErrNoAuthorization means the request carried no credentials at all: challenge it.
	ErrNoAuthorization = errors.New("registrar: no Authorization header")
	// ErrNonceStale means the credentials are well-formed but the nonce has expired: re-challenge
	// with stale=true so the device retries silently instead of prompting a user.
	ErrNonceStale = errors.New("registrar: nonce is stale")
	// ErrNonceInvalid means the nonce was not minted by this fleet.
	ErrNonceInvalid = errors.New("registrar: nonce is invalid")
	// ErrRealmMismatch means the device answered a challenge for a different realm.
	ErrRealmMismatch = errors.New("registrar: realm mismatch")
	// ErrUnsupportedAlgorithm means the device asked for an algorithm this registrar does not
	// implement.
	ErrUnsupportedAlgorithm = errors.New("registrar: unsupported digest algorithm")
	// ErrBadResponse means the digest did not verify: wrong password.
	ErrBadResponse = errors.New("registrar: digest response mismatch")
	// ErrMalformedAuthorization means the header could not be parsed.
	ErrMalformedAuthorization = errors.New("registrar: malformed Authorization header")
	// ErrNonceReplayed means this nonce has already been answered with that nonce count. It wraps
	// ErrNonceStale so every caller re-challenges with stale=true: the honest device whose nc we
	// have already seen retries silently against a fresh nonce, and the replayer has nothing to
	// answer the new challenge with.
	ErrNonceReplayed = errors.New("registrar: nonce count replayed")
	// ErrQOPUnsupported means the answer used a quality-of-protection the challenge did not offer.
	// The challenge always advertises qop="auth"; accepting the RFC 2069 form against it is a
	// downgrade an attacker chooses, not a compatibility the device needs.
	ErrQOPUnsupported = errors.New("registrar: unsupported qop")
)

// Authenticator mints and verifies digest challenges for one realm.
type Authenticator struct {
	realm  string
	secret []byte
	ttl    time.Duration
	now    func() time.Time
	// nonces is the replay guard, SHARED with every per-realm authenticator ForRequest derives, so
	// a fleet of domains does not become a fleet of empty guards.
	nonces *nonceGuard
}

// NewAuthenticator builds an authenticator. An empty secret is replaced by 32 random bytes, which
// is correct for a single instance and wrong for a fleet — see config.Config.NonceSecret.
func NewAuthenticator(realm string, secret []byte, ttl time.Duration) (*Authenticator, error) {
	if strings.TrimSpace(realm) == "" {
		return nil, errors.New("registrar: the digest realm must not be empty")
	}
	if ttl <= 0 {
		return nil, errors.New("registrar: the nonce TTL must be positive")
	}
	if len(secret) == 0 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, fmt.Errorf("registrar: generating a nonce secret: %w", err)
		}
	}
	authenticator := &Authenticator{realm: realm, secret: secret, ttl: ttl, now: time.Now}
	authenticator.nonces = newNonceGuard(func() time.Time { return authenticator.now() })
	return authenticator, nil
}

// Realm returns the realm this authenticator challenges for.
func (a *Authenticator) Realm() string { return a.realm }

// ForRequest selects the account domain, never the called destination or an unverified digest
// realm. The credential directory remains the authority for which organizations own domains.
func (a *Authenticator) ForRequest(req *sip.Request) *Authenticator {
	realm := ""
	if req.Method == sip.REGISTER {
		if to := req.To(); to != nil {
			realm = to.Address.Host
		}
	} else if from := req.From(); from != nil {
		realm = from.Address.Host
	}
	realm = strings.ToLower(strings.TrimSpace(realm))
	if realm == "" || realm == a.realm {
		return a
	}
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte("sip-realm\x00" + realm))
	return &Authenticator{realm: realm, secret: mac.Sum(nil), ttl: a.ttl, now: a.now, nonces: a.nonces}
}

// VerifyRequest binds the digest to the actual request URI as well as its method and realm.
func (a *Authenticator) VerifyRequest(req *sip.Request, auth Authorization, ha1 string) error {
	if auth.URI != req.Recipient.String() {
		return ErrBadResponse
	}
	return a.Verify(req.Method.String(), auth, ha1)
}

// Challenge returns a WWW-Authenticate header value.
//
// stale=true tells the device its credentials were right but its nonce had expired, so it may retry
// without asking a human. Getting that flag wrong is why phones pop password prompts at 3am.
func (a *Authenticator) Challenge(stale bool) (string, error) {
	nonce, err := a.mintNonce()
	if err != nil {
		return "", err
	}
	challenge := digest.Challenge{
		Realm:     a.realm,
		Nonce:     nonce,
		Algorithm: "MD5",
		QOP:       []string{"auth"},
		Stale:     stale,
	}
	return challenge.String(), nil
}

func (a *Authenticator) mintNonce() (string, error) {
	expiry := a.now().Add(a.ttl).Unix()
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("registrar: generating a nonce: %w", err)
	}
	body := strconv.FormatInt(expiry, 16) + "." + hex.EncodeToString(salt)
	return body + "." + a.macFor(body), nil
}

func (a *Authenticator) macFor(body string) string {
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

// CheckNonce validates a nonce this fleet minted. It returns ErrNonceInvalid for anything forged or
// malformed and ErrNonceStale for a genuine nonce past its deadline.
func (a *Authenticator) CheckNonce(nonce string) error {
	parts := strings.Split(nonce, ".")
	if len(parts) != 3 {
		return ErrNonceInvalid
	}
	body := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(a.macFor(body)), []byte(parts[2])) {
		return ErrNonceInvalid
	}
	expiry, err := strconv.ParseInt(parts[0], 16, 64)
	if err != nil {
		return ErrNonceInvalid
	}
	if a.now().Unix() >= expiry {
		return ErrNonceStale
	}
	return nil
}

// Authorization is a parsed Authorization header.
type Authorization struct {
	Username  string
	Realm     string
	Nonce     string
	URI       string
	Response  string
	Algorithm string
	Cnonce    string
	QOP       string
	NC        int
}

// ParseAuthorization parses an Authorization header value.
func ParseAuthorization(value string) (Authorization, error) {
	if strings.TrimSpace(value) == "" {
		return Authorization{}, ErrNoAuthorization
	}
	credential, err := digest.ParseCredentials(value)
	if err != nil {
		return Authorization{}, fmt.Errorf("%w: %v", ErrMalformedAuthorization, err)
	}
	return Authorization{
		Username:  credential.Username,
		Realm:     credential.Realm,
		Nonce:     credential.Nonce,
		URI:       credential.URI,
		Response:  strings.ToLower(credential.Response),
		Algorithm: credential.Algorithm,
		Cnonce:    credential.Cnonce,
		QOP:       credential.QOP,
		NC:        credential.Nc,
	}, nil
}

// Verify recomputes the digest from a stored HA1 and compares it in constant time.
//
// The comparison must be constant time: a timing-variable compare over a hex digest is a practical
// oracle for recovering it byte by byte, and the digest is derived from the password.
func (a *Authenticator) Verify(method string, auth Authorization, ha1 string) error {
	if auth.Realm != a.realm {
		return ErrRealmMismatch
	}
	switch strings.ToUpper(auth.Algorithm) {
	case "", "MD5":
	default:
		// MD5-sess and the SHA-256 variants are absent from essentially every deskphone in the
		// top-5 vendor catalogue; accepting them silently as MD5 would be worse than refusing.
		return fmt.Errorf("%w: %s", ErrUnsupportedAlgorithm, auth.Algorithm)
	}
	// The challenge offers qop="auth" and nothing else, so anything else is a downgrade: RFC 2617
	// §3.2.2 requires the client to use a qop the server offered, and the RFC 2069 form the legacy
	// branch would compute carries no client nonce and no nonce count to replay-guard with.
	if auth.QOP != "auth" {
		return fmt.Errorf("%w: %q", ErrQOPUnsupported, auth.QOP)
	}
	if err := a.CheckNonce(auth.Nonce); err != nil {
		return err
	}

	expected := digestResponse(ha1, method, auth.URI, auth.Nonce, auth.QOP, auth.Cnonce, auth.NC)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(auth.Response)) != 1 {
		return ErrBadResponse
	}
	// Last, and only once the credentials are known good: a wrong password must not be able to burn
	// a nonce count the honest device is about to use.
	return a.nonces.accept(auth.Nonce, auth.NC, nonceExpiry(auth.Nonce))
}

// nonceGuard records the highest nonce count accepted for each live nonce.
//
// It is bounded and best-effort by construction: entries are dropped once their nonce cannot be
// valid any more, and a guard that has filled up is emptied rather than grown, because a full guard
// means somebody is minting nonces faster than they expire and the alternative is an attacker
// choosing this process's memory ceiling.
type nonceGuard struct {
	mu   sync.Mutex
	seen map[string]nonceUse
	max  int
	now  func() time.Time
}

type nonceUse struct {
	nc      int
	expires time.Time
}

func newNonceGuard(now func() time.Time) *nonceGuard {
	return &nonceGuard{seen: make(map[string]nonceUse), max: 10000, now: now}
}

// accept records the nonce count and refuses one that is not strictly greater than the last.
func (g *nonceGuard) accept(nonce string, nc int, expires time.Time) error {
	if nc <= 0 {
		// No nonce count at all is a header that cannot be replay-guarded, and the challenge asked
		// for one. Treated as a replay so the device re-answers a fresh challenge properly.
		return fmt.Errorf("%w: %w", ErrNonceStale, ErrNonceReplayed)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if previous, seen := g.seen[nonce]; seen && nc <= previous.nc {
		return fmt.Errorf("%w: %w", ErrNonceStale, ErrNonceReplayed)
	}
	if len(g.seen) >= g.max {
		g.sweepLocked()
	}
	g.seen[nonce] = nonceUse{nc: nc, expires: expires}
	return nil
}

// sweepLocked drops every nonce that has expired, and everything if that was not enough.
func (g *nonceGuard) sweepLocked() {
	now := g.now()
	for nonce, use := range g.seen {
		if !use.expires.After(now) {
			delete(g.seen, nonce)
		}
	}
	if len(g.seen) >= g.max {
		g.seen = make(map[string]nonceUse)
	}
}

// nonceExpiry reads the deadline out of a nonce this fleet minted. A nonce that does not parse
// never reaches here, because CheckNonce runs first.
func nonceExpiry(nonce string) time.Time {
	head, _, found := strings.Cut(nonce, ".")
	if !found {
		return time.Time{}
	}
	seconds, err := strconv.ParseInt(head, 16, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(seconds, 0)
}

// digestResponse implements RFC 2617 §3.2.2.1, both the qop=auth and the legacy no-qop forms.
func digestResponse(ha1, method, uri, nonce, qop, cnonce string, nc int) string {
	ha2 := md5hex(method + ":" + uri)
	if qop == "auth" {
		return md5hex(strings.Join([]string{
			ha1, nonce, fmt.Sprintf("%08x", nc), cnonce, qop, ha2,
		}, ":"))
	}
	return md5hex(ha1 + ":" + nonce + ":" + ha2)
}

func md5hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}
