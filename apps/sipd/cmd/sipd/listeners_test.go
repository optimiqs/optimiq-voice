package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
)

func testTLSConfig(t *testing.T) *tls.Config {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating a key: %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "sipd-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("signing the certificate: %v", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS12,
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestServer(t *testing.T) *sipgo.Server {
	t.Helper()
	agent, err := sipgo.NewUA(sipgo.WithUserAgent("sipd-test"))
	if err != nil {
		t.Fatalf("creating the user agent: %v", err)
	}
	t.Cleanup(func() { agent.Close() })
	server, err := sipgo.NewServer(agent)
	if err != nil {
		t.Fatalf("creating the server: %v", err)
	}
	return server
}

// The bound socket is the readiness signal health reports on, so bindListener must hand back a
// socket that already accepts traffic — nothing may be reported ready before the bind.
func TestBindListenerBindsBeforeReportingReady(t *testing.T) {
	tlsConfig := testTLSConfig(t)
	for _, network := range []string{"udp", "tcp", "ws", "tls", "wss"} {
		t.Run(network, func(t *testing.T) {
			bound, err := bindListener(network, "127.0.0.1:0", tlsConfig, 1<<20, discardLogger())
			if err != nil {
				t.Fatalf("binding %s: %v", network, err)
			}
			defer bound.closer.Close()

			host, port, err := net.SplitHostPort(bound.addr)
			if err != nil {
				t.Fatalf("the bound address %q is not host:port: %v", bound.addr, err)
			}
			if host != "127.0.0.1" || port == "0" {
				t.Fatalf("the listener reported %q rather than a bound ephemeral address", bound.addr)
			}
			if bound.serve == nil {
				t.Fatal("no serve function was returned")
			}

			// The socket is held: a second bind of the same address is refused, which is the
			// evidence that readiness reported at this point is not premature.
			if network == "udp" {
				again, err := net.ListenPacket("udp", bound.addr)
				if err == nil {
					again.Close()
					t.Fatalf("%s was still free after bindListener returned", bound.addr)
				}
				return
			}
			again, err := net.Listen("tcp", bound.addr)
			if err == nil {
				again.Close()
				t.Fatalf("%s was still free after bindListener returned", bound.addr)
			}
			peer, err := net.DialTimeout("tcp", bound.addr, 2*time.Second)
			if err != nil {
				t.Fatalf("the socket at %s does not accept: %v", bound.addr, err)
			}
			peer.Close()
		})
	}
}

// A port another process already holds must fail the boot with the address named, rather than
// leaving health to report a listener count that will never be reached.
func TestBindListenerFailsLoudlyOnATakenPort(t *testing.T) {
	tlsConfig := testTLSConfig(t)

	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("taking a tcp port: %v", err)
	}
	defer taken.Close()
	takenUDP, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("taking a udp port: %v", err)
	}
	defer takenUDP.Close()

	for _, network := range []string{"udp", "tcp", "ws", "tls", "wss"} {
		t.Run(network, func(t *testing.T) {
			addr := taken.Addr().String()
			if network == "udp" {
				addr = takenUDP.LocalAddr().String()
			}
			bound, err := bindListener(network, addr, tlsConfig, 1<<20, discardLogger())
			if err == nil {
				bound.closer.Close()
				t.Fatalf("%s bound %s while it was already taken", network, addr)
			}
			if !strings.Contains(err.Error(), addr) {
				t.Fatalf("the failure does not name the address: %v", err)
			}
		})
	}
}

func TestBindListenerRefusesTLSWithoutACertificate(t *testing.T) {
	for _, network := range []string{"tls", "wss"} {
		t.Run(network, func(t *testing.T) {
			if _, err := bindListener(network, "127.0.0.1:0", nil, 0, discardLogger()); err == nil {
				t.Fatalf("%s bound without a certificate", network)
			}
		})
	}
}

func TestBindListenerRejectsAnUnsupportedTransport(t *testing.T) {
	if _, err := bindListener("sctp", "127.0.0.1:0", nil, 0, discardLogger()); err == nil {
		t.Fatal("sctp was accepted")
	}
}

// Serving a bound socket must end when the owner closes it, with a close error rather than a hang:
// that is what lets shutdown be one context cancel with no sipgo-side cancellation goroutine.
func TestBoundListenerServeReturnsWhenTheSocketCloses(t *testing.T) {
	server := newTestServer(t)
	for _, network := range []string{"udp", "tcp", "ws", "tls", "wss"} {
		t.Run(network, func(t *testing.T) {
			bound, err := bindListener(network, "127.0.0.1:0", testTLSConfig(t), 1<<20, discardLogger())
			if err != nil {
				t.Fatalf("binding %s: %v", network, err)
			}
			served := make(chan error, 1)
			go func() { served <- bound.serve(server) }()

			time.Sleep(50 * time.Millisecond)
			bound.closer.Close()

			select {
			case err := <-served:
				if err != nil && !errors.Is(err, net.ErrClosed) {
					t.Fatalf("serving %s ended with %v rather than a closed socket", network, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("serving %s did not end after its socket was closed", network)
			}
		})
	}
}
