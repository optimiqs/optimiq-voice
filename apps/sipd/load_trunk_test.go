//go:build load

package sipd_test

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/trunk"
)

// Scenario 3: an outbound carrier INVITE that is challenged.
//
// `rpc.sip.v1.originate` → INVITE to the carrier → 407 with a Proxy-Authenticate challenge →
// `rpc.sip.v1.trunk-credential` → re-INVITE carrying Proxy-Authorization → 180 → 200 → ACK. The
// carrier is a synthetic UAS on a real UDP socket; the credential resolver is a real NATS responder;
// everything between them is production code.

const (
	loadCarrierRealm  = "carrier.example.com"
	loadCarrierUser   = "optimiq-trunk"
	loadCarrierPass   = "carrier-s3cret"
	loadCarrierSecret = "secret/carrier/load"
	loadTrunkID       = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819999"
	// loadTrunkDialogs is the concurrency the scenario runs at, inside the brief's 100–300 band.
	loadTrunkDialogs = 200
	// loadTrunkWorkers is how many originates are in flight at once.
	loadTrunkWorkers = 64
)

// carrierHA1 is what the control plane would hold for the trunk credential.
func carrierHA1() string {
	sum := md5.Sum([]byte(loadCarrierUser + ":" + loadCarrierRealm + ":" + loadCarrierPass))
	return hex.EncodeToString(sum[:])
}

// fakeCarrier is a UAS that challenges every unauthenticated INVITE once and then answers.
//
// It speaks raw UDP rather than through sipgo, for the same reason the rig's handsets do: a peer
// built on the library under test hides the library's own costs, and a carrier that retransmits or
// answers slowly is a knob this rig wants.
type fakeCarrier struct {
	addr string
	conn *net.UDPConn

	challenges atomic.Int64
	authorized atomic.Int64
	acks       atomic.Int64
	// rejected counts re-INVITEs whose Proxy-Authorization did not name this carrier's realm,
	// nonce and user. A non-zero count means the retry path sent something a real carrier would
	// refuse, and the scenario fails rather than reporting a fast wrong answer.
	rejected atomic.Int64

	mu        sync.Mutex
	completed map[string]chan struct{}
	nonces    map[string]string

	parser *sip.Parser
	stop   chan struct{}
	done   chan struct{}
}

func startFakeCarrier(t *testing.T) *fakeCarrier {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatalf("opening the carrier socket: %v", err)
	}
	carrier := &fakeCarrier{
		addr:      conn.LocalAddr().String(),
		conn:      conn,
		completed: make(map[string]chan struct{}),
		nonces:    make(map[string]string),
		parser:    sip.NewParser(),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	go carrier.serve()
	t.Cleanup(func() {
		close(carrier.stop)
		_ = conn.SetReadDeadline(time.Now())
		<-carrier.done
		_ = conn.Close()
	})
	return carrier
}

func (c *fakeCarrier) serve() {
	defer close(c.done)
	buffer := make([]byte, 16384)
	for {
		select {
		case <-c.stop:
			return
		default:
		}
		if err := c.conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			return
		}
		n, from, err := c.conn.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := errors.AsType[net.Error](err); ok && netErr.Timeout() {
				continue
			}
			return
		}
		payload := make([]byte, n)
		copy(payload, buffer[:n])
		message, err := c.parser.ParseSIP(payload)
		if err != nil {
			continue
		}
		req, ok := message.(*sip.Request)
		if !ok {
			continue
		}
		c.handle(req, from)
	}
}

func (c *fakeCarrier) handle(req *sip.Request, from *net.UDPAddr) {
	callID := headerText(req, "Call-ID")
	switch req.Method {
	case sip.ACK:
		c.acks.Add(1)
		// Only the ACK that confirms the 2xx ends the call. The transaction layer also ACKs the 407,
		// with the same Call-ID and no dialog tag, and taking that one as completion would measure
		// the challenge instead of the whole retry.
		if to := req.To(); to != nil {
			if tag, present := to.Params.Get("tag"); present && tag == c.dialogTag(callID) {
				c.finish(callID)
			}
		}
	case sip.BYE:
		c.write(sip.NewResponseFromRequest(req, 200, "OK", nil), from)
	case sip.INVITE:
		if authorization := headerText(req, "Proxy-Authorization"); authorization != "" {
			if !c.accepts(callID, authorization) {
				c.rejected.Add(1)
				c.write(sip.NewResponseFromRequest(req, 403, "Forbidden", nil), from)
				return
			}
			c.authorized.Add(1)
			c.write(c.provisional(req, 100, "Trying"), from)
			c.write(c.tagged(req, 180, "Ringing", nil), from)
			c.write(c.tagged(req, 200, "OK", []byte(loadSDP)), from)
			return
		}
		c.challenges.Add(1)
		c.write(c.provisional(req, 100, "Trying"), from)
		c.write(c.challenge(req, callID), from)
	default:
		c.write(sip.NewResponseFromRequest(req, 405, "Method Not Allowed", nil), from)
	}
}

// challenge issues the 407 a carrier answers an unauthenticated INVITE with, and remembers the
// nonce so the retry can be checked against it.
func (c *fakeCarrier) challenge(req *sip.Request, callID string) *sip.Response {
	nonce := fmt.Sprintf("%s-%d", callID, time.Now().UnixNano())
	c.mu.Lock()
	c.nonces[callID] = nonce
	c.mu.Unlock()

	res := sip.NewResponseFromRequest(req, 407, "Proxy Authentication Required", nil)
	res.AppendHeader(sip.NewHeader("Proxy-Authenticate",
		fmt.Sprintf(`Digest realm="%s", nonce="%s", algorithm=MD5, qop="auth"`,
			loadCarrierRealm, nonce)))
	return res
}

// accepts checks the Proxy-Authorization names this carrier's realm, the nonce we issued for this
// call and the trunk's auth user. The digest response itself is verified by internal/trunk's unit
// suite; what this rig has to prove is that the retry carries the right identity for the right
// challenge, at load.
func (c *fakeCarrier) accepts(callID, authorization string) bool {
	credential, err := digest.ParseCredentials(authorization)
	if err != nil {
		return false
	}
	c.mu.Lock()
	nonce := c.nonces[callID]
	c.mu.Unlock()
	return credential.Realm == loadCarrierRealm &&
		credential.Nonce == nonce &&
		credential.Username == loadCarrierUser &&
		credential.Response != ""
}

func (c *fakeCarrier) provisional(req *sip.Request, status int, reason string) *sip.Response {
	return sip.NewResponseFromRequest(req, status, reason, nil)
}

// tagged builds a response that establishes the dialog: a To tag is what turns a provisional into
// an early dialog and a 2xx into a confirmed one (RFC 3261 §12.1.2).
func (c *fakeCarrier) tagged(req *sip.Request, status int, reason string, body []byte) *sip.Response {
	res := sip.NewResponseFromRequest(req, status, reason, body)
	if to := res.To(); to != nil {
		to.Params.Remove("tag")
		to.Params.Add("tag", c.dialogTag(headerText(req, "Call-ID")))
	}
	res.AppendHeader(&sip.ContactHeader{
		Address: sip.Uri{Scheme: "sip", User: "carrier", Host: "127.0.0.1", Port: c.port()},
	})
	if len(body) > 0 {
		res.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	return res
}

// dialogTag is the To tag this carrier answers a call with, derived from the Call-ID so the ACK
// that confirms the 2xx is identifiable without holding per-call state.
func (c *fakeCarrier) dialogTag(callID string) string { return "carrier" + callID }

func (c *fakeCarrier) port() int {
	return c.conn.LocalAddr().(*net.UDPAddr).Port
}

func (c *fakeCarrier) write(res *sip.Response, to *net.UDPAddr) {
	_, _ = c.conn.WriteToUDP([]byte(res.String()), to)
}

// expect registers interest in a call before it is placed, so an ACK that arrives first is not lost.
func (c *fakeCarrier) expect(callID string) chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	waiter, known := c.completed[callID]
	if !known {
		waiter = make(chan struct{})
		c.completed[callID] = waiter
	}
	return waiter
}

func (c *fakeCarrier) finish(callID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	waiter, known := c.completed[callID]
	if !known {
		waiter = make(chan struct{})
		c.completed[callID] = waiter
	}
	select {
	case <-waiter:
	default:
		close(waiter)
	}
}

func headerText(req *sip.Request, name string) string {
	header := req.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

// trunkCredentialResponder answers `rpc.sip.v1.trunk-credential` with the carrier's HA1, the way
// apps/api's secret resolver does. Counted, because a per-call credential RPC is exactly the kind
// of round trip this pass is looking for.
type trunkCredentialResponder struct {
	requests atomic.Int64
	// delay models a control plane that has to reach a secret manager. SIPD_LOAD_TRUNK_RPC_DELAY_MS
	// sets it, which is how the cost of resolving the carrier credential once per CALL is measured
	// against resolving it once per credential.
	delay time.Duration
}

func startTrunkCredentialResponder(t *testing.T, url string) *trunkCredentialResponder {
	t.Helper()
	conn, err := nats.Connect(url, nats.Name("sipd-load-trunk-credentials"))
	if err != nil {
		t.Fatalf("connecting the trunk credential responder: %v", err)
	}
	t.Cleanup(conn.Close)

	responder := &trunkCredentialResponder{
		delay: time.Duration(envInt("SIPD_LOAD_TRUNK_RPC_DELAY_MS", 0)) * time.Millisecond,
	}
	requests := make(chan *nats.Msg, 8192)
	subscription, err := conn.ChanSubscribe(contract.SubjectSipTrunkCredentialRPC, requests)
	if err != nil {
		t.Fatalf("subscribing to %s: %v", contract.SubjectSipTrunkCredentialRPC, err)
	}
	t.Cleanup(func() { _ = subscription.Unsubscribe() })

	for range 16 {
		go func() {
			for msg := range requests {
				responder.requests.Add(1)
				if responder.delay > 0 {
					time.Sleep(responder.delay)
				}
				var request contract.SipTrunkCredentialRequest
				if err := json.Unmarshal(msg.Data, &request); err != nil {
					_ = msg.Respond([]byte(`{"ok":false}`))
					continue
				}
				org, trunkID := request.OrgID, request.TrunkID
				username, realm := request.Username, request.Realm
				algorithm := contract.SipTrunkCredentialResponseAlgorithm(request.Algorithm)
				ha1 := carrierHA1()
				reply, _ := json.Marshal(contract.SipTrunkCredentialResponse{
					Ok: true, OrgID: &org, TrunkID: &trunkID, Username: &username,
					Realm: &realm, Algorithm: &algorithm, Ha1: &ha1,
				})
				_ = msg.Respond(reply)
			}
		}()
	}
	return responder
}

// installLoadTrunk puts one ip-auth carrier in the directory. `ip-auth` and not `register`: this
// scenario measures the INVITE's challenge/retry, and a registering trunk would additionally start
// a registration state machine that is not what is under test.
func installLoadTrunk(t *testing.T, edge *inviteEdge, carrier *fakeCarrier) {
	t.Helper()
	config := trunk.Config{
		TrunkID:   loadTrunkID,
		OrgID:     loadOrg,
		Name:      "load-carrier",
		Enabled:   true,
		Kind:      "ip-auth",
		SIPDomain: loadCarrierRealm,
		SIPProxy:  carrier.addr,
		Transport: "udp",
		AuthUser:  loadCarrierUser,
		AuthRealm: loadCarrierRealm,
		SecretRef: loadCarrierSecret,
	}
	key, err := contract.TrunkKVKey(loadOrg, loadTrunkID)
	if err != nil {
		t.Fatalf("trunk key: %v", err)
	}
	if err := edge.trunks.Put(key, config); err != nil {
		t.Fatalf("installing the load trunk: %v", err)
	}
}

// TestLoadTrunkInviteAuthRetry places loadTrunkDialogs outbound carrier calls, every one of them
// challenged, and measures the whole originate → 407 → credential → re-INVITE → 200 → ACK path.
func TestLoadTrunkInviteAuthRetry(t *testing.T) {
	binary := requireLoad(t)
	ctx := t.Context()
	url := startLoadNATS(t, binary)

	edge := startInviteEdge(t, ctx, url, "")
	edge.engine = startFakeEngine(t, url, edge.instanceTok)
	trunkCreds := startTrunkCredentialResponder(t, url)
	carrier := startFakeCarrier(t)
	installLoadTrunk(t, edge, carrier)

	profileRun(t, "trunk-invite-auth", func() {
		for pass := range loadPasses() {
			t.Log(runCarrierCalls(t, edge, carrier, fmt.Sprintf("carrier-%d", pass+1)))
		}
	})

	t.Logf("carrier: %d challenges issued, %d authorized INVITEs, %d ACKs, %d refused; "+
		"trunk credential RPCs served: %d",
		carrier.challenges.Load(), carrier.authorized.Load(), carrier.acks.Load(),
		carrier.rejected.Load(), trunkCreds.requests.Load())
	if refused := carrier.rejected.Load(); refused > 0 {
		t.Errorf("the carrier refused %d re-INVITEs: the retry did not carry a usable credential", refused)
	}
	t.Logf("goroutines after teardown: %d", waitForGoroutines(60*time.Second))
}

func runCarrierCalls(t *testing.T, edge *inviteEdge, carrier *fakeCarrier, label string) stats {
	t.Helper()

	samples := make([]sample, loadTrunkDialogs)
	failures := make([]error, loadTrunkDialogs)
	legs := make([]string, loadTrunkDialogs)

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	natsBefore := edge.conn.Stats()
	start := time.Now()

	var group sync.WaitGroup
	work := make(chan int)
	for range loadTrunkWorkers {
		group.Go(func() {
			for index := range work {
				legID := contract.NewEventID()
				legs[index] = legID
				began := time.Now()
				failures[index] = placeCarrierCall(edge, carrier, legID)
				samples[index] = sample(time.Since(began))
			}
		})
	}
	for index := range samples {
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
		t.Errorf("%s: %d of %d carrier calls failed; first: %v", label, failed, loadTrunkDialogs, firstFailure)
	}

	// Hang the answered legs up so the next pass starts from an empty dialog table. Untimed: it is
	// teardown, not the path under measurement.
	for index, err := range failures {
		if err == nil {
			hangupLeg(edge, legs[index])
		}
	}
	return summarize(label, kept, failed, wall, before, after, natsBefore, natsAfter)
}

// placeCarrierCall issues one originate and waits for the carrier to see the ACK that confirms it.
func placeCarrierCall(edge *inviteEdge, carrier *fakeCarrier, legID string) error {
	number := "+15550100"
	request := contract.SipOriginateRequest{
		LegID:  legID,
		OrgID:  loadOrg,
		CallID: "call-" + legID,
		Target: contract.SipOriginateRequestTarget{
			Kind:    contract.SipOriginateRequestTargetKindTrunk,
			TrunkID: new(loadTrunkID),
			Number:  &number,
		},
		SDPOffer: loadSDP,
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}
	reply, err := edge.conn.Request(contract.SubjectSipOriginateRPC, payload, 10*time.Second)
	if err != nil {
		return fmt.Errorf("originate RPC: %w", err)
	}
	var response contract.SipOriginateResponse
	if err := json.Unmarshal(reply.Data, &response); err != nil {
		return err
	}
	if !response.Ok || response.SIPCallID == nil {
		return fmt.Errorf("originate refused: reason=%v error=%v", response.Reason, response.Error)
	}

	waiter := carrier.expect(*response.SIPCallID)
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	select {
	case <-waiter:
		return nil
	case <-timer.C:
		return fmt.Errorf("no ACK reached the carrier for %s", *response.SIPCallID)
	}
}

func hangupLeg(edge *inviteEdge, legID string) {
	cause := 16
	payload, err := json.Marshal(contract.SipHangupRequest{LegID: legID, Cause: &cause})
	if err != nil {
		return
	}
	_, _ = edge.conn.Request(
		contract.SubjectSipHangupRPC+"."+edge.instanceTok, payload, 5*time.Second)
}
