//go:build load

package sipd_test

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/icholy/digest"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/subscribe"
)

// loadHA1 is MD5(username:realm:password), what the API ships and the registrar verifies.
func loadHA1(username, realm string) string {
	sum := md5.Sum([]byte(username + ":" + realm + ":" + loadPass))
	return hex.EncodeToString(sum[:])
}

// loadEdge is a registrar on real sockets, wired exactly as cmd/sipd wires it.
type loadEdge struct {
	udpAddr string
	tcpAddr string
	wsAddr  string
	conn    *nats.Conn
	creds   *credentialResponderLoad
	server  *sipgo.Server
}

// startLoadEdge boots the REGISTER vertical on udp, tcp and ws against a real bucket and stream,
// with the production wiring throughout; only the addresses and the log level differ.
func startLoadEdge(t *testing.T, ctx context.Context, url string) *loadEdge {
	t.Helper()

	conn, err := nats.Connect(url, nats.Name("sipd-load"))
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	t.Cleanup(conn.Close)

	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}
	ensureLoadStreams(t, ctx, js)

	bindings, err := kv.Open(ctx, js)
	if err != nil {
		t.Fatalf("opening the registrations bucket: %v", err)
	}

	responder := startCredentialResponderLoad(t, url, 0)
	credentialStore, err := credentials.NewNATSStore(conn, credentials.NATSOptions{})
	if err != nil {
		t.Fatalf("credentials.NewNATSStore: %v", err)
	}

	authenticator, err := registrar.NewAuthenticator(loadRealm, []byte("load-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	log := loadLogger()
	reg, err := registrar.New(registrar.Options{
		InstanceID:  "sipd-load-1",
		Realm:       loadRealm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Bindings:    bindings,
		Publisher:   events.NewJetStreamPublisher(js),
		Logger:      log,
		Source:      "sipd",
		AllowEvents: subscribe.AllowEvents,
		Expiry:      registrar.ExpiryPolicy{Min: time.Second, Max: time.Hour, Default: 300 * time.Second},
		// The production default; the sweep's cost is worth measuring under a storm.
		SweepInterval: 5 * time.Second,
		BaseContext:   ctx,
	})
	if err != nil {
		t.Fatalf("registrar.New: %v", err)
	}

	bindings.SetHint(reg)

	userAgent, err := sipgo.NewUA(sipgo.WithUserAgent("optimiq-sipd-load"))
	if err != nil {
		t.Fatalf("sipgo.NewUA: %v", err)
	}
	server, err := sipgo.NewServer(userAgent, sipgo.WithServerLogger(log))
	if err != nil {
		t.Fatalf("sipgo.NewServer: %v", err)
	}
	server.OnRegister(reg.HandleRegister)
	server.OnOptions(reg.HandleOptions)
	server.OnNoRoute(reg.HandleUnsupported)

	edge := &loadEdge{
		udpAddr: "127.0.0.1:" + strconv.Itoa(loadUDPPort(t)),
		tcpAddr: "127.0.0.1:" + strconv.Itoa(loadPort(t)),
		wsAddr:  "127.0.0.1:" + strconv.Itoa(loadPort(t)),
		conn:    conn,
		creds:   responder,
		server:  server,
	}

	var ready sync.WaitGroup
	serve := func(network, addr string) {
		signal := make(chan struct{}, 1)
		go func() {
			serveCtx := context.WithValue(ctx, sipgo.ListenReadyCtxKey, sipgo.ListenReadyCtxValue(signal))
			if err := server.ListenAndServe(serveCtx, network, addr); err != nil && serveCtx.Err() == nil {
				t.Errorf("%s listener: %v", network, err)
			}
		}()
		ready.Go(func() {
			select {
			case <-signal:
			case <-time.After(10 * time.Second):
				t.Errorf("the %s listener never became ready", network)
			}
		})
	}
	serve("udp", edge.udpAddr)
	serve("tcp", edge.tcpAddr)
	serve("ws", edge.wsAddr)
	ready.Wait()

	go func() { _ = reg.Run(ctx) }()
	t.Cleanup(func() {
		_ = server.Close()
		_ = userAgent.Close()
	})
	return edge
}

// phone is one synthetic handset. It speaks whichever transport it was dialled on, answers digest
// challenges, and increments its own nonce count — which the registrar's replay guard requires.
type phone struct {
	transport  string
	user       string
	aor        string
	callID     string
	cseq       int
	nonceCount int
	parser     *sip.Parser

	udp *net.UDPConn
	// stream is the framed transport: a raw TCP connection, or a WebSocket one wrapped so one SIP
	// message is one frame (RFC 7118 §5).
	stream net.Conn
	isWS   bool
	// pending is the read buffer for the stream transports, where two responses can arrive in one
	// TCP segment.
	pending []byte
}

func dialPhone(t *testing.T, edge *loadEdge, transport string, index int) *phone {
	t.Helper()
	user := fmt.Sprintf("1%04d", index)
	p := &phone{
		transport: transport,
		user:      user,
		aor:       "sip:" + user + "@" + loadRealm,
		callID:    "load-" + transport + "-" + user,
		parser:    sip.NewParser(),
	}
	switch transport {
	case "udp":
		remote, err := net.ResolveUDPAddr("udp", edge.udpAddr)
		if err != nil {
			t.Fatalf("resolving %s: %v", edge.udpAddr, err)
		}
		conn, err := net.DialUDP("udp", nil, remote)
		if err != nil {
			t.Fatalf("dialing udp: %v", err)
		}
		p.udp = conn
	case "tcp":
		conn, err := net.Dial("tcp", edge.tcpAddr)
		if err != nil {
			t.Fatalf("dialing tcp: %v", err)
		}
		p.stream = conn
	case "ws":
		// RFC 7118 §4: a SIP-over-WebSocket client MUST offer the `sip` subprotocol, and sipgo's
		// server refuses a handshake that does not.
		dialer := ws.Dialer{Protocols: []string{"sip"}}
		conn, _, _, err := dialer.Dial(context.Background(), "ws://"+edge.wsAddr)
		if err != nil {
			t.Fatalf("dialing ws: %v", err)
		}
		p.stream, p.isWS = conn, true
	default:
		t.Fatalf("unknown transport %q", transport)
	}
	t.Cleanup(func() { _ = p.close() })
	return p
}

func (p *phone) close() error {
	if p.udp != nil {
		return p.udp.Close()
	}
	if p.stream != nil {
		return p.stream.Close()
	}
	return nil
}

func (p *phone) localAddr() string {
	if p.udp != nil {
		return p.udp.LocalAddr().String()
	}
	return p.stream.LocalAddr().String()
}

// register writes one REGISTER and reads one response.
func (p *phone) register(authorization string) (*sip.Response, error) {
	p.cseq++
	lines := []string{
		"REGISTER sip:" + loadRealm + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/%s %s;branch=z9hG4bKload%s%d;rport",
			strings.ToUpper(p.transport), p.localAddr(), p.user, p.cseq),
		"Max-Forwards: 70",
		"From: <" + p.aor + ">;tag=loadfrom" + p.user,
		"To: <" + p.aor + ">",
		"Call-ID: " + p.callID,
		"CSeq: " + strconv.Itoa(p.cseq) + " REGISTER",
		"Contact: <sip:" + p.user + "@" + p.localAddr() + ";transport=" + p.transport + ">",
		"User-Agent: sipd-load",
		"Expires: 300",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")
	if err := p.write([]byte(strings.Join(lines, "\r\n"))); err != nil {
		return nil, err
	}
	return p.read()
}

func (p *phone) write(payload []byte) error {
	if p.udp != nil {
		_, err := p.udp.Write(payload)
		return err
	}
	if p.isWS {
		return wsutil.WriteClientMessage(p.stream, ws.OpText, payload)
	}
	_, err := p.stream.Write(payload)
	return err
}

// read returns the next SIP message. UDP is one datagram, WS is one frame, and TCP is framed on
// Content-Length, which is why the buffer is kept on the phone.
func (p *phone) read() (*sip.Response, error) {
	deadline := time.Now().Add(20 * time.Second)
	if p.udp != nil {
		if err := p.udp.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		buffer := make([]byte, 8192)
		n, err := p.udp.Read(buffer)
		if err != nil {
			return nil, err
		}
		return p.parse(buffer[:n])
	}
	if err := p.stream.SetReadDeadline(deadline); err != nil {
		return nil, err
	}
	if p.isWS {
		payload, err := wsutil.ReadServerText(p.stream)
		if err != nil {
			return nil, err
		}
		return p.parse(payload)
	}
	for {
		if message, rest, ok := splitSIPMessage(p.pending); ok {
			p.pending = rest
			return p.parse(message)
		}
		buffer := make([]byte, 8192)
		n, err := p.stream.Read(buffer)
		if err != nil {
			return nil, err
		}
		p.pending = append(p.pending, buffer[:n]...)
	}
}

func (p *phone) parse(payload []byte) (*sip.Response, error) {
	message, err := p.parser.ParseSIP(payload)
	if err != nil {
		return nil, fmt.Errorf("parsing %q: %w", string(payload), err)
	}
	response, ok := message.(*sip.Response)
	if !ok {
		return nil, fmt.Errorf("received a %T, want a response", message)
	}
	return response, nil
}

// splitSIPMessage frames one message out of a TCP byte stream: headers to the blank line, then
// Content-Length bytes.
func splitSIPMessage(buffer []byte) ([]byte, []byte, bool) {
	head, _, found := bytes.Cut(buffer, []byte("\r\n\r\n"))
	if !found {
		return nil, buffer, false
	}
	length := 0
	for line := range strings.SplitSeq(string(head), "\r\n") {
		name, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "content-length", "l":
			if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				length = parsed
			}
		}
	}
	end := len(head) + 4 + length
	if len(buffer) < end {
		return nil, buffer, false
	}
	return buffer[:end], buffer[end:], true
}

// answer computes the digest response to a challenge.
func (p *phone) answer(response *sip.Response) (string, error) {
	header := response.GetHeader("WWW-Authenticate")
	if header == nil {
		return "", fmt.Errorf("a %d carried no challenge", response.StatusCode)
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		return "", err
	}
	p.nonceCount++
	credential, err := digest.Digest(challenge, digest.Options{
		Method: "REGISTER", URI: "sip:" + loadRealm,
		Username: p.user, Password: loadPass, Count: p.nonceCount, Cnonce: "0a4f113b",
	})
	if err != nil {
		return "", err
	}
	return credential.String(), nil
}

// registerOnce is the whole exchange one handset performs: challenge, answer, 200.
func (p *phone) registerOnce() error {
	challenge, err := p.register("")
	if err != nil {
		return err
	}
	if challenge.StatusCode != 401 {
		return fmt.Errorf("wanted a 401 challenge, got %d", challenge.StatusCode)
	}
	authorization, err := p.answer(challenge)
	if err != nil {
		return err
	}
	final, err := p.register(authorization)
	if err != nil {
		return err
	}
	if final.StatusCode != 200 {
		return fmt.Errorf("wanted a 200, got %d", final.StatusCode)
	}
	return nil
}

// loadPhones is how many distinct AORs the storm uses: a realistic mid-size tenant.
const loadPhones = 1000

// loadConcurrency is how many handsets are in flight at once. Not one goroutine per phone, which
// would measure the broker's admission burst rather than a fleet's steady rate.
const loadConcurrency = 64

// loadPasses is how many refresh passes each transport runs, from SIPD_LOAD_PASSES.
func loadPasses() int {
	if raw := strings.TrimSpace(os.Getenv("SIPD_LOAD_PASSES")); raw != "" {
		if passes, err := strconv.Atoi(raw); err == nil && passes > 0 {
			return passes
		}
	}
	return 1
}

// TestLoadRegisterStorm registers then refreshes a thousand distinct AORs over each of the three
// transports. Both passes are reported: the first is cold (credential-cache misses, KV Creates), the
// second is the refresh a deployment actually spends its life doing.
func TestLoadRegisterStorm(t *testing.T) {
	binary := requireLoad(t)
	ctx := t.Context()

	url := startLoadNATS(t, binary)
	edge := startLoadEdge(t, ctx, url)

	for _, transport := range []string{"udp", "tcp", "ws"} {
		t.Run(transport, func(t *testing.T) {
			phones := make([]*phone, loadPhones)
			for index := range phones {
				// The AOR space is shared across transports so the second and third exercise the
				// rebinding path, as a phone moving from wifi to LTE does.
				phones[index] = dialPhone(t, edge, transport, index)
			}

			profileRun(t, "register-storm-"+transport, func() {
				t.Log(runStorm(t, edge, phones, "cold"))
				// SIPD_LOAD_PASSES repeats the refresh pass so a CPU profile has enough samples.
				// Every pass is reported separately, since averaging would hide a run that slowed
				// as the KV bucket grew.
				for pass := range loadPasses() {
					t.Log(runStorm(t, edge, phones, fmt.Sprintf("refresh-%d", pass+1)))
				}
				t.Logf("credential RPCs served so far: %d for %d registrations",
					edge.creds.requests.Load(), (1+loadPasses())*len(phones))
			})
		})
	}
}

// runStorm drives every phone once through the challenge/answer exchange and reports the pass.
func runStorm(t *testing.T, edge *loadEdge, phones []*phone, label string) stats {
	t.Helper()

	samples := make([]sample, len(phones))
	failures := make([]error, len(phones))
	work := make(chan int)

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	natsBefore := edge.conn.Stats()
	start := time.Now()

	var group sync.WaitGroup
	for range loadConcurrency {
		group.Go(func() {
			for index := range work {
				began := time.Now()
				err := phones[index].registerOnce()
				samples[index] = sample(time.Since(began))
				failures[index] = err
			}
		})
	}
	for index := range phones {
		work <- index
	}
	close(work)
	group.Wait()

	wall := time.Since(start)
	natsAfter := edge.conn.Stats()
	runtime.ReadMemStats(&after)

	failed := 0
	var firstFailure error
	kept := samples[:0:0]
	for index, err := range failures {
		if err != nil {
			failed++
			if firstFailure == nil {
				firstFailure = err
			}
			continue
		}
		kept = append(kept, samples[index])
	}
	if failed > 0 {
		// A storm with failures measures a capacity limit, not throughput; reporting the surviving
		// requests' latency as throughput would be wrong, so fail loudly instead.
		t.Errorf("%s: %d of %d registrations failed; first: %v", label, failed, len(phones), firstFailure)
	}
	return summarize(label, kept, failed, wall, before, after, natsBefore, natsAfter)
}
