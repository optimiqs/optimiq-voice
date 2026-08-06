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
	"time"

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
// # What this does NOT do
//
// Nonce-count replay protection. Tracking nc per nonce is precisely the shared state the design
// removes, and it buys little here: the nonce TTL is a minute, the transport should be TLS on any
// untrusted network, and a replayed REGISTER re-binds the same contact for the same device. Real
// mitigation for credential attacks is rate limiting plus the anti-fraud consumer on the
// REGISTRATIONS stream, which is a control-plane concern (plan §5 T1), not a registrar one.

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
)

// Authenticator mints and verifies digest challenges for one realm.
type Authenticator struct {
	realm  string
	secret []byte
	ttl    time.Duration
	now    func() time.Time
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
	return &Authenticator{realm: realm, secret: secret, ttl: ttl, now: time.Now}, nil
}

// Realm returns the realm this authenticator challenges for.
func (a *Authenticator) Realm() string { return a.realm }

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
	if err := a.CheckNonce(auth.Nonce); err != nil {
		return err
	}

	expected := digestResponse(ha1, method, auth.URI, auth.Nonce, auth.QOP, auth.Cnonce, auth.NC)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(auth.Response)) != 1 {
		return ErrBadResponse
	}
	return nil
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
