//go:build load

package sipd_test

import (
	"context"
	"encoding/json"
	"errors"
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

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/subscribe"
)

// Scenario 4: SUBSCRIBE/NOTIFY presence fan-out.
//
// loadWatchers busy-lamp subscribers spread over loadWatchedAORs extensions, then presence churn on
// the real `presence` bucket at a fixed rate. Every NOTIFY is correlated back to the change that
// caused it through the RFC 4235 `version` attribute, which the handler allocates once per
// subscription per change — so a shed notification is a missing sample rather than a wrong latency.

const (
	loadWatchers    = 500
	loadWatchedAORs = 5
	// loadChurnSeconds is how long each churn rate runs. Long enough for a rate to be a rate and
	// short enough that two of them plus profiling fit inside the suite's timeout.
	loadChurnSeconds = 8
)

// presenceEdge is the SUBSCRIBE/NOTIFY surface on a real UDP socket, with the registrar beside it
// (a SUBSCRIBE from an account with no live binding is refused 403, so the watchers must register
// first) and the real presence bucket behind it.
type presenceEdge struct {
	addr    string
	conn    *nats.Conn
	handler *subscribe.Handler
	bucket  jetstream.KeyValue
}

// startPresenceEdge wires registrar + subscribe onto one sipgo server, exactly as cmd/sipd does.
func startPresenceEdge(t *testing.T, ctx context.Context, url string) *presenceEdge {
	t.Helper()

	conn, err := nats.Connect(url, nats.Name("sipd-load-presence"))
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
	presenceStore, err := presence.Open(ctx, js)
	if err != nil {
		t.Fatalf("opening the presence bucket: %v", err)
	}
	bucket, err := js.KeyValue(ctx, contract.PresenceKV.Name)
	if err != nil {
		t.Fatalf("binding the presence bucket for the writer: %v", err)
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

	reg, err := registrar.New(registrar.Options{
		InstanceID:    "sipd-load-presence",
		Realm:         loadRealm,
		Auth:          authenticator,
		Credentials:   credentialStore,
		Bindings:      bindings,
		Publisher:     events.NewJetStreamPublisher(js),
		Logger:        log,
		Source:        "sipd",
		AllowEvents:   subscribe.AllowEvents,
		Expiry:        registrar.ExpiryPolicy{Min: time.Second, Max: time.Hour, Default: 300 * time.Second},
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
	client, err := sipgo.NewClient(userAgent, sipgo.WithClientLogger(log))
	if err != nil {
		t.Fatalf("sipgo.NewClient: %v", err)
	}
	notifier, err := subscribe.NewClientNotifier(client)
	if err != nil {
		t.Fatalf("NewClientNotifier: %v", err)
	}
	mwiSource, err := mwi.NewNATSSource(conn, log)
	if err != nil {
		t.Fatalf("mwi.NewNATSSource: %v", err)
	}

	addr := "127.0.0.1:" + strconv.Itoa(loadUDPPort(t))
	handler, err := subscribe.New(subscribe.Options{
		Realm:       loadRealm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Bindings:    bindings,
		Presence:    presenceStore,
		MWI:         mwiSource,
		Notifier:    notifier,
		Contact:     sip.Uri{Scheme: "sip", User: "optimiq-sipd", Host: "127.0.0.1", Port: 5060},
		Expiry: subscribe.ExpiryPolicy{
			Min: time.Second, Max: time.Hour, Default: 300 * time.Second,
		},
		Logger:        log,
		BaseContext:   ctx,
		AuthTimeout:   3 * time.Second,
		NotifyTimeout: 3 * time.Second,
		SweepInterval: 5 * time.Second,
		// SIPD_LOAD_NOTIFY_CONCURRENCY sweeps the fan-out bound so the default can be chosen from a
		// measurement rather than asserted. Unset takes the production default.
		NotifyConcurrency: envInt("SIPD_LOAD_NOTIFY_CONCURRENCY", 0),
	})
	if err != nil {
		t.Fatalf("subscribe.New: %v", err)
	}

	server.OnRegister(reg.HandleRegister)
	server.OnSubscribe(handler.HandleSubscribe)

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

	go func() { _ = reg.Run(ctx) }()
	go func() { _ = handler.Run(ctx) }()

	t.Cleanup(func() {
		_ = server.Close()
		_ = client.Close()
		_ = userAgent.Close()
	})
	return &presenceEdge{addr: addr, conn: conn, handler: handler, bucket: bucket}
}

// notification is one NOTIFY as the watcher saw it.
type notification struct {
	at time.Time
	// version is the RFC 4235 `version` attribute, which is this rig's correlator: the handler
	// allocates it in order, one per subscription per change, before the send goroutine starts.
	version int
	// resourceIndex says which watched extension the notification is about.
	resourceIndex int
}

// watcher is one synthetic BLF handset: it registers, subscribes to one extension's `dialog`
// package, answers the NOTIFYs sipd sends it, and timestamps each one.
//
// Unlike the register scenario's `phone` this socket is UNCONNECTED, because a NOTIFY is a new
// request from sipd's own client socket and a connected UDP socket would drop it.
type watcher struct {
	index         int
	user          string
	aor           string
	watched       string
	watchedAOR    string
	resourceIndex int

	conn   *net.UDPConn
	remote *net.UDPAddr
	parser *sip.Parser

	cseq       int
	nonceCount int
	callID     string
	tag        string

	responses chan *sip.Response
	// dialogTag is the To tag sipd minted for this subscription, learned from the 200. A refresh or
	// an unsubscribe MUST echo it (RFC 6665 §4.1.2.2) or it names a different dialog, which is a new
	// subscription rather than a change to this one.
	dialogTag string
	// baseVersion is the `version` this subscription's acceptance notification carried. The counter
	// is per subscription and advances once per change of the watched resource, so change number n
	// arrives as baseVersion+1+n — which is how a NOTIFY is matched to the write that caused it.
	baseVersion int

	// mu guards received: the reader goroutine appends and the measuring goroutine reads, and
	// without it the reader's appends are never published to the reader of the slice.
	mu       sync.Mutex
	received []notification
	// notifies counts arrivals live, so the rig can wait for the fan-out to drain.
	notifies atomic.Int64
	stop     chan struct{}
	done     chan struct{}
}

// record stores one arrival.
func (w *watcher) record(seen notification) {
	w.mu.Lock()
	w.received = append(w.received, seen)
	w.mu.Unlock()
	w.notifies.Add(1)
}

// take returns the arrivals so far and clears them.
func (w *watcher) take() []notification {
	w.mu.Lock()
	defer w.mu.Unlock()
	seen := w.received
	w.received = nil
	return seen
}

func dialWatcher(t *testing.T, edge *presenceEdge, index int) *watcher {
	t.Helper()
	remote, err := net.ResolveUDPAddr("udp", edge.addr)
	if err != nil {
		t.Fatalf("resolving %s: %v", edge.addr, err)
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("opening a watcher socket: %v", err)
	}
	resourceIndex := index % loadWatchedAORs
	user := fmt.Sprintf("3%04d", index)
	watched := watchedExtension(resourceIndex)
	w := &watcher{
		index:         index,
		user:          user,
		aor:           "sip:" + user + "@" + loadRealm,
		watched:       watched,
		watchedAOR:    "sip:" + watched + "@" + loadRealm,
		resourceIndex: resourceIndex,
		conn:          conn,
		remote:        remote,
		parser:        sip.NewParser(),
		callID:        "load-blf-" + user,
		tag:           "loadblf" + user,
		responses:     make(chan *sip.Response, 8),
		stop:          make(chan struct{}),
		done:          make(chan struct{}),
	}
	t.Cleanup(func() { _ = conn.Close() })
	go w.read()
	return w
}

// watchedExtension names the extension a watcher index watches. Deliberately a small set: a BLF
// wall is many phones watching a FEW busy extensions, and that shape is what makes the fan-out
// wide.
func watchedExtension(resourceIndex int) string { return fmt.Sprintf("4%03d", resourceIndex) }

func (w *watcher) close() {
	close(w.stop)
	_ = w.conn.SetReadDeadline(time.Now())
	<-w.done
}

// read is the watcher's only reader. Responses go to a channel the request goroutine reads;
// NOTIFYs are timestamped and answered 200 here, because an unanswered NOTIFY is retransmitted by
// sipd's transaction layer and would measure T1 rather than the fan-out.
func (w *watcher) read() {
	defer close(w.done)
	buffer := make([]byte, 8192)
	for {
		select {
		case <-w.stop:
			return
		default:
		}
		if err := w.conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			return
		}
		n, from, err := w.conn.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := errors.AsType[net.Error](err); ok && netErr.Timeout() {
				continue
			}
			return
		}
		at := time.Now()
		message, err := w.parser.ParseSIP(buffer[:n])
		if err != nil {
			continue
		}
		switch typed := message.(type) {
		case *sip.Response:
			select {
			case w.responses <- typed:
			default:
			}
		case *sip.Request:
			if typed.Method != sip.NOTIFY {
				continue
			}
			if version, ok := bodyVersion(typed.Body()); ok {
				w.record(notification{at: at, version: version, resourceIndex: w.resourceIndex})
			}
			res := sip.NewResponseFromRequest(typed, 200, "OK", nil)
			_, _ = w.conn.WriteToUDP([]byte(res.String()), from)
		}
	}
}

// bodyVersion reads the RFC 4235 `version` attribute out of a dialog-info body.
//
// The search starts at the `<dialog-info` element and not at the first `version="` in the document,
// because the XML declaration the handler prepends carries a `version="1.0"` of its own.
func bodyVersion(body []byte) (int, bool) {
	const element = `<dialog-info`
	const marker = `version="`
	document := string(body)
	root := strings.Index(document, element)
	if root < 0 {
		return 0, false
	}
	start := strings.Index(document[root:], marker)
	if start < 0 {
		return 0, false
	}
	rest := document[root+start+len(marker):]
	end := strings.IndexByte(rest, '"')
	if end < 0 {
		return 0, false
	}
	value, err := strconv.Atoi(rest[:end])
	if err != nil {
		return 0, false
	}
	return value, true
}

func (w *watcher) send(payload string) error {
	_, err := w.conn.WriteToUDP([]byte(payload), w.remote)
	return err
}

func (w *watcher) await(timeout time.Duration) (*sip.Response, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-w.responses:
		return res, nil
	case <-timer.C:
		return nil, fmt.Errorf("watcher %d timed out waiting for a response", w.index)
	}
}

func (w *watcher) local() string { return w.conn.LocalAddr().String() }

func (w *watcher) register(authorization string) (*sip.Response, error) {
	w.cseq++
	lines := []string{
		"REGISTER sip:" + loadRealm + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKblf%s%d;rport", w.local(), w.user, w.cseq),
		"Max-Forwards: 70",
		"From: <" + w.aor + ">;tag=" + w.tag,
		"To: <" + w.aor + ">",
		"Call-ID: " + w.callID,
		"CSeq: " + strconv.Itoa(w.cseq) + " REGISTER",
		"Contact: <sip:" + w.user + "@" + w.local() + ";transport=udp>",
		"User-Agent: sipd-load",
		"Expires: 300",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")
	if err := w.send(strings.Join(lines, "\r\n")); err != nil {
		return nil, err
	}
	return w.await(20 * time.Second)
}

func (w *watcher) registerOnce() error {
	challenge, err := w.register("")
	if err != nil {
		return err
	}
	if challenge.StatusCode != 401 {
		return fmt.Errorf("wanted a 401 challenge, got %d", challenge.StatusCode)
	}
	authorization, err := w.answer(challenge, "REGISTER", "sip:"+loadRealm)
	if err != nil {
		return err
	}
	final, err := w.register(authorization)
	if err != nil {
		return err
	}
	if final.StatusCode != 200 {
		return fmt.Errorf("wanted a 200 to the REGISTER, got %d", final.StatusCode)
	}
	return nil
}

// subscribeOnce runs the digest exchange and leaves one `dialog` subscription behind, or removes it
// when expires is zero.
func (w *watcher) subscribeOnce(expires int) error {
	challenge, err := w.subscribe("", expires)
	if err != nil {
		return err
	}
	if challenge.StatusCode != 401 {
		return fmt.Errorf("wanted a 401 challenge, got %d", challenge.StatusCode)
	}
	authorization, err := w.answer(challenge, "SUBSCRIBE", w.watchedAOR)
	if err != nil {
		return err
	}
	final, err := w.subscribe(authorization, expires)
	if err != nil {
		return err
	}
	if final.StatusCode != 200 {
		return fmt.Errorf("wanted a 200 to the SUBSCRIBE, got %d", final.StatusCode)
	}
	if to := final.To(); to != nil {
		if tag, present := to.Params.Get("tag"); present {
			w.dialogTag = tag
		}
	}
	return nil
}

func (w *watcher) subscribe(authorization string, expires int) (*sip.Response, error) {
	w.cseq++
	lines := []string{
		"SUBSCRIBE " + w.watchedAOR + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/UDP %s;branch=z9hG4bKblfsub%s%d;rport", w.local(), w.user, w.cseq),
		"Max-Forwards: 70",
		"From: <" + w.aor + ">;tag=" + w.tag,
		"To: <" + w.watchedAOR + ">" + toTagParam(w.dialogTag),
		"Call-ID: " + w.callID + "-sub",
		"CSeq: " + strconv.Itoa(w.cseq) + " SUBSCRIBE",
		"Contact: <sip:" + w.user + "@" + w.local() + ";transport=udp>",
		"Event: dialog",
		"Accept: application/dialog-info+xml",
		"Expires: " + strconv.Itoa(expires),
		"User-Agent: sipd-load",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")
	if err := w.send(strings.Join(lines, "\r\n")); err != nil {
		return nil, err
	}
	return w.await(20 * time.Second)
}

func (w *watcher) answer(response *sip.Response, method, uri string) (string, error) {
	header := response.GetHeader("WWW-Authenticate")
	if header == nil {
		return "", fmt.Errorf("a %d carried no challenge", response.StatusCode)
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		return "", err
	}
	w.nonceCount++
	credential, err := digest.Digest(challenge, digest.Options{
		Method: method, URI: uri,
		Username: w.user, Password: loadPass, Count: w.nonceCount, Cnonce: "0a4f113b",
	})
	if err != nil {
		return "", err
	}
	return credential.String(), nil
}

// churn writes presence transitions onto the real bucket at a fixed rate and records when each one
// was written, per watched extension. The returned slice is indexed by resource, then by change
// number for that resource — which is exactly what a NOTIFY's `version` attribute names.
func churn(
	t *testing.T,
	edge *presenceEdge,
	ctx context.Context,
	written [][]time.Time,
	perSecond int,
	duration time.Duration,
) (added int) {
	t.Helper()

	interval := time.Second / time.Duration(perSecond)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	deadline := time.Now().Add(duration)

	states := []contract.PresenceDeviceState{
		contract.PresenceDeviceStateRinging,
		contract.PresenceDeviceStateActive,
		contract.PresenceDeviceStateDown,
	}
	round := 0
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return added
		case <-ticker.C:
		}
		resource := round % loadWatchedAORs
		extension := watchedExtension(resource)
		key, err := contract.PresenceKVKey(loadOrg, extension)
		if err != nil {
			t.Fatalf("presence key: %v", err)
		}
		value, err := json.Marshal(contract.ExtensionPresence{
			OrgID: loadOrg, ExtensionNumber: extension,
			State:        states[round%len(states)],
			ChannelCount: round % 2,
			WrittenBy:    "load-rig",
			UpdatedAt:    time.Now().UnixMilli(),
		})
		if err != nil {
			t.Fatalf("encoding presence: %v", err)
		}
		// Timestamped BEFORE the Put: the measured latency includes the broker round trip the
		// engine's write costs, which is part of what a lamp waits for.
		written[resource] = append(written[resource], time.Now())
		if _, err := edge.bucket.Put(ctx, key, value); err != nil {
			t.Fatalf("writing presence: %v", err)
		}
		round++
		added++
	}
	return added
}

// TestLoadPresenceFanout subscribes loadWatchers busy-lamp watchers to loadWatchedAORs extensions
// and then churns presence at two rates, measuring NOTIFY latency, throughput, allocations and the
// goroutines the fan-out leaves behind.
func TestLoadPresenceFanout(t *testing.T) {
	binary := requireLoad(t)
	ctx := t.Context()
	url := startLoadNATS(t, binary)
	edge := startPresenceEdge(t, ctx, url)

	watchers := make([]*watcher, loadWatchers)
	for index := range watchers {
		watchers[index] = dialWatcher(t, edge, index)
	}
	t.Cleanup(func() {
		for _, w := range watchers {
			w.close()
		}
	})

	// Registration and subscription are setup, not the measurement: run them at bounded concurrency
	// so the credential RPC's 500 ms contract deadline is not the thing under test.
	setup := func(name string, run func(*watcher) error) {
		failures := make([]error, len(watchers))
		work := make(chan int)
		var group sync.WaitGroup
		for range 32 {
			group.Go(func() {
				for index := range work {
					failures[index] = run(watchers[index])
				}
			})
		}
		for index := range watchers {
			work <- index
		}
		close(work)
		group.Wait()
		for index, err := range failures {
			if err != nil {
				t.Fatalf("%s: watcher %d: %v", name, index, err)
			}
		}
	}
	setup("register", func(w *watcher) error { return w.registerOnce() })
	setup("subscribe", func(w *watcher) error { return w.subscribeOnce(300) })

	if held := edge.handler.Subscriptions(); held != loadWatchers {
		t.Fatalf("the handler holds %d subscriptions, want %d", held, loadWatchers)
	}
	// Every subscription is owed one full-state NOTIFY on acceptance (RFC 6665 §4.1.3). Let those
	// land before the churn starts so they are not counted as fan-out latency.
	waitForNotifies(watchers, loadWatchers, 30*time.Second)
	for _, w := range watchers {
		accepted := w.take()
		if len(accepted) == 0 {
			t.Fatalf("watcher %d never got the notification RFC 6665 §4.1.3 owes it", w.index)
		}
		w.baseVersion = accepted[len(accepted)-1].version
		w.notifies.Store(0)
	}

	baseline := runtime.NumGoroutine()
	t.Logf("goroutines with %d subscriptions established: %d", loadWatchers, baseline)

	// One change log for the whole test, for the same reason the version counter is cumulative.
	written := make([][]time.Time, loadWatchedAORs)
	for _, perSecond := range []int{50, 200} {
		name := fmt.Sprintf("churn-%dps", perSecond)
		profileRun(t, "presence-"+name, func() {
			t.Log(runChurn(t, edge, ctx, watchers, written, perSecond, name))
		})
		for _, w := range watchers {
			w.notifies.Store(0)
		}
	}

	steady := runtime.NumGoroutine()
	setup("unsubscribe", func(w *watcher) error { return w.subscribeOnce(0) })
	if held := edge.handler.Subscriptions(); held != 0 {
		t.Errorf("the handler still holds %d subscriptions after unsubscribe", held)
	}
	// Drain the terminal notifications before counting: sipgo holds a non-INVITE client transaction
	// for Timer K after its final response, so a count taken during the burst measures retention.
	if !edge.handler.Wait(30 * time.Second) {
		t.Error("the notification fan-out did not drain within 30s of the last unsubscribe")
	}
	settled := waitForGoroutines(60 * time.Second)
	t.Logf("goroutines: baseline %d, steady state after churn %d, after unsubscribe %d",
		baseline, steady, settled)
}

// waitForNotifies blocks until every watcher has seen at least want notifications, or the deadline
// passes.
func waitForNotifies(watchers []*watcher, want int, limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		total := int64(0)
		for _, w := range watchers {
			total += w.notifies.Load()
		}
		if total >= int64(want) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// runChurn drives one rate and reports it.
func runChurn(
	t *testing.T,
	edge *presenceEdge,
	ctx context.Context,
	watchers []*watcher,
	written [][]time.Time,
	perSecond int,
	label string,
) stats {
	t.Helper()

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	natsBefore := edge.conn.Stats()
	start := time.Now()

	// The version counter a NOTIFY carries is CUMULATIVE over the life of the subscription, so the
	// change log is too: `written` is appended to across rates rather than rebuilt, and version v on
	// a subscription is change v-2 of the resource it watches.
	before2 := make([]int, len(written))
	for resource, times := range written {
		before2[resource] = len(times)
	}
	churn(t, edge, ctx, written, perSecond, loadChurnSeconds*time.Second)

	expected, changes := 0, 0
	for resource, times := range written {
		fresh := len(times) - before2[resource]
		changes += fresh
		expected += fresh * watchersOf(watchers, resource)
	}
	// Drain: a notification still in flight when the churn stops is not a drop.
	waitForNotifies(watchers, expected, 20*time.Second)
	wall := time.Since(start)

	natsAfter := edge.conn.Stats()
	runtime.ReadMemStats(&after)

	samples := make([]sample, 0, expected)
	late := 0
	for _, w := range watchers {
		for _, seen := range w.take() {
			// The acceptance notification carried baseVersion; every change after it advances the
			// counter by one, so this names a change in the cumulative log for the watched resource.
			index := seen.version - w.baseVersion - 1
			times := written[seen.resourceIndex]
			if index < 0 || index >= len(times) {
				late++
				continue
			}
			samples = append(samples, sample(seen.at.Sub(times[index])))
		}
	}

	summary := summarize(label, samples, expected-len(samples), wall, before, after, natsBefore, natsAfter)
	t.Logf("%s: %d changes at %d/s over %d watchers; %d NOTIFYs expected, %d delivered (%.1f%%), "+
		"%d uncorrelated; %.0f NOTIFY/s delivered; %d shed by the fan-out bound",
		label, changes, perSecond, len(watchers), expected, len(samples),
		100*float64(len(samples))/float64(max(expected, 1)), late,
		float64(len(samples))/wall.Seconds(), edge.handler.Dropped())
	return summary
}

func watchersOf(watchers []*watcher, resource int) int {
	count := 0
	for _, w := range watchers {
		if w.resourceIndex == resource {
			count++
		}
	}
	return count
}
