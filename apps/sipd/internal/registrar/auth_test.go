package registrar

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/icholy/digest"
)

// Digest authentication unit tests.
//
// The answers under test are computed by github.com/icholy/digest — an independent CLIENT-side
// implementation of RFC 2617 — so a bug in the verifier below cannot cancel out against a matching
// bug in a hand-written expectation.

const (
	authRealm    = "acme.example.com"
	authUser     = "1001"
	authPassword = "s3cret"
)

func newTestAuthenticator(t *testing.T, ttl time.Duration) *Authenticator {
	t.Helper()
	authenticator, err := NewAuthenticator(authRealm, []byte("a-fixed-fleet-wide-secret"), ttl)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	return authenticator
}

// answer plays the client half: parse the challenge, compute the response, parse it back as the
// registrar would see it on the wire.
func answer(t *testing.T, challenge string, method, uri, password string) Authorization {
	t.Helper()
	parsed, err := digest.ParseChallenge(challenge)
	if err != nil {
		t.Fatalf("a real client cannot parse our challenge: %v", err)
	}
	credential, err := digest.Digest(parsed, digest.Options{
		Method:   method,
		URI:      uri,
		Username: authUser,
		Password: password,
		Count:    1,
		Cnonce:   "0a4f113b",
	})
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	authorization, err := ParseAuthorization(credential.String())
	if err != nil {
		t.Fatalf("ParseAuthorization: %v", err)
	}
	return authorization
}

func ha1() string {
	// Mirrors credentials.HA1 without importing it, so this package's tests stay standalone.
	return digestHA1(authUser, authRealm, authPassword)
}

func digestHA1(user, realm, password string) string {
	return md5hex(user + ":" + realm + ":" + password)
}

func TestChallengeIsWellFormedAndParsable(t *testing.T) {
	authenticator := newTestAuthenticator(t, time.Minute)

	value, err := authenticator.Challenge(false)
	if err != nil {
		t.Fatalf("Challenge: %v", err)
	}
	challenge, err := digest.ParseChallenge(value)
	if err != nil {
		t.Fatalf("a real client cannot parse our challenge: %v", err)
	}
	if challenge.Realm != authRealm {
		t.Errorf("realm = %q, want %q", challenge.Realm, authRealm)
	}
	if challenge.Algorithm != "MD5" {
		t.Errorf("algorithm = %q, want MD5 (what SIP phones implement)", challenge.Algorithm)
	}
	if !challenge.SupportsQOP("auth") {
		t.Error("the challenge must advertise qop=auth")
	}
	if challenge.Stale {
		t.Error("a fresh challenge must not claim stale")
	}

	stale, err := authenticator.Challenge(true)
	if err != nil {
		t.Fatalf("Challenge(stale): %v", err)
	}
	parsedStale, err := digest.ParseChallenge(stale)
	if err != nil {
		t.Fatalf("ParseChallenge: %v", err)
	}
	if !parsedStale.Stale {
		t.Error("stale=true must survive to the wire, or phones prompt a human on every nonce expiry")
	}
}

func TestNoncesAreUniquePerChallenge(t *testing.T) {
	authenticator := newTestAuthenticator(t, time.Minute)
	seen := make(map[string]struct{}, 64)
	for range 64 {
		value, err := authenticator.Challenge(false)
		if err != nil {
			t.Fatal(err)
		}
		challenge, err := digest.ParseChallenge(value)
		if err != nil {
			t.Fatal(err)
		}
		if _, duplicate := seen[challenge.Nonce]; duplicate {
			t.Fatalf("nonce %q was minted twice", challenge.Nonce)
		}
		seen[challenge.Nonce] = struct{}{}
	}
}

func TestVerifyAcceptsAGenuineAnswer(t *testing.T) {
	authenticator := newTestAuthenticator(t, time.Minute)
	challenge, err := authenticator.Challenge(false)
	if err != nil {
		t.Fatal(err)
	}

	authorization := answer(t, challenge, "REGISTER", "sip:"+authRealm, authPassword)
	if err := authenticator.Verify("REGISTER", authorization, ha1()); err != nil {
		t.Fatalf("Verify rejected a genuine answer: %v", err)
	}
}

func TestVerifyRejectsTheThingsThatMatter(t *testing.T) {
	authenticator := newTestAuthenticator(t, time.Minute)
	challenge, err := authenticator.Challenge(false)
	if err != nil {
		t.Fatal(err)
	}
	good := answer(t, challenge, "REGISTER", "sip:"+authRealm, authPassword)

	t.Run("wrong password", func(t *testing.T) {
		bad := answer(t, challenge, "REGISTER", "sip:"+authRealm, "wrong")
		if err := authenticator.Verify("REGISTER", bad, ha1()); !errors.Is(err, ErrBadResponse) {
			t.Errorf("err = %v, want ErrBadResponse", err)
		}
	})

	t.Run("replayed onto another method", func(t *testing.T) {
		// The method is inside HA2, so a REGISTER answer must not authorise an INVITE. Without that
		// binding a captured registration doubles as a call-placing credential.
		if err := authenticator.Verify("INVITE", good, ha1()); !errors.Is(err, ErrBadResponse) {
			t.Errorf("err = %v, want ErrBadResponse", err)
		}
	})

	t.Run("replayed onto another URI", func(t *testing.T) {
		other := good
		other.URI = "sip:elsewhere.example.com"
		if err := authenticator.Verify("REGISTER", other, ha1()); !errors.Is(err, ErrBadResponse) {
			t.Errorf("err = %v, want ErrBadResponse", err)
		}
	})

	t.Run("another realm", func(t *testing.T) {
		other := good
		other.Realm = "evil.example.com"
		if err := authenticator.Verify("REGISTER", other, ha1()); !errors.Is(err, ErrRealmMismatch) {
			t.Errorf("err = %v, want ErrRealmMismatch", err)
		}
	})

	t.Run("unsupported algorithm", func(t *testing.T) {
		other := good
		other.Algorithm = "SHA-256"
		if err := authenticator.Verify("REGISTER", other, ha1()); !errors.Is(err, ErrUnsupportedAlgorithm) {
			t.Errorf("err = %v, want ErrUnsupportedAlgorithm", err)
		}
	})

	t.Run("forged nonce", func(t *testing.T) {
		other := good
		other.Nonce = "deadbeef.cafebabecafebabe.00000000000000000000000000000000"
		if err := authenticator.Verify("REGISTER", other, ha1()); !errors.Is(err, ErrNonceInvalid) {
			t.Errorf("err = %v, want ErrNonceInvalid", err)
		}
	})
}

func TestNoncesFromAnotherFleetAreRejected(t *testing.T) {
	// The stateless nonce is only trustworthy because the MAC is keyed. A nonce minted with a
	// different secret must not verify, or any host could challenge on our behalf.
	ours := newTestAuthenticator(t, time.Minute)
	theirs, err := NewAuthenticator(authRealm, []byte("a-different-secret"), time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	value, err := theirs.Challenge(false)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := digest.ParseChallenge(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := ours.CheckNonce(challenge.Nonce); !errors.Is(err, ErrNonceInvalid) {
		t.Errorf("err = %v, want ErrNonceInvalid", err)
	}
}

func TestNoncesFromTheSameFleetVerifyOnAnyInstance(t *testing.T) {
	// The whole point of the stateless design: instance A challenges, instance B verifies.
	instanceA := newTestAuthenticator(t, time.Minute)
	instanceB := newTestAuthenticator(t, time.Minute)

	value, err := instanceA.Challenge(false)
	if err != nil {
		t.Fatal(err)
	}
	authorization := answer(t, value, "REGISTER", "sip:"+authRealm, authPassword)
	if err := instanceB.Verify("REGISTER", authorization, ha1()); err != nil {
		t.Fatalf("instance B rejected instance A's challenge: %v", err)
	}
}

func TestNonceExpiry(t *testing.T) {
	authenticator := newTestAuthenticator(t, 30*time.Second)
	now := time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)
	authenticator.now = func() time.Time { return now }

	value, err := authenticator.Challenge(false)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := digest.ParseChallenge(value)
	if err != nil {
		t.Fatal(err)
	}

	if err := authenticator.CheckNonce(challenge.Nonce); err != nil {
		t.Fatalf("a fresh nonce must verify: %v", err)
	}

	now = now.Add(29 * time.Second)
	if err := authenticator.CheckNonce(challenge.Nonce); err != nil {
		t.Fatalf("a nonce one second short of its TTL must verify: %v", err)
	}

	now = now.Add(2 * time.Second)
	if err := authenticator.CheckNonce(challenge.Nonce); !errors.Is(err, ErrNonceStale) {
		t.Errorf("err = %v, want ErrNonceStale (not ErrNonceInvalid — the device should retry)", err)
	}
}

func TestParseAuthorization(t *testing.T) {
	if _, err := ParseAuthorization(""); !errors.Is(err, ErrNoAuthorization) {
		t.Errorf("err = %v, want ErrNoAuthorization for an absent header", err)
	}
	if _, err := ParseAuthorization("Bearer abc"); !errors.Is(err, ErrMalformedAuthorization) {
		t.Errorf("err = %v, want ErrMalformedAuthorization for a non-digest scheme", err)
	}

	authorization, err := ParseAuthorization(
		`Digest username="1001", realm="acme.example.com", nonce="abc", uri="sip:acme.example.com", ` +
			`response="AABBCCDDEEFF00112233445566778899", algorithm=MD5, cnonce="0a4f113b", qop=auth, nc=00000001`,
	)
	if err != nil {
		t.Fatalf("ParseAuthorization: %v", err)
	}
	if authorization.Username != "1001" || authorization.Realm != authRealm {
		t.Errorf("parsed = %+v", authorization)
	}
	if authorization.NC != 1 {
		t.Errorf("nc = %d, want 1", authorization.NC)
	}
	if authorization.Response != strings.ToLower(authorization.Response) {
		t.Error("the response must be normalised to lower case before a constant-time compare")
	}
}

func TestNewAuthenticatorRejectsBadInput(t *testing.T) {
	if _, err := NewAuthenticator("", []byte("s"), time.Minute); err == nil {
		t.Error("an empty realm must be refused: it is part of HA1")
	}
	if _, err := NewAuthenticator(authRealm, []byte("s"), 0); err == nil {
		t.Error("a non-positive nonce TTL must be refused")
	}
	generated, err := NewAuthenticator(authRealm, nil, time.Minute)
	if err != nil {
		t.Fatalf("an empty secret must be replaced, not rejected: %v", err)
	}
	if len(generated.secret) != 32 {
		t.Errorf("generated secret is %d bytes, want 32", len(generated.secret))
	}
}
