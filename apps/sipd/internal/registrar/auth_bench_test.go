package registrar

import (
	"strconv"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
)

// The per-request cost of the digest exchange, isolated from the socket and the broker.

const (
	benchRealm = "bench.example.com"
	benchUser  = "1001"
)

func benchAuthenticator(b *testing.B) *Authenticator {
	b.Helper()
	authenticator, err := NewAuthenticator(benchRealm, []byte("bench-secret"), time.Hour)
	if err != nil {
		b.Fatal(err)
	}
	return authenticator
}

func BenchmarkChallenge(b *testing.B) {
	authenticator := benchAuthenticator(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := authenticator.Challenge(false); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseAuthorization(b *testing.B) {
	authenticator := benchAuthenticator(b)
	header := benchAuthorizationHeader(b, authenticator, 1)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := ParseAuthorization(header); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkVerifyRequest measures the server side only; the client's answers are built up front.
// Every iteration answers a distinct nonce/nc pair, since the replay guard accepts each exactly once.
func BenchmarkVerifyRequest(b *testing.B) {
	authenticator := benchAuthenticator(b)
	request := benchRequest(b)
	ha1 := benchHA1(b)

	const prepared = 4096
	answers := make([]Authorization, prepared)
	for index := range answers {
		authorization, err := ParseAuthorization(benchAuthorizationHeader(b, authenticator, index+1))
		if err != nil {
			b.Fatal(err)
		}
		answers[index] = authorization
	}

	index := 0
	b.ReportAllocs()
	for b.Loop() {
		if index%prepared == 0 {
			// Prepared answers are reused, so the guard must be cleared to keep measuring the
			// accept path rather than the refusal one.
			b.StopTimer()
			authenticator.nonces = newNonceGuard(time.Now)
			b.StartTimer()
		}
		if err := authenticator.VerifyRequest(request, answers[index%prepared], ha1); err != nil {
			b.Fatal(err)
		}
		index++
	}
}

// BenchmarkNonceGuardAccept measures the replay guard alone under a distinct nonce per call.
func BenchmarkNonceGuardAccept(b *testing.B) {
	guard := newNonceGuard(time.Now)
	expires := time.Now().Add(time.Minute)
	nonce := 0
	b.ReportAllocs()
	for b.Loop() {
		nonce++
		if err := guard.accept(strconv.Itoa(nonce), 1, expires); err != nil {
			b.Fatal(err)
		}
	}
}

func benchRequest(b *testing.B) *sip.Request {
	b.Helper()
	var recipient sip.Uri
	if err := sip.ParseUri("sip:"+benchRealm, &recipient); err != nil {
		b.Fatal(err)
	}
	return sip.NewRequest(sip.REGISTER, recipient)
}

func benchHA1(b *testing.B) string {
	b.Helper()
	return md5hex(benchUser + ":" + benchRealm + ":s3cret")
}

func benchAuthorizationHeader(b *testing.B, authenticator *Authenticator, nonceCount int) string {
	b.Helper()
	value, err := authenticator.Challenge(false)
	if err != nil {
		b.Fatal(err)
	}
	challenge, err := digest.ParseChallenge(value)
	if err != nil {
		b.Fatal(err)
	}
	credential, err := digest.Digest(challenge, digest.Options{
		Method: "REGISTER", URI: "sip:" + benchRealm,
		Username: benchUser, Password: "s3cret", Count: nonceCount, Cnonce: "0a4f113b",
	})
	if err != nil {
		b.Fatal(err)
	}
	return credential.String()
}
