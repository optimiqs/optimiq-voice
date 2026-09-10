package siptls_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/siptls"
)

// authority is a throwaway CA plus the leaves it signs, so a test can prove a chain rather than
// asserting on a self-signed certificate that verifies nothing.
type authority struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pool        *x509.CertPool
	pem         []byte
}

func newAuthority(t *testing.T, name string) authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating the CA key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("creating the CA certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parsing the CA certificate: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	return authority{
		certificate: certificate,
		key:         key,
		pool:        pool,
		pem:         pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

// issue signs a leaf. `serial` distinguishes two otherwise identical certificates, which is how the
// reload test tells the new material from the old.
func (a authority) issue(t *testing.T, commonName string, serial int64, client bool) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating the leaf key: %v", err)
	}
	usage := []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	if client {
		usage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usage,
		DNSNames:     []string{commonName},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, a.certificate, &key.PublicKey, a.key)
	if err != nil {
		t.Fatalf("signing the leaf: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshalling the leaf key: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}

func (a authority) issueTo(t *testing.T, dir, base, commonName string, serial int64, client bool) (certFile, keyFile string) {
	t.Helper()
	certPEM, keyPEM := a.issue(t, commonName, serial, client)
	certFile = filepath.Join(dir, base+".crt")
	keyFile = filepath.Join(dir, base+".key")
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		t.Fatalf("writing %s: %v", certFile, err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		t.Fatalf("writing %s: %v", keyFile, err)
	}
	return certFile, keyFile
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// serve accepts one connection at a time on a real TLS listener and echoes the handshake outcome
// back through `handshakes`, so a test can assert on both ends.
func serve(t *testing.T, config *tls.Config) (addr string, handshakes <-chan error) {
	t.Helper()
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	listener := tls.NewListener(inner, config)
	t.Cleanup(func() { _ = listener.Close() })
	results := make(chan error, 8)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			results <- conn.(*tls.Conn).Handshake()
			_ = conn.Close()
		}
	}()
	return listener.Addr().String(), results
}

func dial(t *testing.T, addr string, config *tls.Config) (tls.ConnectionState, error) {
	t.Helper()
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, config)
	if err != nil {
		return tls.ConnectionState{}, err
	}
	defer conn.Close()
	return conn.ConnectionState(), nil
}

func TestParseMinVersionDefaultsTo13AndRefusesAnythingElse(t *testing.T) {
	for _, value := range []string{"", "1.3"} {
		got, err := siptls.ParseMinVersion(value)
		if err != nil || got != siptls.MinTLS13 {
			t.Fatalf("ParseMinVersion(%q) = %q, %v; want 1.3", value, got, err)
		}
	}
	if got, err := siptls.ParseMinVersion(" 1.2 "); err != nil || got != siptls.MinTLS12 {
		t.Fatalf("ParseMinVersion(1.2) = %q, %v", got, err)
	}
	for _, value := range []string{"1.1", "TLSv1.3", "13"} {
		if _, err := siptls.ParseMinVersion(value); err == nil {
			t.Fatalf("ParseMinVersion(%q) was accepted", value)
		}
	}
}

func TestTLS12IsRefusedWhenTheFloorIs13(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 1, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	addr, handshakes := serve(t, siptls.ServerConfig(reloader, siptls.ServerOptions{Min: siptls.MinTLS13}))

	if _, err := dial(t, addr, &tls.Config{RootCAs: ca.pool, MaxVersion: tls.VersionTLS12}); err == nil {
		t.Fatal("a TLS 1.2 client was admitted by a 1.3-only listener")
	}
	if err := <-handshakes; err == nil {
		t.Fatal("the listener reported a successful 1.2 handshake")
	}

	state, err := dial(t, addr, &tls.Config{RootCAs: ca.pool, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatalf("a TLS 1.3 client was refused: %v", err)
	}
	if state.Version != tls.VersionTLS13 {
		t.Fatalf("negotiated version %#x, want TLS 1.3", state.Version)
	}
	if err := <-handshakes; err != nil {
		t.Fatalf("listener handshake: %v", err)
	}
}

func TestTLS12IsAdmittedWhenTheFloorIsLowered(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 1, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	addr, handshakes := serve(t, siptls.ServerConfig(reloader, siptls.ServerOptions{Min: siptls.MinTLS12}))

	state, err := dial(t, addr, &tls.Config{RootCAs: ca.pool, MaxVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatalf("a legacy TLS 1.2 peer was refused: %v", err)
	}
	if state.Version != tls.VersionTLS12 {
		t.Fatalf("negotiated version %#x, want TLS 1.2", state.Version)
	}
	// The lowered floor must not also re-admit CBC or static-RSA key exchange.
	if !isForwardSecretAEAD(state.CipherSuite) {
		t.Fatalf("negotiated %s, which is not a forward-secret AEAD suite",
			tls.CipherSuiteName(state.CipherSuite))
	}
	if err := <-handshakes; err != nil {
		t.Fatalf("listener handshake: %v", err)
	}
}

func isForwardSecretAEAD(id uint16) bool {
	switch id {
	case tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
		tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305:
		return true
	default:
		return false
	}
}

func TestTheCertificateReloadsWithoutRebindingTheListener(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 11, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	addr, handshakes := serve(t, siptls.ServerConfig(reloader, siptls.ServerOptions{Min: siptls.MinTLS13}))

	before, err := dial(t, addr, &tls.Config{RootCAs: ca.pool})
	if err != nil {
		t.Fatalf("first handshake: %v", err)
	}
	<-handshakes
	if got := before.PeerCertificates[0].SerialNumber.Int64(); got != 11 {
		t.Fatalf("served serial %d, want 11", got)
	}

	// The renewal: the same paths, new material. mtime granularity is coarse on some filesystems,
	// so the fingerprint is nudged rather than trusted to differ by itself.
	renewed, renewedKey := ca.issue(t, "localhost", 22, false)
	if err := os.WriteFile(certFile, renewed, 0o600); err != nil {
		t.Fatalf("rewriting the certificate: %v", err)
	}
	if err := os.WriteFile(keyFile, renewedKey, 0o600); err != nil {
		t.Fatalf("rewriting the key: %v", err)
	}
	later := time.Now().Add(time.Second)
	_ = os.Chtimes(certFile, later, later)
	_ = os.Chtimes(keyFile, later, later)

	changed, err := reloader.Reload()
	if err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if !changed {
		t.Fatal("Reload reported no change after the files were rewritten")
	}
	if again, err := reloader.Reload(); err != nil || again {
		t.Fatalf("a second Reload reported changed=%v err=%v; it must be a no-op", again, err)
	}

	after, err := dial(t, addr, &tls.Config{RootCAs: ca.pool})
	if err != nil {
		t.Fatalf("handshake after the renewal: %v", err)
	}
	<-handshakes
	if got := after.PeerCertificates[0].SerialNumber.Int64(); got != 22 {
		t.Fatalf("served serial %d after the renewal, want 22", got)
	}
}

func TestAHalfWrittenRenewalLeavesThePreviousCertificateServing(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 33, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	if err := os.WriteFile(certFile, []byte("-----BEGIN CERTIFICATE-----\ntruncated\n"), 0o600); err != nil {
		t.Fatalf("truncating the certificate: %v", err)
	}
	later := time.Now().Add(time.Second)
	_ = os.Chtimes(certFile, later, later)

	if _, err := reloader.Reload(); err == nil {
		t.Fatal("a truncated certificate was accepted")
	}
	held := reloader.Certificate()
	if held == nil || held.Leaf == nil && len(held.Certificate) == 0 {
		t.Fatal("the previous certificate was dropped")
	}
	parsed, err := x509.ParseCertificate(held.Certificate[0])
	if err != nil {
		t.Fatalf("parsing the held certificate: %v", err)
	}
	if got := parsed.SerialNumber.Int64(); got != 33 {
		t.Fatalf("held serial %d, want the pre-renewal 33", got)
	}
}

func TestMutualTLSAdmitsACarrierSignedByThePinnedCAAndRefusesTheRest(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	other := newAuthority(t, "someone-else")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 1, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}

	var seen string
	config := siptls.ServerConfig(reloader, siptls.ServerOptions{
		Min:               siptls.MinTLS13,
		ClientCAs:         ca.pool,
		RequireClientCert: true,
		VerifyPeer: func(chains [][]*x509.Certificate) error {
			seen = chains[0][0].Subject.CommonName
			return nil
		},
	})
	addr, handshakes := serve(t, config)

	carrierCert, carrierKey := ca.issue(t, "carrier-a", 2, true)
	carrier, err := tls.X509KeyPair(carrierCert, carrierKey)
	if err != nil {
		t.Fatalf("building the carrier certificate: %v", err)
	}
	if _, err := dial(t, addr, &tls.Config{
		RootCAs:      ca.pool,
		Certificates: []tls.Certificate{carrier},
	}); err != nil {
		t.Fatalf("the pinned carrier was refused: %v", err)
	}
	if err := <-handshakes; err != nil {
		t.Fatalf("listener handshake with the pinned carrier: %v", err)
	}
	if seen != "carrier-a" {
		t.Fatalf("VerifyPeer saw %q, want carrier-a", seen)
	}

	// An anonymous client, and one signed by a different CA, are both refused. The refusal is
	// asserted on the LISTENER: under TLS 1.3 the client sends its (absent) certificate in its own
	// last flight, so its Dial can return before the server has rejected it.
	_, _ = dial(t, addr, &tls.Config{RootCAs: ca.pool})
	if err := <-handshakes; err == nil {
		t.Fatal("a client with no certificate was admitted by a require-client-cert listener")
	}
	strangerCert, strangerKey := other.issue(t, "carrier-b", 3, true)
	stranger, err := tls.X509KeyPair(strangerCert, strangerKey)
	if err != nil {
		t.Fatalf("building the stranger certificate: %v", err)
	}
	_, _ = dial(t, addr, &tls.Config{
		RootCAs:      ca.pool,
		Certificates: []tls.Certificate{stranger},
	})
	if err := <-handshakes; err == nil {
		t.Fatal("a carrier signed by an unpinned CA was admitted")
	}
}

func TestClientConfigPinsTheCarrierCAAndOffersItsCertificate(t *testing.T) {
	carrierCA := newAuthority(t, "carrier-ca")
	edgeCA := newAuthority(t, "edge-ca")
	dir := t.TempDir()

	// The carrier: a TLS server that demands a client certificate from edge-ca.
	serverCert, serverKey := carrierCA.issue(t, "localhost", 1, false)
	server, err := tls.X509KeyPair(serverCert, serverKey)
	if err != nil {
		t.Fatalf("building the carrier server certificate: %v", err)
	}
	addr, handshakes := serve(t, &tls.Config{
		Certificates: []tls.Certificate{server},
		MinVersion:   tls.VersionTLS13,
		ClientCAs:    edgeCA.pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
	})

	edgeCertFile, edgeKeyFile := edgeCA.issueTo(t, dir, "edge-client", "sipd-edge", 2, true)
	edge, err := tls.LoadX509KeyPair(edgeCertFile, edgeKeyFile)
	if err != nil {
		t.Fatalf("loading the edge client certificate: %v", err)
	}
	caFile := filepath.Join(dir, "carrier-ca.pem")
	if err := os.WriteFile(caFile, carrierCA.pem, 0o600); err != nil {
		t.Fatalf("writing the CA bundle: %v", err)
	}
	pinned, err := siptls.LoadCAs(caFile)
	if err != nil {
		t.Fatalf("LoadCAs: %v", err)
	}

	client := siptls.ClientConfig(siptls.ClientOptions{
		Min:                siptls.MinTLS13,
		ClientCertificates: []*tls.Certificate{&edge},
		Pins: func(serverName string) (siptls.TrunkIdentity, bool) {
			return siptls.TrunkIdentity{TrunkID: "trunk-1", CAs: pinned}, serverName == "localhost"
		},
	})
	client.ServerName = "localhost"
	client.RootCAs = carrierCA.pool
	if _, err := dial(t, addr, client); err != nil {
		t.Fatalf("the mutual-TLS handshake with the carrier failed: %v", err)
	}
	if err := <-handshakes; err != nil {
		t.Fatalf("carrier-side handshake: %v", err)
	}

	// The pin is what refuses a carrier whose certificate chains elsewhere, even when the system
	// roots would have accepted it: RootCAs here is deliberately the permissive one.
	wrongPin := siptls.ClientConfig(siptls.ClientOptions{
		Min:                siptls.MinTLS13,
		ClientCertificates: []*tls.Certificate{&edge},
		Pins: func(string) (siptls.TrunkIdentity, bool) {
			return siptls.TrunkIdentity{TrunkID: "trunk-1", CAs: edgeCA.pool}, true
		},
	})
	wrongPin.ServerName = "localhost"
	wrongPin.RootCAs = carrierCA.pool
	_, err = dial(t, addr, wrongPin)
	if err == nil {
		t.Fatal("a carrier that failed its CA pin was accepted")
	}
	if !strings.Contains(err.Error(), "trunk-1") {
		t.Fatalf("the pin failure does not name the trunk: %v", err)
	}
	<-handshakes
}

func TestLoadCAsRefusesABundleWithNoCertificate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.pem")
	if err := os.WriteFile(path, []byte("# nothing here\n"), 0o600); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if _, err := siptls.LoadCAs(path); err == nil {
		t.Fatal("an empty bundle was accepted")
	}
	if _, err := siptls.LoadCAs(filepath.Join(t.TempDir(), "absent.pem")); err == nil {
		t.Fatal("a missing bundle was accepted")
	}
}

func TestWatchReloadsOnSignalAndOnFileChange(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 41, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	signals := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		reloader.Watch(ctx, signals, 10*time.Millisecond)
		close(done)
	}()

	renewed, renewedKey := ca.issue(t, "localhost", 42, false)
	if err := os.WriteFile(certFile, renewed, 0o600); err != nil {
		t.Fatalf("rewriting the certificate: %v", err)
	}
	if err := os.WriteFile(keyFile, renewedKey, 0o600); err != nil {
		t.Fatalf("rewriting the key: %v", err)
	}
	later := time.Now().Add(time.Second)
	_ = os.Chtimes(certFile, later, later)
	_ = os.Chtimes(keyFile, later, later)
	signals <- struct{}{}

	deadline := time.Now().Add(5 * time.Second)
	for {
		held := reloader.Certificate()
		parsed, err := x509.ParseCertificate(held.Certificate[0])
		if err == nil && parsed.SerialNumber.Int64() == 42 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the watcher never installed the renewed certificate")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch did not return when its context was cancelled")
	}
}

// awaitSerial waits for the watcher to install a certificate carrying the given serial. It is the
// only way to observe a reload from outside: Watch reports nothing and never returns an error.
func awaitSerial(t *testing.T, reloader *siptls.Reloader, serial int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if held := reloader.Certificate(); held != nil && len(held.Certificate) > 0 {
			parsed, err := x509.ParseCertificate(held.Certificate[0])
			if err == nil && parsed.SerialNumber.Int64() == serial {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the watcher never installed the certificate with serial %d", serial)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startWatch runs Watch with the poll disabled, so a test that passes proves the filesystem watch
// fired and not the backstop.
func startWatch(t *testing.T, reloader *siptls.Reloader) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		reloader.Watch(ctx, nil, 0)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("Watch did not return when its context was cancelled")
		}
	})
	// The watch is armed inside the goroutine; give it the moment it needs before the test replaces
	// the files, or the event that matters happens before anything is listening for it.
	time.Sleep(100 * time.Millisecond)
}

func TestWatchReloadsWhenTheFilesAreRenamedOverAtomically(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	dir := t.TempDir()
	certFile, keyFile := ca.issueTo(t, dir, "edge", "localhost", 51, false)
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	startWatch(t, reloader)

	// What certbot does: write beside the target, then rename over it. The staging files are written
	// in the watched directory too, which is why the watcher must ignore names it does not serve.
	nextCert, nextKey := ca.issueTo(t, dir, "edge.next", "localhost", 52, false)
	if err := os.Rename(nextCert, certFile); err != nil {
		t.Fatalf("renaming the certificate into place: %v", err)
	}
	if err := os.Rename(nextKey, keyFile); err != nil {
		t.Fatalf("renaming the key into place: %v", err)
	}

	awaitSerial(t, reloader, 52)
}

func TestWatchReloadsWhenASymlinkedPairIsRepointed(t *testing.T) {
	ca := newAuthority(t, "sip-test-ca")
	root := t.TempDir()
	live, archive := filepath.Join(root, "live"), filepath.Join(root, "archive")
	for _, dir := range []string{live, archive} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatalf("creating %s: %v", dir, err)
		}
	}
	firstCert, firstKey := ca.issueTo(t, archive, "gen1", "localhost", 61, false)
	certFile, keyFile := filepath.Join(live, "cert.pem"), filepath.Join(live, "key.pem")
	if err := os.Symlink(firstCert, certFile); err != nil {
		t.Fatalf("linking the certificate: %v", err)
	}
	if err := os.Symlink(firstKey, keyFile); err != nil {
		t.Fatalf("linking the key: %v", err)
	}
	reloader, err := siptls.NewReloader(certFile, keyFile, discardLogger())
	if err != nil {
		t.Fatalf("NewReloader: %v", err)
	}
	startWatch(t, reloader)

	// The ACME swap: a new generation in the archive, and the live symlinks re-pointed by renaming a
	// second link over each. The inode behind cert.pem never changes, so only a directory watch sees
	// this at all.
	secondCert, secondKey := ca.issueTo(t, archive, "gen2", "localhost", 62, false)
	repoint(t, secondCert, certFile)
	repoint(t, secondKey, keyFile)

	awaitSerial(t, reloader, 62)
}

// repoint replaces the symlink at `link` with one to `target`, atomically, the way certbot does.
func repoint(t *testing.T, target, link string) {
	t.Helper()
	staged := link + ".staged"
	if err := os.Symlink(target, staged); err != nil {
		t.Fatalf("staging the symlink %s: %v", staged, err)
	}
	if err := os.Rename(staged, link); err != nil {
		t.Fatalf("re-pointing %s: %v", link, err)
	}
}
