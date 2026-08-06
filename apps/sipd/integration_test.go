//go:build integration

// Package sipd_test drives the whole registrar vertical against a real NATS JetStream server and a
// real SIP socket.
//
// It is build-tagged AND environment-gated, so `go test ./...` on a laptop or in a unit-test CI job
// never tries to start a container:
//
//	RUN_SIPD_INTEGRATION=1 go test -tags integration -v -timeout 5m ./...
//
// Requirements: a working `docker` (or a Docker-compatible CLI) on PATH. The test starts one
// throwaway `nats:2.11 -js` container on a random port and removes it on the way out, including
// after a panic or a failed assertion.
//
// Why raw UDP rather than a sipgo client: the point of an integration test is to prove that bytes
// on a wire produce a binding in a bucket. Building the REGISTER by hand and parsing the response
// with sipgo's parser keeps the SIP visible in the test, and keeps the client half from sharing
// code (and therefore bugs) with the server half.
package sipd_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

const (
	natsImage = "nats:2.11"

	itRealm = "acme.example.com"
	itOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	itUser  = "1001"
	itPass  = "s3cret"
	itAOR   = "sip:1001@acme.example.com"
)

func requireIntegration(t *testing.T) {
	t.Helper()
	if os.Getenv("RUN_SIPD_INTEGRATION") != "1" {
		t.Skip("set RUN_SIPD_INTEGRATION=1 to run the sipd integration suite (needs docker)")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker is not on PATH")
	}
}

// startNATS runs a throwaway JetStream server and returns its client URL.
func startNATS(t *testing.T) string {
	t.Helper()

	out, err := exec.Command("docker", "run", "-d", "--rm",
		"-p", "127.0.0.1::4222", natsImage, "-js").CombinedOutput()
	if err != nil {
		t.Fatalf("docker run %s: %v\n%s", natsImage, err, out)
	}
	container := strings.TrimSpace(string(out))

	t.Cleanup(func() {
		// -f because a still-running container must not outlive a failed test run.
		if out, err := exec.Command("docker", "rm", "-f", container).CombinedOutput(); err != nil {
			t.Logf("removing the NATS container: %v\n%s", err, out)
		}
	})

	// `docker port` races the daemon registering the published port right after `run -d`, and
	// answers "404 page not found" until it settles. Retry rather than fail the suite on a startup
	// race that has nothing to do with sipd.
	var mapped string
	portDeadline := time.Now().Add(30 * time.Second)
	for {
		portOut, portErr := exec.Command("docker", "port", container, "4222/tcp").CombinedOutput()
		if portErr == nil {
			if first := strings.TrimSpace(strings.Split(string(portOut), "\n")[0]); first != "" {
				mapped = first
				break
			}
		}
		if time.Now().After(portDeadline) {
			t.Fatalf("docker never published the NATS port: %v\n%s", portErr, portOut)
		}
		time.Sleep(200 * time.Millisecond)
	}
	url := "nats://" + mapped

	// JetStream needs a moment to come up; poll rather than sleep a magic number.
	deadline := time.Now().Add(60 * time.Second)
	for {
		conn, err := nats.Connect(url, nats.Timeout(2*time.Second))
		if err == nil {
			js, jsErr := jetstream.New(conn)
			if jsErr == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_, jsErr = js.AccountInfo(ctx)
				cancel()
			}
			conn.Close()
			if jsErr == nil {
				return url
			}
			err = jsErr
		}
		if time.Now().After(deadline) {
			t.Fatalf("NATS did not become ready at %s: %v", url, err)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// ensureRegistrationsStream provisions the REGISTRATIONS stream from the shared contract.
//
// sipd deliberately does not do this itself (see events.NewJetStreamPublisher): stream provisioning
// belongs to the control plane's ensureStreams. The test therefore plays the control plane.
func ensureRegistrationsStream(t *testing.T, ctx context.Context, js jetstream.JetStream) jetstream.Stream {
	t.Helper()
	definition := contract.RegistrationsStream
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:              definition.Name,
		Description:       definition.Description,
		Subjects:          definition.Subjects,
		Retention:         jetstream.LimitsPolicy,
		Storage:           jetstream.FileStorage,
		Discard:           jetstream.DiscardOld,
		MaxAge:            definition.MaxAge,
		MaxMsgs:           definition.MaxMsgs,
		MaxBytes:          definition.MaxBytes,
		MaxMsgsPerSubject: definition.MaxMsgsPerSubject,
		Duplicates:        definition.DuplicateWindow,
		Replicas:          definition.NumReplicas,
	})
	if err != nil {
		t.Fatalf("creating the %s stream: %v", definition.Name, err)
	}
	return stream
}

func writeCredentials(t *testing.T) string {
	t.Helper()
	path := t.TempDir() + "/credentials.json"
	body := fmt.Sprintf(`{
		"realm": %q,
		"accounts": [{
			"orgId": %q,
			"username": %q,
			"password": %q,
			"deviceId": "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50",
			"extensionId": "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51"
		}]
	}`, itRealm, itOrg, itUser, itPass)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing credentials: %v", err)
	}
	return path
}

// freeUDPPort reserves and releases a port so sipd can bind it. There is a small race with anything
// else on the box; on a test runner it is not worth a more elaborate scheme.
func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserving a UDP port: %v", err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

type edge struct {
	addr      string
	registrar *registrar.Registrar
	bindings  kv.Store
	aorHash   string
}

// startEdge boots a registrar on a real UDP socket against a real bucket and stream.
func startEdge(t *testing.T, ctx context.Context, js jetstream.JetStream) *edge {
	t.Helper()

	bindings, err := kv.Open(ctx, js)
	if err != nil {
		t.Fatalf("opening the registrations bucket: %v", err)
	}
	credentialStore, err := credentials.NewFileStore(writeCredentials(t))
	if err != nil {
		t.Fatalf("loading credentials: %v", err)
	}
	authenticator, err := registrar.NewAuthenticator(itRealm, []byte("integration-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	reg, err := registrar.New(registrar.Options{
		Realm:       itRealm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Bindings:    bindings,
		Publisher:   events.NewJetStreamPublisher(js),
		Logger:      slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Source:      "sipd",
		// One second is below anything a real deployment would allow; the suite uses it so the
		// expiry sweep is observable without a minute of wall clock.
		Expiry:        registrar.ExpiryPolicy{Min: time.Second, Max: time.Hour, Default: 5 * time.Second},
		SweepInterval: 200 * time.Millisecond,
		BaseContext:   ctx,
	})
	if err != nil {
		t.Fatalf("registrar.New: %v", err)
	}

	userAgent, err := sipgo.NewUA(sipgo.WithUserAgent("optimiq-sipd-test"))
	if err != nil {
		t.Fatalf("sipgo.NewUA: %v", err)
	}
	server, err := sipgo.NewServer(userAgent)
	if err != nil {
		t.Fatalf("sipgo.NewServer: %v", err)
	}
	server.OnRegister(reg.HandleRegister)
	server.OnOptions(reg.HandleOptions)
	server.OnNoRoute(reg.HandleUnsupported)

	addr := "127.0.0.1:" + strconv.Itoa(freeUDPPort(t))
	ready := make(chan struct{}, 1)
	serveCtx := context.WithValue(ctx, sipgo.ListenReadyCtxKey, sipgo.ListenReadyCtxValue(ready))

	go func() {
		if err := server.ListenAndServe(serveCtx, "udp", addr); err != nil && serveCtx.Err() == nil {
			t.Errorf("udp listener: %v", err)
		}
	}()
	go func() { _ = reg.Run(ctx) }()

	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("the UDP listener never became ready")
	}

	t.Cleanup(func() {
		_ = server.Close()
		_ = userAgent.Close()
	})

	hash, err := contract.AORSubjectToken(itAOR)
	if err != nil {
		t.Fatal(err)
	}
	return &edge{addr: addr, registrar: reg, bindings: bindings, aorHash: hash}
}

// sipClient is a deliberately dumb UDP SIP client: write text, read one datagram, parse it.
type sipClient struct {
	t      *testing.T
	conn   *net.UDPConn
	parser *sip.Parser
	cseq   int
}

func dialSIP(t *testing.T, addr string) *sipClient {
	t.Helper()
	remote, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatalf("resolving %s: %v", addr, err)
	}
	conn, err := net.DialUDP("udp", nil, remote)
	if err != nil {
		t.Fatalf("dialing %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &sipClient{t: t, conn: conn, parser: sip.NewParser()}
}

func (c *sipClient) localContact() string {
	return "sip:" + itUser + "@" + c.conn.LocalAddr().String()
}

func (c *sipClient) register(authorization string, contactParams string, extra ...string) *sip.Response {
	c.t.Helper()
	c.cseq++

	local := c.conn.LocalAddr().(*net.UDPAddr)
	lines := []string{
		"REGISTER sip:" + itRealm + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKit%d;rport", local.String(), c.cseq),
		"Max-Forwards: 70",
		"From: <" + itAOR + ">;tag=itfrom",
		"To: <" + itAOR + ">",
		"Call-ID: sipd-integration-1",
		"CSeq: " + strconv.Itoa(c.cseq) + " REGISTER",
		"Contact: <" + c.localContact() + ">" + contactParams,
		"User-Agent: sipd-integration-test",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, extra...)
	lines = append(lines, "Content-Length: 0", "", "")

	if _, err := c.conn.Write([]byte(strings.Join(lines, "\r\n"))); err != nil {
		c.t.Fatalf("writing the REGISTER: %v", err)
	}
	return c.readResponse()
}

func (c *sipClient) readResponse() *sip.Response {
	c.t.Helper()
	if err := c.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		c.t.Fatal(err)
	}
	buf := make([]byte, 8192)
	n, err := c.conn.Read(buf)
	if err != nil {
		c.t.Fatalf("reading the response: %v", err)
	}
	message, err := c.parser.ParseSIP(buf[:n])
	if err != nil {
		c.t.Fatalf("parsing the response %q: %v", string(buf[:n]), err)
	}
	res, ok := message.(*sip.Response)
	if !ok {
		c.t.Fatalf("received a %T, want a response", message)
	}
	return res
}

func (c *sipClient) authenticate(res *sip.Response) string {
	c.t.Helper()
	header := res.GetHeader("WWW-Authenticate")
	if header == nil {
		c.t.Fatal("the 401 carried no challenge")
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		c.t.Fatalf("parsing the challenge: %v", err)
	}
	answer, err := digest.Digest(challenge, digest.Options{
		Method: "REGISTER", URI: "sip:" + itRealm,
		Username: itUser, Password: itPass, Count: 1, Cnonce: "0a4f113b",
	})
	if err != nil {
		c.t.Fatalf("computing the digest: %v", err)
	}
	return answer.String()
}

// eventReader consumes the REGISTRATIONS stream in order.
type eventReader struct {
	t        *testing.T
	consumer jetstream.Consumer
}

func newEventReader(t *testing.T, ctx context.Context, stream jetstream.Stream) *eventReader {
	t.Helper()
	consumer, err := stream.OrderedConsumer(ctx, jetstream.OrderedConsumerConfig{
		DeliverPolicy: jetstream.DeliverAllPolicy,
	})
	if err != nil {
		t.Fatalf("creating an ordered consumer: %v", err)
	}
	return &eventReader{t: t, consumer: consumer}
}

func (r *eventReader) next(timeout time.Duration) (string, contract.Envelope[map[string]any]) {
	r.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		msg, err := r.consumer.Next(jetstream.FetchMaxWait(500 * time.Millisecond))
		if err == nil {
			envelope, decodeErr := contract.Unmarshal[map[string]any](msg.Data())
			if decodeErr != nil {
				r.t.Fatalf("decoding %s: %v", msg.Subject(), decodeErr)
			}
			return msg.Subject(), envelope
		}
		if !errors.Is(err, nats.ErrTimeout) && !errors.Is(err, jetstream.ErrNoMessages) {
			r.t.Fatalf("consuming: %v", err)
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("no event arrived within %s", timeout)
		}
	}
}

// ---------------------------------------------------------------------------------------------

func TestRegisterBindsPublishesAndExpires(t *testing.T) {
	requireIntegration(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	url := startNATS(t)
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	defer conn.Close()

	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream.New: %v", err)
	}
	stream := ensureRegistrationsStream(t, ctx, js)
	reader := newEventReader(t, ctx, stream)

	edge := startEdge(t, ctx, js)
	client := dialSIP(t, edge.addr)

	// --- 1. unauthenticated REGISTER is challenged -----------------------------------------------
	challenge := client.register("", ";expires=2")
	if challenge.StatusCode != 401 {
		t.Fatalf("first response = %d %s, want 401", challenge.StatusCode, challenge.Reason)
	}

	// --- 2. authenticated REGISTER binds ---------------------------------------------------------
	authorization := client.authenticate(challenge)
	ok := client.register(authorization, ";expires=2")
	if ok.StatusCode != 200 {
		t.Fatalf("authenticated response = %d %s, want 200", ok.StatusCode, ok.Reason)
	}
	if header := ok.GetHeader("Expires"); header == nil || header.Value() != "2" {
		t.Errorf("Expires = %v, want the granted 2", header)
	}

	// --- 3. the binding is in the real KV bucket --------------------------------------------------
	binding, found, err := edge.bindings.Get(ctx, itOrg, edge.aorHash)
	if err != nil {
		t.Fatalf("reading the binding: %v", err)
	}
	if !found {
		t.Fatal("no binding in the registrations bucket")
	}
	if binding.AOR != itAOR {
		t.Errorf("binding.AOR = %q, want %q", binding.AOR, itAOR)
	}
	if binding.Contact != client.localContact() {
		t.Errorf("binding.Contact = %q, want %q", binding.Contact, client.localContact())
	}
	if binding.Transport != contract.SIPTransportUDP {
		t.Errorf("binding.Transport = %q, want udp", binding.Transport)
	}
	if binding.ExpiresInSeconds != 2 {
		t.Errorf("binding.ExpiresInSeconds = %d, want 2", binding.ExpiresInSeconds)
	}
	if binding.DeviceID == "" {
		t.Error("binding.DeviceID is empty; the credential's device did not reach the bucket")
	}

	// --- 4. the registered event is on the real stream --------------------------------------------
	subject, registered := reader.next(10 * time.Second)
	wantSubject := "sip.reg.v1." + itOrg + "." + edge.aorHash + ".registered"
	if subject != wantSubject {
		t.Fatalf("subject = %q, want %q", subject, wantSubject)
	}
	if registered.Type != contract.EventTypeRegistrationRegistered {
		t.Errorf("type = %q", registered.Type)
	}
	if registered.Source != "sipd" {
		t.Errorf("source = %q, want sipd", registered.Source)
	}
	if registered.OrgID != itOrg {
		t.Errorf("orgId = %q, want %q", registered.OrgID, itOrg)
	}
	if got := registered.Data["aor"]; got != itAOR {
		t.Errorf("data.aor = %v, want %q", got, itAOR)
	}
	if got := registered.Data["aorHash"]; got != edge.aorHash {
		t.Errorf("data.aorHash = %v, want %q", got, edge.aorHash)
	}
	if got := registered.Data["expiresInSeconds"]; got != float64(2) {
		t.Errorf("data.expiresInSeconds = %v, want 2", got)
	}

	// --- 5. the sweeper expires it ----------------------------------------------------------------
	subject, expired := reader.next(15 * time.Second)
	wantSubject = "sip.reg.v1." + itOrg + "." + edge.aorHash + ".expired"
	if subject != wantSubject {
		t.Fatalf("subject = %q, want %q", subject, wantSubject)
	}
	if expired.Type != contract.EventTypeRegistrationExpired {
		t.Errorf("type = %q", expired.Type)
	}
	if _, present := expired.Data["registeredForSeconds"]; !present {
		t.Error("the expired event must report how long the binding lived")
	}

	// The bucket entry must be gone, not merely marked: a stale binding is a call into nowhere.
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, stillThere, err := edge.bindings.Get(ctx, itOrg, edge.aorHash)
		if err != nil {
			t.Fatalf("reading the binding: %v", err)
		}
		if !stillThere {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the lapsed binding is still in the registrations bucket")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestDeregisterRemovesTheBinding(t *testing.T) {
	requireIntegration(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	url := startNATS(t)
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	defer conn.Close()

	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream.New: %v", err)
	}
	stream := ensureRegistrationsStream(t, ctx, js)
	reader := newEventReader(t, ctx, stream)

	edge := startEdge(t, ctx, js)
	client := dialSIP(t, edge.addr)

	challenge := client.register("", ";expires=600")
	if challenge.StatusCode != 401 {
		t.Fatalf("first response = %d", challenge.StatusCode)
	}
	authorization := client.authenticate(challenge)
	if res := client.register(authorization, ";expires=600"); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d %s", res.StatusCode, res.Reason)
	}
	if _, subjectEvent := reader.next(10 * time.Second); subjectEvent.Type != contract.EventTypeRegistrationRegistered {
		t.Fatalf("first event = %q", subjectEvent.Type)
	}

	// Expires: 0 — a phone being powered off, or a user logging out.
	if res := client.register(authorization, ";expires=0"); res.StatusCode != 200 {
		t.Fatalf("de-register = %d %s", res.StatusCode, res.Reason)
	}

	subject, unregistered := reader.next(10 * time.Second)
	wantSubject := "sip.reg.v1." + itOrg + "." + edge.aorHash + ".unregistered"
	if subject != wantSubject {
		t.Fatalf("subject = %q, want %q", subject, wantSubject)
	}
	if unregistered.Data["reason"] != "client" {
		t.Errorf("reason = %v, want client", unregistered.Data["reason"])
	}

	if _, found, err := edge.bindings.Get(ctx, itOrg, edge.aorHash); err != nil || found {
		t.Errorf("the binding survived de-registration (found=%v, err=%v)", found, err)
	}
}

func TestOptionsAndUnsupportedMethodsOverTheWire(t *testing.T) {
	requireIntegration(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	url := startNATS(t)
	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	defer conn.Close()
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream.New: %v", err)
	}
	ensureRegistrationsStream(t, ctx, js)

	edge := startEdge(t, ctx, js)
	client := dialSIP(t, edge.addr)

	send := func(raw string) *sip.Response {
		if _, err := client.conn.Write([]byte(raw)); err != nil {
			t.Fatalf("writing: %v", err)
		}
		return client.readResponse()
	}

	local := client.conn.LocalAddr().String()
	options := strings.Join([]string{
		"OPTIONS sip:" + itRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP " + local + ";branch=z9hG4bKopt;rport",
		"Max-Forwards: 70",
		"From: <sip:probe@" + itRealm + ">;tag=t",
		"To: <sip:" + itRealm + ">",
		"Call-ID: sipd-options-1",
		"CSeq: 1 OPTIONS",
		"Content-Length: 0", "", "",
	}, "\r\n")
	if res := send(options); res.StatusCode != 200 {
		t.Errorf("OPTIONS = %d %s, want 200", res.StatusCode, res.Reason)
	}

	subscribe := strings.Join([]string{
		"SUBSCRIBE sip:1001@" + itRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP " + local + ";branch=z9hG4bKsub;rport",
		"Max-Forwards: 70",
		"From: <sip:1002@" + itRealm + ">;tag=t",
		"To: <sip:1001@" + itRealm + ">",
		"Call-ID: sipd-subscribe-1",
		"CSeq: 1 SUBSCRIBE",
		"Event: presence",
		"Content-Length: 0", "", "",
	}, "\r\n")
	if res := send(subscribe); res.StatusCode != 501 {
		t.Errorf("SUBSCRIBE = %d %s, want 501 Not Implemented", res.StatusCode, res.Reason)
	}
}
