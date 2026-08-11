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
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
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
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	subscribe_ "github.com/optimiqs/optimiq-voice/apps/sipd/internal/subscribe"
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
	addr          string
	registrar     *registrar.Registrar
	bindings      kv.Store
	presence      *presence.NATSStore
	subscriptions *subscribe_.Handler
	aorHash       string
}

// startEdge boots a registrar on a real UDP socket against a real bucket and stream, backed by the
// file credential store.
func startEdge(t *testing.T, ctx context.Context, js jetstream.JetStream) *edge {
	t.Helper()

	store, err := credentials.NewFileStore(writeCredentials(t), credentials.FileStoreOptions{})
	if err != nil {
		t.Fatalf("loading credentials: %v", err)
	}
	return startEdgeWithStore(t, ctx, js, store)
}

// startEdgeWithStore is startEdge with the credential store supplied, so the credential-RPC suite
// can boot the same vertical against NATSStore instead of the file fixture. Everything else — the
// socket, the bucket, the stream, the expiry policy — is identical, which is what makes a
// behavioural difference between the two attributable to the store.
func startEdgeWithStore(
	t *testing.T,
	ctx context.Context,
	js jetstream.JetStream,
	credentialStore credentials.Store,
) *edge {
	t.Helper()

	bindings, err := kv.Open(ctx, js)
	if err != nil {
		t.Fatalf("opening the registrations bucket: %v", err)
	}
	presenceStore, err := presence.Open(ctx, js)
	if err != nil {
		t.Fatalf("opening the presence bucket: %v", err)
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
		AllowEvents: subscribe_.AllowEvents,
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
	sipClientHalf, err := sipgo.NewClient(userAgent)
	if err != nil {
		t.Fatalf("sipgo.NewClient: %v", err)
	}

	addr := "127.0.0.1:" + strconv.Itoa(freeUDPPort(t))

	// The subscription vertical, wired against the SAME authenticator and location service as the
	// registrar — a second authenticator would mint nonces the other rejects, and the symptom is a
	// phone that registers and whose BLF keys never light.
	notifier, err := subscribe_.NewClientNotifier(sipClientHalf)
	if err != nil {
		t.Fatalf("NewClientNotifier: %v", err)
	}
	mwiSource, err := mwi.NewNATSSource(js.Conn(), slog.Default())
	if err != nil {
		t.Fatalf("mwi.NewNATSSource: %v", err)
	}
	subscriptions, err := subscribe_.New(subscribe_.Options{
		Realm:       itRealm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Bindings:    bindings,
		Presence:    presenceStore,
		MWI:         mwiSource,
		Notifier:    notifier,
		Contact:     sip.Uri{Scheme: "sip", User: "optimiq-sipd", Host: "127.0.0.1", Port: freeUDPPort(t)},
		// One second is below anything a real deployment would allow; the suite uses it so an expiry
		// sweep is observable without ten minutes of wall clock.
		Expiry:        subscribe_.ExpiryPolicy{Min: time.Second, Max: time.Hour, Default: 30 * time.Second},
		Logger:        slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})),
		SweepInterval: 200 * time.Millisecond,
		BaseContext:   ctx,
	})
	if err != nil {
		t.Fatalf("subscribe.New: %v", err)
	}

	server.OnRegister(reg.HandleRegister)
	server.OnOptions(reg.HandleOptions)
	server.OnSubscribe(subscriptions.HandleSubscribe)
	server.OnNoRoute(reg.HandleUnsupported)
	ready := make(chan struct{}, 1)
	serveCtx := context.WithValue(ctx, sipgo.ListenReadyCtxKey, sipgo.ListenReadyCtxValue(ready))

	go func() {
		if err := server.ListenAndServe(serveCtx, "udp", addr); err != nil && serveCtx.Err() == nil {
			t.Errorf("udp listener: %v", err)
		}
	}()
	go func() { _ = reg.Run(ctx) }()
	go func() { _ = subscriptions.Run(ctx) }()

	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("the UDP listener never became ready")
	}

	t.Cleanup(func() {
		_ = server.Close()
		_ = sipClientHalf.Close()
		_ = userAgent.Close()
	})

	hash, err := contract.AORSubjectToken(itAOR)
	if err != nil {
		t.Fatal(err)
	}
	return &edge{
		addr:          addr,
		registrar:     reg,
		bindings:      bindings,
		presence:      presenceStore,
		subscriptions: subscriptions,
		aorHash:       hash,
	}
}

// sipClient is a deliberately dumb UDP SIP client: write text, read one datagram, parse it.
type sipClient struct {
	t      *testing.T
	conn   *net.UDPConn
	parser *sip.Parser
	cseq   int
	// user and aor are what this client claims to be. They are fields rather than constants
	// because the registrar checks that the digest username OWNS the AOR being registered, and
	// that check runs BEFORE the credential lookup — so a test that wants to exercise the
	// credential store with a different account has to move the AOR too, or it only ever proves
	// the ownership check works.
	user   string
	aor    string
	callID string
}

func dialSIP(t *testing.T, addr string) *sipClient {
	t.Helper()
	return dialSIPAs(t, addr, itUser)
}

func dialSIPAs(t *testing.T, addr, user string) *sipClient {
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

	callID := "sipd-integration-1"
	if user != itUser {
		callID = "sipd-integration-" + user
	}
	return &sipClient{
		t:      t,
		conn:   conn,
		parser: sip.NewParser(),
		user:   user,
		aor:    "sip:" + user + "@" + itRealm,
		callID: callID,
	}
}

func (c *sipClient) localContact() string {
	return "sip:" + c.user + "@" + c.conn.LocalAddr().String()
}

func (c *sipClient) register(authorization string, contactParams string, extra ...string) *sip.Response {
	c.t.Helper()
	c.cseq++

	local := c.conn.LocalAddr().(*net.UDPAddr)
	lines := []string{
		"REGISTER sip:" + itRealm + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKit%d;rport", local.String(), c.cseq),
		"Max-Forwards: 70",
		"From: <" + c.aor + ">;tag=itfrom",
		"To: <" + c.aor + ">",
		"Call-ID: " + c.callID,
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
	return c.authenticateAs(res, c.user, itPass)
}

// authenticateAs answers a challenge with an arbitrary credential, so a test can send a WRONG
// password — or a right password for an account that does not exist — and see what comes back.
func (c *sipClient) authenticateAs(res *sip.Response, username, password string) string {
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
		Username: username, Password: password, Count: 1, Cnonce: "0a4f113b",
	})
	if err != nil {
		c.t.Fatalf("computing the digest: %v", err)
	}
	return answer.String()
}

// answerFor answers a challenge for a METHOD other than REGISTER.
//
// HA2 is MD5(method:uri), so a SUBSCRIBE answered with a REGISTER digest verifies against nothing —
// which is exactly the bug this helper exists to make impossible to write by accident.
func (c *sipClient) answerFor(res *sip.Response, method string) string {
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
		Method: method, URI: "sip:" + itRealm,
		Username: c.user, Password: itPass, Count: 1, Cnonce: "0a4f113b",
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
	// `presence` is RFC 3856 pidf+xml — a different thing wearing the same word as the `dialog`
	// package a BLF key uses, and one this edge does not serve. It used to be answered 501 along with
	// every other method; now that SUBSCRIBE is implemented, 489 with the honest `Allow-Events` is
	// the answer a phone can act on, and 501 would stop it trying a package we DO serve.
	res := send(subscribe)
	if res.StatusCode != 489 {
		t.Errorf("SUBSCRIBE = %d %s, want 489 Bad Event", res.StatusCode, res.Reason)
	}
	if header := res.GetHeader("Allow-Events"); header == nil {
		t.Error("the 489 carried no Allow-Events, so the phone learns nothing from it")
	} else if header.Value() != subscribe_.AllowEvents {
		t.Errorf("Allow-Events = %q, want %q", header.Value(), subscribe_.AllowEvents)
	}
}

// ---------------------------------------------------------------------------------------------
// the presence spine, over a real bucket and a real socket
// ---------------------------------------------------------------------------------------------

// TestBlfSubscriptionLightsFromThePresenceBucket is the round trip the whole wave exists for: a
// registered phone arms a busy-lamp key, an ENGINE-side writer moves an extension's device state in
// the `presence` KV bucket, and the lamp changes.
//
// It is deliberately end to end through the parts that are easy to get subtly wrong and impossible
// to unit-test together: a real JetStream KV watch, a real UDP socket in both directions, and a
// NOTIFY the test parses as a request rather than trusting a recorder.
func TestBlfSubscriptionLightsFromThePresenceBucket(t *testing.T) {
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

	// A SUBSCRIBE is only accepted from an account with a LIVE binding, so the phone registers first
	// — which is also the order a real handset does it in.
	challenge := client.register("", "")
	if challenge.StatusCode != 401 {
		t.Fatalf("REGISTER = %d, want a challenge", challenge.StatusCode)
	}
	if res := client.register(client.authenticate(challenge), ""); res.StatusCode != 200 {
		t.Fatalf("REGISTER = %d %s, want 200", res.StatusCode, res.Reason)
	}

	const watched = "1002"

	res := client.subscribeDialog("", watched)
	if res.StatusCode != 401 {
		t.Fatalf("SUBSCRIBE = %d %s, want a challenge", res.StatusCode, res.Reason)
	}
	res = client.subscribeDialog(client.answerFor(res, "SUBSCRIBE"), watched)
	if res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d %s, want 200", res.StatusCode, res.Reason)
	}

	// RFC 6665 §4.1.3: acceptance is followed by a full-state notification. Nothing has written
	// presence for 1002, so the honest answer is an idle body — a `dialog-info` with no children.
	initial := client.readNotify()
	if state := headerValueOf(initial, "Subscription-State"); !strings.HasPrefix(state, "active") {
		t.Errorf("the initial Subscription-State = %q, want an active state", state)
	}
	if got := dialogStatesIn(t, initial.Body()); len(got) != 0 {
		t.Errorf("an extension with no presence notified %v, want no dialog element", got)
	}

	// Now play apps/engine. The write goes through the SAME contract key builder the engine uses, so
	// a disagreement about the key shape fails here rather than as a lamp that never moves.
	presenceBucket, err := js.KeyValue(ctx, contract.PresenceKV.Name)
	if err != nil {
		t.Fatalf("binding the presence bucket: %v", err)
	}
	key, err := contract.PresenceKVKey(itOrg, watched)
	if err != nil {
		t.Fatalf("PresenceKVKey: %v", err)
	}

	for _, step := range []struct {
		device contract.PresenceDeviceState
		want   string
	}{
		{contract.PresenceDeviceStateRinging, "early"},
		{contract.PresenceDeviceStateActive, "confirmed"},
		{contract.PresenceDeviceStateHangup, "terminated"},
	} {
		value, err := json.Marshal(contract.ExtensionPresence{
			OrgID:           itOrg,
			ExtensionNumber: watched,
			State:           step.device,
			ChannelCount:    1,
			UpdatedAt:       time.Now().UnixMilli(),
		})
		if err != nil {
			t.Fatalf("encoding presence: %v", err)
		}
		if _, err := presenceBucket.Put(ctx, key, value); err != nil {
			t.Fatalf("writing presence: %v", err)
		}

		notify := client.readNotify()
		if got := headerValueOf(notify, "Event"); got != "dialog" {
			t.Errorf("%s: Event = %q", step.device, got)
		}
		if got := dialogStatesIn(t, notify.Body()); len(got) != 1 || got[0] != step.want {
			t.Errorf("%s notified %v, want [%s]", step.device, got, step.want)
		}
	}

	// And a deleted key clears the lamp, which is what the bucket's five-minute TTL does when the
	// last engine writing an extension stops.
	if err := presenceBucket.Delete(ctx, key); err != nil {
		t.Fatalf("deleting presence: %v", err)
	}
	if got := dialogStatesIn(t, client.readNotify().Body()); len(got) != 0 {
		t.Errorf("a deleted key notified %v, want no dialog element", got)
	}
}

// readNotify reads one datagram and insists it is a NOTIFY, answering it 200 the way a handset does
// so sipd's client transaction completes rather than retransmitting over the next assertion.
func (c *sipClient) readNotify() *sip.Request {
	c.t.Helper()
	if err := c.conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		c.t.Fatal(err)
	}
	buf := make([]byte, 16384)
	n, err := c.conn.Read(buf)
	if err != nil {
		c.t.Fatalf("reading a NOTIFY: %v", err)
	}
	message, err := c.parser.ParseSIP(buf[:n])
	if err != nil {
		c.t.Fatalf("parsing %q: %v", string(buf[:n]), err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		c.t.Fatalf("received a %T, want a NOTIFY request:\n%s", message, buf[:n])
	}
	if req.Method != sip.NOTIFY {
		c.t.Fatalf("received a %s, want a NOTIFY", req.Method)
	}

	res := sip.NewResponseFromRequest(req, 200, "OK", nil)
	if _, err := c.conn.Write([]byte(res.String())); err != nil {
		c.t.Fatalf("answering the NOTIFY: %v", err)
	}
	return req
}

// subscribeDialog arms a busy-lamp key on `watched`.
func (c *sipClient) subscribeDialog(authorization, watched string) *sip.Response {
	c.t.Helper()
	c.cseq++

	local := c.conn.LocalAddr().(*net.UDPAddr)
	target := "sip:" + watched + "@" + itRealm
	lines := []string{
		"SUBSCRIBE " + target + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKblf%d;rport", local.String(), c.cseq),
		"Max-Forwards: 70",
		"From: <" + c.aor + ">;tag=itblf",
		"To: <" + target + ">",
		"Call-ID: " + c.callID + "-blf",
		"CSeq: " + strconv.Itoa(c.cseq) + " SUBSCRIBE",
		"Contact: <" + c.localContact() + ">",
		"Event: dialog",
		"Expires: 60",
		"User-Agent: sipd-integration-test",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")

	if _, err := c.conn.Write([]byte(strings.Join(lines, "\r\n"))); err != nil {
		c.t.Fatalf("writing the SUBSCRIBE: %v", err)
	}
	return c.readResponse()
}

func headerValueOf(message interface{ GetHeader(string) sip.Header }, name string) string {
	header := message.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

// dialogStatesIn parses a dialog-info body and returns the state of each dialog it reports. The test
// parses rather than string-matches for the same reason the unit tests do: a phone that dislikes the
// body does not complain, it leaves the lamp where it was.
func dialogStatesIn(t *testing.T, body []byte) []string {
	t.Helper()
	var document struct {
		XMLName xml.Name `xml:"dialog-info"`
		Dialogs []struct {
			State string `xml:"state"`
		} `xml:"dialog"`
	}
	if err := xml.Unmarshal(body, &document); err != nil {
		t.Fatalf("the NOTIFY body is not dialog-info+xml: %v\n%s", err, body)
	}
	states := make([]string, 0, len(document.Dialogs))
	for _, dialog := range document.Dialogs {
		states = append(states, dialog.State)
	}
	return states
}

// ---------------------------------------------------------------------------------------------
// the presence spine, under the REAL broker permissions
// ---------------------------------------------------------------------------------------------

// The enumerated identities from config/nats.conf. Passwords are per-run junk; the point of this
// suite is the ALLOW-LISTS, not the secrets.
const (
	itSipdUser   = "sipd-it"
	itEngineUser = "engine-it"
	itNATSPass   = "integration"
)

// startNATSWithPlatformConfig runs a throwaway broker on the REAL `config/nats.conf`.
//
// This is the only test in the tree that exercises sipd against the permission set it actually
// deploys with, and it exists because the failure mode of getting that wrong is invisible in every
// other test: an allow-list that is one subject short produces a broker refusal, and a KV watch that
// was refused looks exactly like a bucket nobody is writing to — a fleet of BLF keys that stay dark
// with nothing in any log to say why. It is the same trap the registrations rehydration fell into
// with the bare `$JS.API.CONSUMER.CREATE.KV_registrations` form, and the presence watch needs the
// identical pair.
func startNATSWithPlatformConfig(t *testing.T) string {
	t.Helper()

	configPath, err := filepath.Abs(filepath.Join("..", "..", "config", "nats.conf"))
	if err != nil {
		t.Fatalf("resolving config/nats.conf: %v", err)
	}
	if _, err := os.Stat(configPath); err != nil {
		t.Fatalf("config/nats.conf is not readable: %v", err)
	}

	args := []string{
		"run", "-d", "--rm",
		"-p", "127.0.0.1::4222",
		"-v", configPath + ":/etc/nats/nats.conf:ro",
	}
	// Every `$NAME` in the file must resolve or the broker refuses to start — which is itself the
	// behaviour the config's header promises, and is why all ten are passed.
	for _, pair := range [][2]string{
		{"NATS_USER", "operator-it"},
		{"NATS_PASS", itNATSPass},
		{"NATS_API_USER", "api-it"},
		{"NATS_API_PASS", itNATSPass},
		{"NATS_ENGINE_USER", itEngineUser},
		{"NATS_ENGINE_PASS", itNATSPass},
		{"NATS_MEDIAD_USER", "mediad-it"},
		{"NATS_MEDIAD_PASS", itNATSPass},
		{"NATS_SIPD_USER", itSipdUser},
		{"NATS_SIPD_PASS", itNATSPass},
		{"NATS_SYS_USER", "sys-it"},
		{"NATS_SYS_PASS", itNATSPass},
	} {
		args = append(args, "-e", pair[0]+"="+pair[1])
	}
	args = append(args, natsImage, "-c", "/etc/nats/nats.conf")

	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run %s with the platform config: %v\n%s", natsImage, err, out)
	}
	container := strings.TrimSpace(string(out))
	t.Cleanup(func() {
		if out, err := exec.Command("docker", "rm", "-f", container).CombinedOutput(); err != nil {
			t.Logf("removing %s: %v\n%s", container, err, out)
		}
	})

	port, err := exec.Command("docker", "port", container, "4222/tcp").CombinedOutput()
	if err != nil {
		t.Fatalf("docker port: %v\n%s", err, port)
	}
	mapped := strings.TrimSpace(strings.Split(strings.TrimSpace(string(port)), "\n")[0])
	url := "nats://" + mapped

	deadline := time.Now().Add(60 * time.Second)
	for {
		conn, err := nats.Connect(url, nats.UserInfo(itSipdUser, itNATSPass))
		if err == nil {
			conn.Close()
			return url
		}
		if time.Now().After(deadline) {
			t.Fatalf("NATS did not become ready at %s: %v", url, err)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// TestSipdPresenceGrantsUnderThePlatformConfig proves the `sipd` allow-list is sufficient for the
// presence spine and no wider than it should be.
//
// Four claims, in order of what they would cost to get wrong:
//
//  1. sipd can OPEN and READ the presence bucket.
//  2. sipd can WATCH it — the bare `CONSUMER.CREATE.KV_presence` form included, which is the
//     subject a `WatchAll` with a server-generated consumer name actually publishes.
//  3. sipd can subscribe to the MWI event family.
//  4. sipd CANNOT write presence. The SIP edge renders device state; it must not be able to assert
//     any, and the only thing standing between it and a forged lamp is the absent
//     `$KV.presence.>` publish grant.
func TestSipdPresenceGrantsUnderThePlatformConfig(t *testing.T) {
	requireIntegration(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	url := startNATSWithPlatformConfig(t)

	engineConn, err := nats.Connect(url, nats.UserInfo(itEngineUser, itNATSPass))
	if err != nil {
		t.Fatalf("connecting as the engine identity: %v", err)
	}
	defer engineConn.Close()
	engineJs, err := jetstream.New(engineConn)
	if err != nil {
		t.Fatalf("jetstream.New (engine): %v", err)
	}

	sipdConn, err := nats.Connect(url, nats.UserInfo(itSipdUser, itNATSPass))
	if err != nil {
		t.Fatalf("connecting as the sipd identity: %v", err)
	}
	defer sipdConn.Close()
	sipdJs, err := jetstream.New(sipdConn)
	if err != nil {
		t.Fatalf("jetstream.New (sipd): %v", err)
	}

	// 1. Open and read.
	store, err := presence.Open(ctx, sipdJs)
	if err != nil {
		t.Fatalf("sipd cannot open the presence bucket under its own permissions: %v", err)
	}
	if _, found, err := store.Get(ctx, itOrg, "1002"); err != nil || found {
		t.Fatalf("reading an absent key = (found=%v, err=%v)", found, err)
	}

	// 2. Watch. This is the claim the bare CONSUMER.CREATE form exists for.
	changes, err := store.Watch(ctx)
	if err != nil {
		t.Fatalf("sipd cannot watch the presence bucket under its own permissions: %v", err)
	}

	// The engine identity writes, which is the other half of the grant diff.
	engineBucket, err := engineJs.KeyValue(ctx, contract.PresenceKV.Name)
	if err != nil {
		t.Fatalf("the engine identity cannot bind the presence bucket: %v", err)
	}
	key, err := contract.PresenceKVKey(itOrg, "1002")
	if err != nil {
		t.Fatal(err)
	}
	value, err := json.Marshal(contract.ExtensionPresence{
		OrgID:           itOrg,
		ExtensionNumber: "1002",
		State:           contract.PresenceDeviceStateActive,
		ChannelCount:    1,
		UpdatedAt:       time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engineBucket.Put(ctx, key, value); err != nil {
		t.Fatalf("the engine identity cannot write presence: %v", err)
	}

	select {
	case change := <-changes:
		if change.ExtensionNumber != "1002" || change.State.State != contract.PresenceDeviceStateActive {
			t.Errorf("the watch delivered %#v", change)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the presence watch delivered nothing; the consumer was probably refused")
	}

	// 3. The MWI event family.
	source, err := mwi.NewNATSSource(sipdConn, slog.Default())
	if err != nil {
		t.Fatalf("mwi.NewNATSSource: %v", err)
	}
	updates, err := source.Updates(ctx)
	if err != nil {
		t.Fatalf("sipd cannot subscribe to %s: %v", mwi.Subject, err)
	}
	// Published by the API identity's family; the engine's grant covers `voicemail.evt.v1.>` too, and
	// this test is about the SUBSCRIBER's permission rather than the publisher's.
	subject, err := contract.VoicemailSubject(itOrg, "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b52",
		contract.EventTypeVoicemailMWIUpdated)
	if err != nil {
		t.Fatal(err)
	}
	envelope := contract.NewEnvelope(contract.EventTypeVoicemailMWIUpdated,
		contract.EnvelopeInput[contract.VoicemailMWIUpdatedData]{
			OrgID: itOrg, Subject: subject, Source: "api", At: time.Now(),
			Data: contract.VoicemailMWIUpdatedData{MailboxNumber: itUser, NewCount: 3, SavedCount: 1},
		})
	payload, err := contract.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := engineConn.Publish(subject, payload); err != nil {
		t.Fatalf("publishing an MWI event: %v", err)
	}
	if err := engineConn.Flush(); err != nil {
		t.Fatalf("flushing: %v", err)
	}

	select {
	case update := <-updates:
		if update.Counts.New != 3 || update.Mailbox != itUser {
			t.Errorf("the MWI update arrived as %#v", update)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no MWI update arrived; the subscription was probably refused")
	}

	// 4. And it must NOT be able to write one. A SIP edge that could publish presence could forge a
	// lamp for any extension of any tenant on the box.
	sipdBucket, err := sipdJs.KeyValue(ctx, contract.PresenceKV.Name)
	if err != nil {
		t.Fatalf("binding the presence bucket as sipd: %v", err)
	}
	if _, err := sipdBucket.Put(ctx, key, value); err == nil {
		t.Fatal("sipd WROTE the presence bucket; the $KV.presence.> publish grant has leaked in")
	}
}
