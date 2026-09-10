// Package siptls builds the TLS configurations the SIP edge uses: the one its TLS and WSS
// listeners present, and the one it dials carriers with.
//
// Two invariants hold everything here together. First, TLS 1.3 is the floor unless a deployment
// explicitly lowers it for legacy handsets, and lowering it is loud. Second, the certificate is
// never captured by value into a tls.Config — every handshake reads it through a Reloader, so an
// ACME renewal that rewrites the PEM files is picked up without restarting the process and without
// dropping a single registration (the sockets are never rebound).
package siptls

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// MinVersion is the negotiated floor a deployment may choose. TLS 1.3 is the default; 1.2 exists
// only for handset stacks that cannot do 1.3, and choosing it is logged at boot.
type MinVersion string

const (
	// MinTLS13 is the default: TLS 1.3 only.
	MinTLS13 MinVersion = "1.3"
	// MinTLS12 admits TLS 1.2 alongside 1.3, for legacy peers.
	MinTLS12 MinVersion = "1.2"
)

// ParseMinVersion maps the configured string onto a version, refusing anything else so a typo
// cannot silently widen the floor.
func ParseMinVersion(value string) (MinVersion, error) {
	switch MinVersion(strings.TrimSpace(value)) {
	case "", MinTLS13:
		return MinTLS13, nil
	case MinTLS12:
		return MinTLS12, nil
	default:
		return "", fmt.Errorf("TLS minimum version must be 1.3 or 1.2, got %q", value)
	}
}

func (m MinVersion) uint16() uint16 {
	if m == MinTLS12 {
		return tls.VersionTLS12
	}
	return tls.VersionTLS13
}

// modernCipherSuites is the TLS 1.2 suite list. It is only consulted when the floor is 1.2 — Go
// does not allow the 1.3 suites to be configured — and admits AEAD suites with forward secrecy
// only, so lowering the floor for one legacy handset does not also re-admit CBC and RSA key
// exchange for everyone else.
var modernCipherSuites = []uint16{
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
	tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
}

// modernCurves is the key-exchange group preference: X25519 first (and its hybrid post-quantum
// form where the runtime offers it), then the NIST curves for peers that speak nothing else.
var modernCurves = []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384}

// Reloader holds the certificate a listener presents and re-reads it from disk when the files
// change, so an ACME renewal needs no restart.
//
// The zero value is unusable; call NewReloader. It is safe for concurrent use: handshakes read the
// pointer, the watcher goroutine writes it.
type Reloader struct {
	certFile string
	keyFile  string
	current  atomic.Pointer[tls.Certificate]
	stamp    atomic.Pointer[fingerprint]
	log      *slog.Logger
}

// fingerprint is the cheap pre-filter that lets the poll skip re-reading unchanged files. It is
// only ever allowed to skip work: a filesystem event forces a full re-read, because a rename can
// land a file with the same size and mtime.
type fingerprint struct {
	certSize, keySize   int64
	certMTime, keyMTime time.Time
}

// NewReloader reads the pair once, so an unreadable or mismatched certificate fails the caller
// here, at boot, with the paths in the message.
func NewReloader(certFile, keyFile string, log *slog.Logger) (*Reloader, error) {
	r := &Reloader{certFile: certFile, keyFile: keyFile, log: log}
	if _, err := r.Reload(); err != nil {
		return nil, err
	}
	return r, nil
}

// Certificate is what a tls.Config's GetCertificate hook returns: the currently loaded pair,
// whichever generation the watcher last installed.
func (r *Reloader) Certificate() *tls.Certificate { return r.current.Load() }

// Reload re-reads the PEM pair. It reports whether the material actually changed, and leaves the
// previous certificate installed when the new one cannot be parsed — a half-written renewal must
// not take the listener's identity away.
func (r *Reloader) Reload() (bool, error) { return r.reload(false) }

// reload does the work. `force` skips the size/mtime fast path, for callers that were told by the
// filesystem that something moved: a rename or a symlink swap can install a file whose size and
// mtime match the one it replaced, and the stamp would then hide a real new certificate.
//
// Both files are read in one pass and installed together or not at all. tls.LoadX509KeyPair is also
// what proves the pair matches — a cert read after its new key, or the other way round, fails here
// and the previous generation keeps serving until the next trigger.
func (r *Reloader) reload(force bool) (bool, error) {
	next, err := stat(r.certFile, r.keyFile)
	if err != nil {
		return false, err
	}
	installed := r.current.Load()
	if !force && installed != nil {
		if prior := r.stamp.Load(); prior != nil && *prior == next {
			return false, nil
		}
	}
	certificate, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return false, fmt.Errorf("loading the SIP TLS certificate from %s / %s: %w",
			r.certFile, r.keyFile, err)
	}
	r.stamp.Store(&next)
	if sameCertificate(installed, &certificate) {
		return false, nil
	}
	r.current.Store(&certificate)
	return true, nil
}

// sameCertificate compares the DER chains, so a rewrite that changed nothing is not reported as a
// reload. The private key is not compared: LoadX509KeyPair has already established that it matches
// the leaf, so an identical chain means an identical identity.
func sameCertificate(prior, next *tls.Certificate) bool {
	if prior == nil || len(prior.Certificate) != len(next.Certificate) {
		return false
	}
	for i, der := range prior.Certificate {
		if !bytes.Equal(der, next.Certificate[i]) {
			return false
		}
	}
	return true
}

func stat(certFile, keyFile string) (fingerprint, error) {
	certInfo, err := os.Stat(certFile)
	if err != nil {
		return fingerprint{}, fmt.Errorf("reading the SIP TLS certificate %s: %w", certFile, err)
	}
	keyInfo, err := os.Stat(keyFile)
	if err != nil {
		return fingerprint{}, fmt.Errorf("reading the SIP TLS key %s: %w", keyFile, err)
	}
	return fingerprint{
		certSize:  certInfo.Size(),
		keySize:   keyInfo.Size(),
		certMTime: certInfo.ModTime(),
		keyMTime:  keyInfo.ModTime(),
	}, nil
}

// ServerOptions is what the listeners' configuration needs beyond the certificate.
type ServerOptions struct {
	// Min is the negotiated floor.
	Min MinVersion
	// ClientCAs, when non-nil, makes the listener ask for a client certificate. Carrier trunks that
	// authenticate by mutual TLS chain to it.
	ClientCAs *x509.CertPool
	// RequireClientCert demands one rather than accepting an anonymous client. It only applies when
	// ClientCAs is set, because a listener that shares its socket with handsets cannot demand one.
	RequireClientCert bool
	// VerifyPeer, when set, runs after chain verification on a client certificate. It is where a
	// per-trunk pin lives: the chain proves the CA, this proves it is the trunk we expect.
	VerifyPeer func(chains [][]*x509.Certificate) error
	// NextProtos is the ALPN list, set for the WSS listener and empty for SIP-over-TLS.
	NextProtos []string
}

// ServerConfig builds the tls.Config a listener serves. The certificate is read through the
// reloader on every handshake, so nothing here has to be rebuilt when the PEM files change.
func ServerConfig(reloader *Reloader, opts ServerOptions) *tls.Config {
	config := &tls.Config{
		MinVersion:       opts.Min.uint16(),
		CipherSuites:     modernCipherSuites,
		CurvePreferences: modernCurves,
		NextProtos:       opts.NextProtos,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			if certificate := reloader.Certificate(); certificate != nil {
				return certificate, nil
			}
			return nil, errors.New("no SIP TLS certificate is loaded")
		},
	}
	if opts.ClientCAs != nil {
		config.ClientCAs = opts.ClientCAs
		config.ClientAuth = tls.VerifyClientCertIfGiven
		if opts.RequireClientCert {
			config.ClientAuth = tls.RequireAndVerifyClientCert
		}
		if opts.VerifyPeer != nil {
			verify := opts.VerifyPeer
			config.VerifyPeerCertificate = func(_ [][]byte, chains [][]*x509.Certificate) error {
				if len(chains) == 0 {
					return nil
				}
				return verify(chains)
			}
		}
	}
	return config
}

// TrunkIdentity is one carrier's mutual-TLS material, as the trunk directory carries it.
type TrunkIdentity struct {
	// TrunkID is the row id, for logs and for the pin failure message.
	TrunkID string
	// Certificate is the client certificate this edge presents to that carrier.
	Certificate *tls.Certificate
	// CAs is the pool the carrier's own certificate must chain to — the pin. Nil falls back to the
	// system roots, which is a weaker but valid configuration for a public carrier.
	CAs *x509.CertPool
}

// ClientOptions configures the dialling side.
type ClientOptions struct {
	// Min is the negotiated floor for outbound connections, the same knob as the listeners'.
	Min MinVersion
	// Pins is looked up by SNI server name at handshake time to find the CA a carrier's own
	// certificate must chain to. A destination with no entry keeps the system roots.
	Pins func(serverName string) (TrunkIdentity, bool)
	// ClientCertificates are the certificates this edge may present. crypto/tls hands the dialling
	// side only the CA list the carrier asked for (RFC 8446 §4.4.2.1) — not the destination — so
	// selection is by issuer: the first certificate the carrier's request accepts is the one sent.
	ClientCertificates []*tls.Certificate
}

// ClientConfig builds the tls.Config the user agent dials with.
//
// Mutual TLS is settled in two halves at two different moments, so they are configured separately.
// The carrier's certificate is pinned in VerifyConnection, which sees the SNI name we dialled. Ours
// is chosen in GetClientCertificate, which sees only the acceptable issuers.
func ClientConfig(opts ClientOptions) *tls.Config {
	config := &tls.Config{
		MinVersion:       opts.Min.uint16(),
		CipherSuites:     modernCipherSuites,
		CurvePreferences: modernCurves,
	}
	if len(opts.ClientCertificates) > 0 {
		certificates := opts.ClientCertificates
		config.GetClientCertificate = func(request *tls.CertificateRequestInfo) (*tls.Certificate, error) {
			for _, certificate := range certificates {
				if request.SupportsCertificate(certificate) == nil {
					return certificate, nil
				}
			}
			// An empty certificate is how crypto/tls says "I have none"; the carrier decides whether
			// that is fatal.
			return &tls.Certificate{}, nil
		}
	}
	if lookup := opts.Pins; lookup != nil {
		config.VerifyConnection = func(state tls.ConnectionState) error {
			identity, ok := lookup(state.ServerName)
			if !ok || identity.CAs == nil {
				return nil
			}
			if len(state.PeerCertificates) == 0 {
				return fmt.Errorf("trunk %s presented no certificate", identity.TrunkID)
			}
			intermediates := x509.NewCertPool()
			for _, certificate := range state.PeerCertificates[1:] {
				intermediates.AddCert(certificate)
			}
			_, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
				Roots:         identity.CAs,
				Intermediates: intermediates,
				DNSName:       state.ServerName,
			})
			if err != nil {
				return fmt.Errorf("trunk %s failed its CA pin: %w", identity.TrunkID, err)
			}
			return nil
		}
	}
	return config
}

// LoadCAs reads a PEM bundle into a pool, refusing a file that contains no certificate rather than
// handing back an empty pool that would verify nothing.
func LoadCAs(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading the CA bundle %s: %w", path, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("the CA bundle %s contains no PEM certificate", path)
	}
	return pool, nil
}
