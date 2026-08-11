package transfer_test

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/emiago/sipgo/siptest"
	"github.com/icholy/digest"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/transfer"
)

// The REFER vertical end to end inside one process: real digest (answered by github.com/icholy/digest,
// the CLIENT side of the same RFC), a real location service, a real parser, and fakes only at the two
// edges that are genuinely elsewhere — the broker and the socket.
//
// Two properties are worth the harness. That an unauthenticated or unregistered phone never reaches
// the broker at all. And that EVERY path after the 202 produces a final NOTIFY, because a handset
// that is accepted and then told nothing holds its transfer indicator until the dialog dies.

const (
	testRealm = "acme.example.com"
	testOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testUser  = "1001"
	testPass  = "s3cret"
	testAOR   = "sip:1001@acme.example.com"
	testCall  = "3c26700c1adf-6qgy0fkn7cvb"
)

// ---------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------

type fakeRequester struct {
	mu       sync.Mutex
	requests []contract.SipTransferRequest
	response contract.SipTransferResponse
	err      error
}

func (f *fakeRequester) Transfer(
	_ context.Context,
	request contract.SipTransferRequest,
) (contract.SipTransferResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, request)
	if f.err != nil {
		return contract.SipTransferResponse{}, f.err
	}
	response := f.response
	if response.SIPCallID == "" {
		response.SIPCallID = request.SIPCallID
	}
	return response, nil
}

func (f *fakeRequester) seen() []contract.SipTransferRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]contract.SipTransferRequest(nil), f.requests...)
}

type recordingNotifier struct {
	mu   sync.Mutex
	sent []*sip.Request
}

func (n *recordingNotifier) Notify(_ context.Context, req *sip.Request) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, req)
	return nil
}

func (n *recordingNotifier) frags() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	frags := make([]string, 0, len(n.sent))
	for _, req := range n.sent {
		frags = append(frags, strings.TrimSpace(string(req.Body())))
	}
	return frags
}

type staticCredentials struct {
	credential credentials.Credential
	err        error
}

func (s staticCredentials) Lookup(context.Context, string, string) (credentials.Credential, error) {
	if s.err != nil {
		return credentials.Credential{}, s.err
	}
	return s.credential, nil
}

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

type harness struct {
	t         *testing.T
	handler   *transfer.Handler
	requester *fakeRequester
	notifier  *recordingNotifier
	bindings  *kv.MemoryStore
	parser    *sip.Parser
	now       time.Time
	cseq      int
}

type harnessOptions struct {
	lookup      credentials.Store
	response    contract.SipTransferResponse
	requestErr  error
	unregistred bool
	expired     bool
}

func newHarness(t *testing.T, opts harnessOptions) *harness {
	t.Helper()

	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("test-nonce-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	h := &harness{
		t:         t,
		requester: &fakeRequester{response: opts.response, err: opts.requestErr},
		notifier:  &recordingNotifier{},
		bindings:  kv.NewMemoryStore(),
		parser:    sip.NewParser(),
		now:       time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC),
	}
	if h.requester.response.SIPCallID == "" && !h.requester.response.Ok && opts.requestErr == nil &&
		h.requester.response.Reason == nil {
		// The default: the engine did the transfer.
		h.requester.response = contract.SipTransferResponse{Ok: true, SIPCallID: testCall}
	}

	lookup := opts.lookup
	if lookup == nil {
		lookup = staticCredentials{credential: credentials.Credential{
			OrgID:       testOrg,
			Username:    testUser,
			Realm:       testRealm,
			HA1:         credentials.HA1(testUser, testRealm, testPass),
			DeviceID:    "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50",
			ExtensionID: "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51",
		}}
	}

	if !opts.unregistred {
		hash, err := contract.AORSubjectToken(testAOR)
		if err != nil {
			t.Fatalf("AORSubjectToken: %v", err)
		}
		expires := h.now.Add(5 * time.Minute)
		if opts.expired {
			expires = h.now.Add(-time.Second)
		}
		binding := kv.Binding{
			OrgID:        testOrg,
			AOR:          testAOR,
			AORHash:      hash,
			Contact:      "sip:1001@203.0.113.9:5060",
			Transport:    contract.SIPTransportUDP,
			RegisteredAt: contract.NewEventTime(h.now.Add(-time.Minute)),
			ExpiresAt:    contract.NewEventTime(expires),
		}
		if err := h.bindings.Put(context.Background(), binding); err != nil {
			t.Fatalf("seeding the binding: %v", err)
		}
	}

	handler, err := transfer.New(transfer.Options{
		Realm:       testRealm,
		Auth:        authenticator,
		Credentials: lookup,
		Bindings:    h.bindings,
		Transfers:   h.requester,
		Notifier:    h.notifier,
		Contact:     sip.Uri{Scheme: "sip", User: "optimiq-sipd", Host: "sipd.acme.example.com", Port: 5060},
		Logger:      slog.New(slog.DiscardHandler),
		Now:         func() time.Time { return h.now },
		NewTag:      func() string { return "sipdtag" },
	})
	if err != nil {
		t.Fatalf("transfer.New: %v", err)
	}
	h.handler = handler
	return h
}

// refer performs the full two-legged digest exchange and returns the FINAL response.
func (h *harness) refer(extra ...string) *sip.Response {
	h.t.Helper()
	challenge := h.send(h.newRefer("", extra...))
	if challenge.StatusCode != 401 {
		return challenge
	}
	return h.send(h.newRefer(h.answerChallenge(challenge, "REFER"), extra...))
}

func (h *harness) answerChallenge(res *sip.Response, method string) string {
	h.t.Helper()
	header := res.GetHeader("WWW-Authenticate")
	if header == nil {
		h.t.Fatal("401 carried no WWW-Authenticate header")
	}
	parsed, err := digest.ParseChallenge(header.Value())
	if err != nil {
		h.t.Fatalf("the challenge is not parsable by a real client: %v", err)
	}
	answer, err := digest.Digest(parsed, digest.Options{
		Method:   method,
		URI:      "sip:" + testRealm,
		Username: testUser,
		Password: testPass,
		Count:    1,
		Cnonce:   "0a4f113b",
	})
	if err != nil {
		h.t.Fatalf("computing the digest answer: %v", err)
	}
	return answer.String()
}

func (h *harness) newRefer(authorization string, extra ...string) *sip.Request {
	h.t.Helper()
	h.cseq++

	lines := []string{
		"REFER sip:" + testRealm + " SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK" + strings.Repeat("a", h.cseq) + ";rport",
		"Max-Forwards: 70",
		"From: <" + testAOR + ">;tag=fromtag",
		"To: <sip:+15551230000@" + testRealm + ">;tag=totag",
		"Call-ID: " + testCall,
		"CSeq: " + strconv.Itoa(h.cseq) + " REFER",
		"Contact: <sip:1001@203.0.113.9:5060>",
		"User-Agent: Yealink SIP-T46U 108.86.0.40",
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	if len(extra) == 0 {
		extra = []string{"Refer-To: <sip:1002@" + testRealm + ">"}
	}
	lines = append(lines, extra...)
	lines = append(lines, "Content-Length: 0", "", "")

	message, err := h.parser.ParseSIP([]byte(strings.Join(lines, "\r\n")))
	if err != nil {
		h.t.Fatalf("building the REFER: %v", err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		h.t.Fatalf("parsed a %T, want a request", message)
	}
	req.SetTransport("UDP")
	req.SetSource("203.0.113.9:5060")
	return req
}

func (h *harness) send(req *sip.Request) *sip.Response {
	h.t.Helper()
	tx := siptest.NewServerTxRecorder(req)
	h.handler.HandleRefer(req, tx)
	// The outcome report runs on its own goroutine so the 202 is not held behind the RPC; drain it
	// before asserting, exactly as the shutdown path does.
	if !h.handler.Wait(5 * time.Second) {
		h.t.Fatal("the outcome report did not finish")
	}
	results := tx.Result()
	if len(results) == 0 {
		h.t.Fatal("the handler produced no response; a transaction must always be answered")
	}
	return results[len(results)-1]
}

// ---------------------------------------------------------------------------------------------
// the accepted path
// ---------------------------------------------------------------------------------------------

func TestReferIsAcceptedAndReported(t *testing.T) {
	h := newHarness(t, harnessOptions{response: contract.SipTransferResponse{Ok: true}})

	res := h.refer()

	// 202, not 200: RFC 3515 §2.4.2 — "I will try and I will tell you".
	if res.StatusCode != 202 {
		t.Fatalf("status = %d, want 202", res.StatusCode)
	}
	if to := res.To(); to == nil || !to.Params.Has("tag") {
		t.Error("the 202 must carry a To tag; it is what establishes the subscription's dialog")
	}
	if frags := h.notifier.frags(); len(frags) != 2 ||
		frags[0] != transfer.FragTrying || frags[1] != transfer.FragOK {
		t.Errorf("sipfrags = %v, want [%q %q]", frags, transfer.FragTrying, transfer.FragOK)
	}
}

func TestReferSendsTheContractTheEngineExpects(t *testing.T) {
	h := newHarness(t, harnessOptions{response: contract.SipTransferResponse{Ok: true}})
	h.refer()

	seen := h.requester.seen()
	if len(seen) != 1 {
		t.Fatalf("issued %d requests, want 1", len(seen))
	}
	request := seen[0]

	// The tenant and the referrer come from the CREDENTIAL, not from the message.
	if request.OrgID != testOrg {
		t.Errorf("orgId = %q, want %q", request.OrgID, testOrg)
	}
	if request.ReferredBy.Username != testUser || request.ReferredBy.AOR != testAOR {
		t.Errorf("referredBy = %+v", request.ReferredBy)
	}
	if request.ReferredBy.ExtensionID == nil || request.ReferredBy.DeviceID == nil {
		t.Error("the inventory ids the credential carried must travel with the request")
	}
	// The dialog identity and the target come from the MESSAGE, verbatim.
	if request.SIPCallID != testCall {
		t.Errorf("sipCallId = %q, want %q", request.SIPCallID, testCall)
	}
	if request.Target.User != "1002" {
		t.Errorf("target = %q, want 1002", request.Target.User)
	}
	if request.Kind != contract.SipTransferRequestKindBlind {
		t.Errorf("kind = %q, want blind", request.Kind)
	}
	if request.Replaces != nil {
		t.Error("a REFER with no Replaces must not carry one")
	}
	if request.ReferCSeq == nil {
		t.Error("the REFER CSeq keys the implicit subscription and must travel")
	}
	if request.Transport == nil || *request.Transport != contract.SIPTransportUDP {
		t.Errorf("transport = %v, want udp", request.Transport)
	}
}

func TestReferCarriesAParsedReplacesForAnAttendedTransfer(t *testing.T) {
	h := newHarness(t, harnessOptions{response: contract.SipTransferResponse{Ok: true}})
	h.refer("Refer-To: <sip:1002@" + testRealm + "?Replaces=aa11%3Bto-tag%3Db2%3Bfrom-tag%3Dc3>")

	request := h.requester.seen()[0]
	if request.Kind != contract.SipTransferRequestKindAttended {
		t.Fatalf("kind = %q, want attended", request.Kind)
	}
	if request.Replaces == nil || request.Replaces.ToTag != "b2" || request.Replaces.FromTag != "c3" {
		t.Errorf("replaces = %+v", request.Replaces)
	}
}

// ---------------------------------------------------------------------------------------------
// the refusal paths — nothing here may reach the broker
// ---------------------------------------------------------------------------------------------

func TestReferWithoutCredentialsIsChallenged(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.send(h.newRefer("", "Refer-To: <sip:1002@"+testRealm+">"))

	if res.StatusCode != 401 {
		t.Fatalf("status = %d, want 401", res.StatusCode)
	}
	if res.GetHeader("WWW-Authenticate") == nil {
		t.Error("a 401 without a challenge is a dead end for the phone")
	}
	if len(h.requester.seen()) != 0 {
		t.Error("an unauthenticated REFER must never reach the broker")
	}
}

func TestReferWithAWrongPasswordIsRefusedOutright(t *testing.T) {
	// 403 and not another challenge: re-challenging a wrong password produces a loop some handsets
	// run forever.
	h := newHarness(t, harnessOptions{})
	challenge := h.send(h.newRefer("", "Refer-To: <sip:1002@"+testRealm+">"))
	parsed, err := digest.ParseChallenge(challenge.GetHeader("WWW-Authenticate").Value())
	if err != nil {
		t.Fatalf("ParseChallenge: %v", err)
	}
	answer, err := digest.Digest(parsed, digest.Options{
		Method: "REFER", URI: "sip:" + testRealm, Username: testUser, Password: "wrong",
		Count: 1, Cnonce: "0a4f113b",
	})
	if err != nil {
		t.Fatalf("Digest: %v", err)
	}

	res := h.send(h.newRefer(answer.String(), "Refer-To: <sip:1002@"+testRealm+">"))

	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("a failed digest must never reach the broker")
	}
}

func TestReferAuthenticatedAsSomebodyElseIsRefused(t *testing.T) {
	// The third-party-REFER hole: a valid account on the realm sending a REFER whose From names
	// another extension, so the engine would attribute the transfer to that extension.
	h := newHarness(t, harnessOptions{})
	challenge := h.send(h.newRefer("", "Refer-To: <sip:1002@"+testRealm+">"))
	authorization := h.answerChallenge(challenge, "REFER")

	req := h.newRefer(authorization, "Refer-To: <sip:1002@"+testRealm+">")
	req.From().Address.User = "2001"

	res := h.send(req)

	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("a REFER sent as somebody else must never reach the broker")
	}
}

func TestReferFromAnAccountWithNoLiveRegistrationIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{unregistred: true})

	res := h.refer()

	if res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("a REFER from a phone that is not on this network must never reach the broker")
	}
	if len(h.notifier.frags()) != 0 {
		t.Error("a refused REFER creates no subscription, so there is nothing to notify")
	}
}

func TestReferFromALapsedRegistrationIsRefused(t *testing.T) {
	// The sweeper has not reached it yet. Treating it as live would accept a REFER from a phone that
	// stopped refreshing minutes ago.
	h := newHarness(t, harnessOptions{expired: true})

	if res := h.refer(); res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("a lapsed binding must never reach the broker")
	}
}

func TestReferForADisabledAccountIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{lookup: staticCredentials{err: credentials.ErrDisabled}})

	if res := h.refer(); res.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("a disabled account must never reach the broker")
	}
}

func TestReferWithNoTargetIsABadRequest(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	// An authenticated REFER with no Refer-To at all. `Contact` stands in for the header so the
	// helper does not substitute its default.
	if res := h.refer("Allow: INVITE"); res.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("a malformed REFER must never reach the broker")
	}
}

func TestReferToASchemeThisEdgeWillNotDialIsNotImplemented(t *testing.T) {
	// 501 and not 400: the request is well formed, this element does not implement it.
	h := newHarness(t, harnessOptions{})

	if res := h.refer("Refer-To: <tel:+15551230000>"); res.StatusCode != 501 {
		t.Fatalf("status = %d, want 501", res.StatusCode)
	}
	if len(h.requester.seen()) != 0 {
		t.Error("an undialable target must never reach the broker")
	}
}

// ---------------------------------------------------------------------------------------------
// the reporting paths — every one of these must still notify
// ---------------------------------------------------------------------------------------------

func TestAnEngineRefusalIsReportedAs503(t *testing.T) {
	reason := contract.SipTransferResponseReasonCorrelationUnavailable
	h := newHarness(t, harnessOptions{response: contract.SipTransferResponse{
		Ok:     false,
		Reason: &reason,
	}})

	res := h.refer()

	// The 202 already went out; the refusal can only be reported in the sipfrag.
	if res.StatusCode != 202 {
		t.Fatalf("status = %d, want 202", res.StatusCode)
	}
	if frags := h.notifier.frags(); len(frags) != 2 || frags[1] != transfer.FragFailed {
		t.Errorf("sipfrags = %v, want the second to be %q", frags, transfer.FragFailed)
	}
}

func TestATimeoutIsReportedAs503TooRatherThanSilently(t *testing.T) {
	h := newHarness(t, harnessOptions{requestErr: errors.New("no responders")})

	if res := h.refer(); res.StatusCode != 202 {
		t.Fatalf("status = %d, want 202", res.StatusCode)
	}
	if frags := h.notifier.frags(); len(frags) != 2 || frags[1] != transfer.FragFailed {
		t.Errorf("sipfrags = %v, want the second to be %q", frags, transfer.FragFailed)
	}
}

func TestTheNotificationsCarryTheSubscriptionTheReferCreated(t *testing.T) {
	h := newHarness(t, harnessOptions{response: contract.SipTransferResponse{Ok: true}})
	h.refer()

	h.notifier.mu.Lock()
	sent := append([]*sip.Request(nil), h.notifier.sent...)
	h.notifier.mu.Unlock()

	if len(sent) != 2 {
		t.Fatalf("sent %d notifications, want 2", len(sent))
	}

	first, last := sent[0], sent[1]
	if got := headerOf(t, first, "Event"); got != "refer;id=2" {
		// The REFER that carried credentials is the SECOND request in the exchange, CSeq 2.
		t.Errorf("Event = %q, want refer;id=2", got)
	}
	if got := headerOf(t, first, "Subscription-State"); got != "active;expires=60" {
		t.Errorf("first Subscription-State = %q, want active;expires=60", got)
	}
	if got := headerOf(t, last, "Subscription-State"); got != "terminated;reason=noresource" {
		t.Errorf("final Subscription-State = %q, want terminated;reason=noresource", got)
	}
	if got := headerOf(t, first, "Content-Type"); got != "message/sipfrag;version=2.0" {
		t.Errorf("Content-Type = %q", got)
	}

	// A notification travels the other way, so the REFER's To becomes our From and vice versa.
	if from := last.From(); from == nil || from.Address.User != "+15551230000" {
		t.Errorf("From = %v, want the REFER's To address", last.From())
	}
	if to := last.To(); to == nil || to.Address.User != testUser {
		t.Errorf("To = %v, want the referrer", last.To())
	}
	if tag, _ := last.To().Params.Get("tag"); tag != "fromtag" {
		t.Errorf("To tag = %q, want the referrer's own tag", tag)
	}
	if tag, _ := last.From().Params.Get("tag"); tag != "totag" {
		t.Errorf("From tag = %q, want the tag from the REFER's To header", tag)
	}
	if callID := last.CallID(); callID == nil || callID.Value() != testCall {
		t.Errorf("Call-ID = %v, want the dialog's own", last.CallID())
	}
	// Within one subscription the CSeq must increase, or the phone reads the second notification as
	// a retransmission of the first and never learns the outcome.
	if first.CSeq().SeqNo >= last.CSeq().SeqNo {
		t.Errorf("CSeq did not advance: %d then %d", first.CSeq().SeqNo, last.CSeq().SeqNo)
	}
	// The body must end in CRLF; several handsets reject a sipfrag without it.
	if !strings.HasSuffix(string(last.Body()), "\r\n") {
		t.Errorf("body = %q, want a trailing CRLF", string(last.Body()))
	}
	// Addressed at the observed source, which for a phone behind NAT is the only address that works.
	if last.Destination() != "203.0.113.9:5060" {
		t.Errorf("destination = %q, want the observed source", last.Destination())
	}
}

func TestBuildNotifyMintsATagWhenTheReferHadNoToTag(t *testing.T) {
	// A REFER outside a dialog carries no To tag, so the 202 is what establishes one — and it has to
	// be OURS, because we are the side answering.
	h := newHarness(t, harnessOptions{response: contract.SipTransferResponse{Ok: true}})

	challenge := h.send(h.newRefer("", "Refer-To: <sip:1002@"+testRealm+">"))
	req := h.newRefer(h.answerChallenge(challenge, "REFER"), "Refer-To: <sip:1002@"+testRealm+">")
	req.To().Params.Remove("tag")

	res := h.send(req)

	if tag, _ := res.To().Params.Get("tag"); tag != "sipdtag" {
		t.Errorf("202 To tag = %q, want the one this edge minted", tag)
	}
	h.notifier.mu.Lock()
	defer h.notifier.mu.Unlock()
	last := h.notifier.sent[len(h.notifier.sent)-1]
	if tag, _ := last.From().Params.Get("tag"); tag != "sipdtag" {
		t.Errorf("NOTIFY From tag = %q, want the same tag the 202 carried", tag)
	}
}

func TestDiscardNotifierIsAValidChoice(t *testing.T) {
	// The deployment with no SIP client: transfers still work, phones simply never learn the outcome.
	if err := (transfer.DiscardNotifier{}).Notify(context.Background(), nil); err != nil {
		t.Errorf("DiscardNotifier.Notify: %v", err)
	}
}

func headerOf(t *testing.T, req *sip.Request, name string) string {
	t.Helper()
	header := req.GetHeader(name)
	if header == nil {
		t.Fatalf("the NOTIFY carried no %s header", name)
	}
	return header.Value()
}
