//go:build load

package sipd_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/command"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/invite"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/trunk"
)

const (
	loadInstanceID = "sipd-load-invite"
	loadSDP        = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\n" +
		"t=0 0\r\nm=audio 40000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
)

// inviteEdge is the INVITE surface on a real UDP socket, with a fake engine behind it.
type inviteEdge struct {
	addr        string
	conn        *nats.Conn
	engine      *fakeEngine
	instanceTok string
	// trunks is the directory the outbound path reads, exposed so the carrier scenario can install
	// a trunk without a control plane behind it.
	trunks *trunk.Directory
}

// fakeEngine answers rpc.sip.v1.invite and drives ring/answer back at sipd's command surface.
type fakeEngine struct {
	conn        *nats.Conn
	instanceTok string
	admissions  atomic.Int64

	// legs maps a SIP Call-ID to the leg id sipd minted for it, and legWaiters wakes a caller that
	// asked before the admission arrived. The leg id is on the admission request and never on the
	// wire, so this is how a synthetic UAC addresses its own ring and answer commands.
	mu         sync.Mutex
	legs       map[string]string
	legWaiters map[string]chan struct{}
}

// startFakeEngine admits every INVITE and answers ring/answer commands on demand.
func startFakeEngine(t *testing.T, url, instanceTok string) *fakeEngine {
	t.Helper()
	conn, err := nats.Connect(url, nats.Name("engine-load"))
	if err != nil {
		t.Fatalf("connecting the fake engine: %v", err)
	}
	t.Cleanup(conn.Close)

	engine := &fakeEngine{
		conn:        conn,
		instanceTok: instanceTok,
		legs:        make(map[string]string),
		legWaiters:  make(map[string]chan struct{}),
	}
	requests := make(chan *nats.Msg, 16384)
	subscription, err := conn.ChanQueueSubscribe(contract.SubjectSipInviteRPC, "engine", requests)
	if err != nil {
		t.Fatalf("subscribing to %s: %v", contract.SubjectSipInviteRPC, err)
	}
	t.Cleanup(func() { _ = subscription.Unsubscribe() })
	for range 32 {
		go func() {
			for msg := range requests {
				engine.admit(msg)
			}
		}()
	}

	// Draining sip.evt.v1 keeps the stream from filling and makes the scenario end to end.
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream for the fake engine: %v", err)
	}
	stream, err := js.Stream(t.Context(), contract.SIPStream.Name)
	if err != nil {
		t.Fatalf("binding the %s stream: %v", contract.SIPStream.Name, err)
	}
	consumer, err := stream.CreateOrUpdateConsumer(t.Context(), jetstream.ConsumerConfig{
		AckPolicy: jetstream.AckExplicitPolicy,
	})
	if err != nil {
		t.Fatalf("creating the engine consumer: %v", err)
	}
	consumed, err := consumer.Consume(func(msg jetstream.Msg) { _ = msg.Ack() })
	if err != nil {
		t.Fatalf("consuming sip.evt.v1: %v", err)
	}
	t.Cleanup(consumed.Stop)
	return engine
}

func (e *fakeEngine) admit(msg *nats.Msg) {
	e.admissions.Add(1)
	var request contract.SipInviteRequest
	if err := json.Unmarshal(msg.Data, &request); err != nil {
		_ = msg.Respond([]byte(`{"ok":false,"legId":"","reason":"bad_request"}`))
		return
	}
	e.recordLeg(request.SIPCallID, request.LegID)
	org, callID, instance := loadOrg, "call-"+request.LegID, "engine-load"
	routing, direction := "internal", contract.CallDirection("outbound")
	reply, _ := json.Marshal(contract.SipInviteResponse{
		Ok: true, LegID: request.LegID, OrgID: &org, CallID: &callID,
		InstanceID: &instance, RoutingContext: &routing, Direction: &direction,
	})
	_ = msg.Respond(reply)
}

func (e *fakeEngine) recordLeg(callID, legID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.legs[callID] = legID
	if waiter, waiting := e.legWaiters[callID]; waiting {
		close(waiter)
		delete(e.legWaiters, callID)
	}
}

// legFor blocks until the admission request for that Call-ID has been served.
func (e *fakeEngine) legFor(callID string, timeout time.Duration) (string, error) {
	e.mu.Lock()
	if legID, known := e.legs[callID]; known {
		e.mu.Unlock()
		return legID, nil
	}
	waiter, waiting := e.legWaiters[callID]
	if !waiting {
		waiter = make(chan struct{})
		e.legWaiters[callID] = waiter
	}
	e.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-waiter:
	case <-timer.C:
		return "", fmt.Errorf("no admission request arrived for Call-ID %s within %s", callID, timeout)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.legs[callID], nil
}

// ring and answer are the two commands that take a leg from 100 to 200.
func (e *fakeEngine) ring(legID string) error {
	payload, _ := json.Marshal(contract.SipRingRequest{LegID: legID, Status: 180})
	return e.command(contract.SubjectSipRingRPC, payload)
}

func (e *fakeEngine) answer(legID string) error {
	payload, _ := json.Marshal(contract.SipAnswerRequest{LegID: legID, SDPAnswer: loadSDP})
	return e.command(contract.SubjectSipAnswerRPC, payload)
}

func (e *fakeEngine) command(subject string, payload []byte) error {
	reply, err := e.conn.Request(subject+"."+e.instanceTok, payload, 5*time.Second)
	if err != nil {
		return fmt.Errorf("%s: %w", subject, err)
	}
	var outcome struct {
		Ok     bool    `json:"ok"`
		Reason *string `json:"reason"`
		Error  *string `json:"error"`
	}
	if err := json.Unmarshal(reply.Data, &outcome); err != nil {
		return err
	}
	if !outcome.Ok {
		return fmt.Errorf("%s refused: reason=%v error=%v", subject, outcome.Reason, outcome.Error)
	}
	return nil
}

// startInviteEdge wires the INVITE surface the way cmd/sipd does: two profiles, the dialog table,
// the NATS admission port, the command surface and the asynchronous event publisher.
func startInviteEdge(t *testing.T, ctx context.Context, url string, carrierCIDR string) *inviteEdge {
	t.Helper()

	conn, err := nats.Connect(url, nats.Name("sipd-load-invite"))
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	t.Cleanup(conn.Close)

	log := loadLogger()
	js, err := jetstream.New(conn,
		jetstream.WithPublishAsyncErrHandler(func(_ jetstream.JetStream, msg *nats.Msg, err error) {
			t.Errorf("a JetStream publish was not acknowledged on %s: %v", msg.Subject, err)
		}),
	)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}
	ensureLoadStreams(t, ctx, js)

	bindings, err := kv.Open(ctx, js)
	if err != nil {
		t.Fatalf("opening the registrations bucket: %v", err)
	}
	startCredentialResponderLoad(t, url, 0)
	credentialStore, err := credentials.NewNATSStore(conn, credentials.NATSOptions{})
	if err != nil {
		t.Fatalf("credentials.NewNATSStore: %v", err)
	}
	authenticator, err := registrar.NewAuthenticator(loadRealm, []byte("load-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	addr := "127.0.0.1:" + strconv.Itoa(loadUDPPort(t))
	listeners := []profile.Listener{{Network: "udp", Addr: addr}}
	profiles := []profile.Profile{profile.Internal("internal", listeners...)}
	if carrierCIDR != "" {
		entry, err := profile.ParseEntry(carrierCIDR, profile.ActionAllow, 0, "trunk-load", "load")
		if err != nil {
			t.Fatalf("profile.ParseEntry: %v", err)
		}
		carrierACL := profile.NewACL([]profile.Entry{entry})
		external := profile.External("external", carrierACL)
		external.Listeners = listeners
		profiles = append(profiles, external)
	}
	profileSet, err := profile.NewSet(profiles...)
	if err != nil {
		t.Fatalf("profile.NewSet: %v", err)
	}

	userAgent, err := sipgo.NewUA(sipgo.WithUserAgent("optimiq-sipd-load"))
	if err != nil {
		t.Fatalf("sipgo.NewUA: %v", err)
	}
	server, err := sipgo.NewServer(userAgent, sipgo.WithServerLogger(log))
	if err != nil {
		t.Fatalf("sipgo.NewServer: %v", err)
	}
	client, err := sipgo.NewClient(userAgent, sipgo.WithClientLogger(log))
	if err != nil {
		t.Fatalf("sipgo.NewClient: %v", err)
	}

	trunks := trunk.NewDirectory(log)
	requester, err := invite.NewClientRequester(client)
	if err != nil {
		t.Fatalf("NewClientRequester: %v", err)
	}
	caller, err := invite.NewClientCaller(client)
	if err != nil {
		t.Fatalf("NewClientCaller: %v", err)
	}
	port, err := invite.NewNATSPort(conn, invite.NATSOptions{})
	if err != nil {
		t.Fatalf("NewNATSPort: %v", err)
	}
	sink, err := invite.NewPublishingSink(sipevents.NewJetStreamPublisher(js), loadInstanceID, log)
	if err != nil {
		t.Fatalf("NewPublishingSink: %v", err)
	}

	dialogs := dialog.NewStore(dialog.StoreOptions{InstanceID: loadInstanceID})
	handler, err := invite.New(invite.Options{
		Realm:       loadRealm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Dialogs:     dialogs,
		Claims:      dialog.NewMemoryClaimStore(),
		Profiles:    profileSet,
		Port:        port,
		Requester:   requester,
		Caller:      caller,
		Bindings:    bindings,
		Trunks:      trunks,
		TrunkAuth:   trunk.NewNATSAuthorizer(conn),
		Responder:   server,
		Events:      sink,
		Contact:     sip.Uri{Scheme: "sip", User: "optimiq-sipd", Host: "127.0.0.1", Port: 5060},
		InstanceID:  loadInstanceID,
		Logger:      log,
		BaseContext: ctx,
		NewLegID:    contract.NewEventID,
	})
	if err != nil {
		t.Fatalf("invite.New: %v", err)
	}
	server.OnInvite(handler.ServeInvite)
	server.OnAck(handler.HandleAck)
	server.OnBye(handler.HandleBye)
	server.OnCancel(handler.HandleCancel)

	commands, err := command.NewServer(command.Options{
		Dialogs: handler, InstanceID: loadInstanceID, Logger: log,
	})
	if err != nil {
		t.Fatalf("command.NewServer: %v", err)
	}
	subscriptions, err := commands.Subscribe(conn)
	if err != nil {
		t.Fatalf("subscribing the command surface: %v", err)
	}
	t.Cleanup(func() {
		for _, subscription := range subscriptions {
			_ = subscription.Unsubscribe()
		}
	})
	if err := conn.FlushTimeout(5 * time.Second); err != nil {
		t.Fatalf("flushing the command subscriptions: %v", err)
	}

	ready := make(chan struct{}, 1)
	go func() {
		serveCtx := context.WithValue(ctx, sipgo.ListenReadyCtxKey, sipgo.ListenReadyCtxValue(ready))
		if err := server.ListenAndServe(serveCtx, "udp", addr); err != nil && serveCtx.Err() == nil {
			t.Errorf("udp listener: %v", err)
		}
	}()
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("the UDP listener never became ready")
	}
	t.Cleanup(func() {
		_ = server.Close()
		_ = client.Close()
		_ = userAgent.Close()
	})

	return &inviteEdge{addr: addr, conn: conn, instanceTok: commands.Token(), trunks: trunks}
}

// caller is one synthetic UAC placing one call over UDP.
type caller struct {
	user   string
	callID string
	tag    string
	conn   *net.UDPConn
	parser *sip.Parser
	cseq   int
	nc     int
	// contact and toTag are learned from the 200 and are what the ACK and the BYE are addressed to.
	toTag string
}

func dialCaller(t *testing.T, addr string, index int) *caller {
	t.Helper()
	remote, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatalf("resolving %s: %v", addr, err)
	}
	conn, err := net.DialUDP("udp", nil, remote)
	if err != nil {
		t.Fatalf("dialing udp: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	user := fmt.Sprintf("2%04d", index)
	return &caller{
		user:   user,
		callID: fmt.Sprintf("load-invite-%d-%d", index, time.Now().UnixNano()),
		tag:    "loadtag" + user,
		conn:   conn,
		parser: sip.NewParser(),
	}
}

func (c *caller) send(method, authorization, body string, extra ...string) error {
	c.cseq++
	local := c.conn.LocalAddr().String()
	target := "sip:3000@" + loadRealm
	lines := []string{
		method + " " + target + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKload%s%d;rport", local, c.user, c.cseq),
		"Max-Forwards: 70",
		"From: <sip:" + c.user + "@" + loadRealm + ">;tag=" + c.tag,
		"To: <" + target + ">" + toTagParam(c.toTag),
		"Call-ID: " + c.callID,
		"CSeq: " + strconv.Itoa(c.cseq) + " " + method,
		"Contact: <sip:" + c.user + "@" + local + ">",
		"User-Agent: sipd-load",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, extra...)
	if body != "" {
		lines = append(lines, "Content-Type: application/sdp",
			"Content-Length: "+strconv.Itoa(len(body)), "", body)
	} else {
		lines = append(lines, "Content-Length: 0", "", "")
	}
	_, err := c.conn.Write([]byte(strings.Join(lines, "\r\n")))
	return err
}

// ack repeats the INVITE's CSeq, per RFC 3261 §17.1.1.3.
func (c *caller) ack(inviteCSeq int) error {
	local := c.conn.LocalAddr().String()
	target := "sip:3000@" + loadRealm
	lines := []string{
		"ACK " + target + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKloadack%s%d;rport", local, c.user, inviteCSeq),
		"Max-Forwards: 70",
		"From: <sip:" + c.user + "@" + loadRealm + ">;tag=" + c.tag,
		"To: <" + target + ">" + toTagParam(c.toTag),
		"Call-ID: " + c.callID,
		"CSeq: " + strconv.Itoa(inviteCSeq) + " ACK",
		"Contact: <sip:" + c.user + "@" + local + ">",
		"Content-Length: 0", "", "",
	}
	_, err := c.conn.Write([]byte(strings.Join(lines, "\r\n")))
	return err
}

func toTagParam(tag string) string {
	if tag == "" {
		return ""
	}
	return ";tag=" + tag
}

// await reads responses until one with a status in [low, high] arrives.
func (c *caller) await(low, high int, deadline time.Duration) (*sip.Response, error) {
	stop := time.Now().Add(deadline)
	for {
		if err := c.conn.SetReadDeadline(stop); err != nil {
			return nil, err
		}
		buffer := make([]byte, 8192)
		n, err := c.conn.Read(buffer)
		if err != nil {
			return nil, err
		}
		message, err := c.parser.ParseSIP(buffer[:n])
		if err != nil {
			return nil, fmt.Errorf("parsing %q: %w", string(buffer[:n]), err)
		}
		response, ok := message.(*sip.Response)
		if !ok {
			continue
		}
		if response.StatusCode >= low && response.StatusCode <= high {
			if to := response.To(); to != nil {
				if tag, present := to.Params.Get("tag"); present {
					c.toTag = tag
				}
			}
			return response, nil
		}
	}
}

func (c *caller) answerChallenge(response *sip.Response, method string) (string, error) {
	header := response.GetHeader("WWW-Authenticate")
	if header == nil {
		return "", fmt.Errorf("a %d carried no challenge", response.StatusCode)
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		return "", err
	}
	c.nc++
	credential, err := digest.Digest(challenge, digest.Options{
		Method: method, URI: "sip:3000@" + loadRealm,
		Username: c.user, Password: loadPass, Count: c.nc, Cnonce: "0a4f113b",
	})
	if err != nil {
		return "", err
	}
	return credential.String(), nil
}

// loadDialogs is how many concurrent dialogs the lifecycle scenario runs.
const loadDialogs = 300

// TestLoadInviteLifecycle drives INVITE → 100 → 180 → 200 → ACK → BYE at loadDialogs concurrency,
// with a real request-reply engine half. It measures the whole exchange per dialog plus the
// goroutine and allocation cost each dialog left behind.
func TestLoadInviteLifecycle(t *testing.T) {
	binary := requireLoad(t)
	ctx := t.Context()
	url := startLoadNATS(t, binary)
	edge := startInviteEdge(t, ctx, url, "")
	edge.engine = startFakeEngine(t, url, edge.instanceTok)

	profileRun(t, "invite-lifecycle", func() {
		for pass := range loadPasses() {
			t.Log(runDialogs(t, edge, loadDialogs, fmt.Sprintf("dialogs-%d", pass+1)))
		}
	})

	// After teardown what remains is sipgo's transaction retention (Timer J / Timer I). A number
	// that keeps climbing across passes is a leak; one that settles is retention.
	settled := waitForGoroutines(60 * time.Second)
	t.Logf("goroutines after teardown: %d (admissions served: %d)", settled, edge.engine.admissions.Load())
}

func runDialogs(t *testing.T, edge *inviteEdge, count int, label string) stats {
	t.Helper()

	callers := make([]*caller, count)
	for index := range callers {
		callers[index] = dialCaller(t, edge.addr, index)
	}

	samples := make([]sample, count)
	failures := make([]error, count)

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	natsBefore := edge.conn.Stats()
	start := time.Now()

	var group sync.WaitGroup
	work := make(chan int)
	for range 64 {
		group.Go(func() {
			for index := range work {
				began := time.Now()
				failures[index] = runOneDialog(edge, callers[index])
				samples[index] = sample(time.Since(began))
			}
		})
	}
	for index := range callers {
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
		t.Errorf("%s: %d of %d dialogs failed; first: %v", label, failed, count, firstFailure)
	}
	return summarize(label, kept, failed, wall, before, after, natsBefore, natsAfter)
}

// runOneDialog is one whole call: challenge, INVITE, 100, engine-driven 180 and 200, ACK, BYE.
func runOneDialog(edge *inviteEdge, c *caller) error {
	if err := c.send("INVITE", "", loadSDP); err != nil {
		return err
	}
	challenge, err := c.await(401, 401, 10*time.Second)
	if err != nil {
		return fmt.Errorf("waiting for the challenge: %w", err)
	}
	authorization, err := c.answerChallenge(challenge, "INVITE")
	if err != nil {
		return err
	}
	// The challenged INVITE opens a new transaction, so the To tag from the 401 must not ride along.
	c.toTag = ""
	if err := c.send("INVITE", authorization, loadSDP); err != nil {
		return err
	}
	inviteCSeq := c.cseq
	if _, err := c.await(100, 100, 10*time.Second); err != nil {
		return fmt.Errorf("waiting for 100 Trying: %w", err)
	}

	legID, err := edge.engine.legFor(c.callID, 10*time.Second)
	if err != nil {
		return err
	}
	if err := edge.engine.ring(legID); err != nil {
		return err
	}
	if _, err := c.await(180, 189, 10*time.Second); err != nil {
		return fmt.Errorf("waiting for 180 Ringing: %w", err)
	}
	if err := edge.engine.answer(legID); err != nil {
		return err
	}
	final, err := c.await(200, 299, 10*time.Second)
	if err != nil {
		return fmt.Errorf("waiting for 200 OK: %w", err)
	}
	if final.StatusCode != 200 {
		return fmt.Errorf("wanted a 200, got %d", final.StatusCode)
	}
	if err := c.ack(inviteCSeq); err != nil {
		return err
	}
	if err := c.send("BYE", "", ""); err != nil {
		return err
	}
	bye, err := c.await(200, 499, 10*time.Second)
	if err != nil {
		return fmt.Errorf("waiting for the BYE response: %w", err)
	}
	if bye.StatusCode != 200 {
		return fmt.Errorf("wanted a 200 to the BYE, got %d", bye.StatusCode)
	}
	return nil
}

// waitForGoroutines polls until the count stops falling, so a teardown measurement is not taken
// while sipgo's transaction timers are still expiring.
func waitForGoroutines(limit time.Duration) int {
	deadline := time.Now().Add(limit)
	previous := runtime.NumGoroutine()
	stable := 0
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		current := runtime.NumGoroutine()
		if current >= previous {
			stable++
			if stable >= 4 {
				return current
			}
		} else {
			stable = 0
		}
		previous = current
	}
	return runtime.NumGoroutine()
}
