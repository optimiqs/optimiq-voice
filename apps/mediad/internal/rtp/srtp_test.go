package rtp_test

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"
	pionsrtp "github.com/pion/srtp/v3"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// srtpMaterial builds deterministic 30-byte key material (16-byte key + 14-byte salt).
func srtpMaterial(seed byte) []byte {
	material := make([]byte, 30)
	for i := range material {
		material[i] = seed ^ byte(i*7+1)
	}
	return material
}

// farEndContexts builds the mirror of what the session holds: the far end encrypts with the key it
// offered (the session's REMOTE key) and decrypts with the key the session answered (its LOCAL one).
func farEndContexts(t *testing.T, sessionLocal, sessionRemote []byte) (send, recv *pionsrtp.Context) {
	t.Helper()
	profile := pionsrtp.ProtectionProfileAes128CmHmacSha1_80
	send, err := pionsrtp.CreateContext(sessionRemote[:16], sessionRemote[16:], profile)
	if err != nil {
		t.Fatalf("far-end send context: %v", err)
	}
	recv, err = pionsrtp.CreateContext(sessionLocal[:16], sessionLocal[16:], profile)
	if err != nil {
		t.Fatalf("far-end receive context: %v", err)
	}
	return send, recv
}

// newSecureEchoSession starts an echo session whose sockets are protected by SDES, and returns it
// with the far end's two contexts.
func newSecureEchoSession(t *testing.T) (*rtp.Session, *net.UDPConn, *pionsrtp.Context, *pionsrtp.Context) {
	t.Helper()

	local, remote := srtpMaterial(0x11), srtpMaterial(0x22)
	secure, err := rtp.NewSRTPContext(rtp.SRTPKeys{LocalKeyMaterial: local, RemoteKeyMaterial: remote})
	if err != nil {
		t.Fatalf("NewSRTPContext: %v", err)
	}

	allocator, err := rtp.NewAllocator(loopback, 53400, 53499)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	pair, err := allocator.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	session, err := rtp.NewSession(rtp.Options{
		ID:               "srtp-session-under-test",
		Ports:            pair,
		Mode:             rtp.ModeEcho,
		SRTP:             secure,
		AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		_ = pair.Close()
		t.Fatalf("NewSession: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- session.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		_ = session.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run returned %v; a cancelled session must return nil", err)
			}
		case <-time.After(readTimeout):
			t.Error("Run did not return after the session was closed")
		}
	})

	send, recv := farEndContexts(t, local, remote)
	return session, newFarEnd(t, session), send, recv
}

// A protected packet must reach the session as plaintext RTP, and the reply must come back
// protected under the key the session advertised.
func TestSRTPRoundTrip(t *testing.T) {
	session, conn, send, recv := newSecureEchoSession(t)

	plain := g711Packet(1, 160, 0x1234ABCD)
	protected, err := send.EncryptRTP(nil, plain, nil)
	if err != nil {
		t.Fatalf("EncryptRTP: %v", err)
	}
	if len(protected) != len(plain)+10 {
		t.Fatalf("protected packet is %d bytes, want %d (a 10-byte HMAC-SHA1-80 tag)",
			len(protected), len(plain)+10)
	}
	if _, err := conn.Write(protected); err != nil {
		t.Fatalf("writing to the session: %v", err)
	}

	waitFor(t, "the session to accept the protected packet", func() bool {
		return session.Stats().PacketsReceived == 1
	})
	if malformed := session.Stats().Malformed; malformed != 0 {
		t.Fatalf("Malformed = %d, want 0: a correctly keyed packet must authenticate", malformed)
	}

	if err := conn.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("reading the echo: %v", err)
	}
	// The echo must NOT be readable as plaintext RTP of the original size: it is on the wire encrypted.
	if n != len(plain)+10 {
		t.Fatalf("echo is %d bytes, want %d; the outbound path did not protect it", n, len(plain)+10)
	}
	decrypted, err := recv.DecryptRTP(nil, buf[:n], nil)
	if err != nil {
		t.Fatalf("the echo does not authenticate under the session's advertised key: %v", err)
	}
	var echoed pionrtp.Packet
	if err := echoed.Unmarshal(decrypted); err != nil {
		t.Fatalf("the decrypted echo is not RTP: %v", err)
	}
	var original pionrtp.Packet
	if err := original.Unmarshal(plain); err != nil {
		t.Fatalf("unmarshalling the original: %v", err)
	}
	if string(echoed.Payload) != string(original.Payload) {
		t.Fatal("the echoed payload does not match the plaintext that was sent")
	}
}

// A packet protected under a key the session never agreed to must be dropped, not relayed.
func TestSRTPWrongKeyIsDropped(t *testing.T) {
	session, conn, _, _ := newSecureEchoSession(t)

	wrong := srtpMaterial(0x99)
	attacker, err := pionsrtp.CreateContext(wrong[:16], wrong[16:],
		pionsrtp.ProtectionProfileAes128CmHmacSha1_80)
	if err != nil {
		t.Fatalf("CreateContext: %v", err)
	}
	protected, err := attacker.EncryptRTP(nil, g711Packet(9, 1600, 0x1234ABCD), nil)
	if err != nil {
		t.Fatalf("EncryptRTP: %v", err)
	}
	if _, err := conn.Write(protected); err != nil {
		t.Fatalf("writing to the session: %v", err)
	}

	waitFor(t, "the session to reject the mis-keyed packet", func() bool {
		return session.Stats().Malformed == 1
	})
	if received := session.Stats().PacketsReceived; received != 0 {
		t.Fatalf("PacketsReceived = %d, want 0: a packet failing the auth tag must not be accepted",
			received)
	}
	expectNoPacket(t, conn, "a packet that failed authentication was echoed back")
}

// Plaintext RTP arriving on an SRTP leg fails the auth tag like anything else, so a downgrade
// cannot get an unprotected stream through.
func TestSRTPRejectsPlaintext(t *testing.T) {
	session, conn, _, _ := newSecureEchoSession(t)

	if _, err := conn.Write(g711Packet(3, 480, 0x1234ABCD)); err != nil {
		t.Fatalf("writing to the session: %v", err)
	}
	waitFor(t, "the session to reject plaintext RTP", func() bool {
		return session.Stats().Malformed == 1
	})
	if received := session.Stats().PacketsReceived; received != 0 {
		t.Fatalf("PacketsReceived = %d, want 0", received)
	}
}

func TestNewSRTPContextRejectsBadKeyMaterial(t *testing.T) {
	good := srtpMaterial(0x11)
	cases := map[string]rtp.SRTPKeys{
		"short local":   {LocalKeyMaterial: good[:20], RemoteKeyMaterial: good},
		"short remote":  {LocalKeyMaterial: good, RemoteKeyMaterial: good[:29]},
		"missing local": {RemoteKeyMaterial: good},
	}
	for name, keys := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := rtp.NewSRTPContext(keys); !errors.Is(err, rtp.ErrBadSRTPKey) {
				t.Fatalf("NewSRTPContext error = %v, want %v", err, rtp.ErrBadSRTPKey)
			}
		})
	}
}
