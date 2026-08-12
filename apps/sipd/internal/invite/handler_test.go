package invite_test

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/invite"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// The INVITE path, driven through the real handler with real digest credentials and sipgo's own
// transaction recorder. The requests are parsed from wire text and the responses are produced by
// sipgo, so these exercise header parsing and response assembly rather than a Go-level mock of
// them — the same shape the registrar's tests already have.

const (
	testRealm = "acme.example.com"
	testOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testUser  = "1001"
	testPass  = "s3cret"
	// Written with bare LF and converted to CRLF alongside the headers, so the Content-Length below
	// counts what actually goes on the wire. A body written with CRLF and then converted would grow
	// a second CR per line and be truncated by the parser — which is a bug this test would then be
	// asserting rather than catching.
	testSDP = "v=0\no=- 1 1 IN IP4 192.168.1.42\ns=-\nc=IN IP4 192.168.1.42\n" +
		"t=0 0\nm=audio 40000 RTP/AVP 0\n"
)

// crlf renders a bare-LF fixture the way it appears on the wire.
func crlf(value string) string { return strings.ReplaceAll(value, "\n", "\r\n") }

type harness struct {
	t        *testing.T
	handler  *invite.Handler
	dialogs  *dialog.Store
	claims   *dialog.MemoryClaimStore
	port     *invite.FakePort
	requests *recordingRequester
	parser   *sip.Parser
	cseq     int
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

// recordingRequester captures the requests this edge originates, so a BYE can be asserted without a
// socket — and so the fake is forced to speak sip.Request rather than a summary of one.
type recordingRequester struct {
	sent []*sip.Request
}

func (r *recordingRequester) Send(_ context.Context, req *sip.Request) error {
	r.sent = append(r.sent, req)
	return nil
}

type harnessOptions struct {
	port     *invite.FakePort
	profiles *profile.Set
	timers   dialog.TimerPolicy
	lookup   credentials.Store
}

func newHarness(t *testing.T, opts harnessOptions) *harness {
	t.Helper()

	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("test-nonce-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	if opts.lookup == nil {
		opts.lookup = staticCredentials{credential: credentials.Credential{
			OrgID:       testOrg,
			Username:    testUser,
			Realm:       testRealm,
			HA1:         credentials.HA1(testUser, testRealm, testPass),
			ExtensionID: "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51",
		}}
	}
	if opts.profiles == nil {
		set, err := profile.NewSet(profile.Internal("internal",
			profile.Listener{Network: "udp", Addr: "0.0.0.0:5060"}))
		if err != nil {
			t.Fatalf("NewSet: %v", err)
		}
		opts.profiles = set
	}
	if opts.port == nil {
		opts.port = &invite.FakePort{}
	}

	h := &harness{
		t:        t,
		dialogs:  dialog.NewStore(dialog.StoreOptions{InstanceID: "sipd-test"}),
		claims:   dialog.NewMemoryClaimStore(),
		port:     opts.port,
		requests: &recordingRequester{},
		parser:   sip.NewParser(),
	}

	legs := 0
	handler, err := invite.New(invite.Options{
		Realm:       testRealm,
		Auth:        authenticator,
		Credentials: opts.lookup,
		Dialogs:     h.dialogs,
		Claims:      h.claims,
		Profiles:    opts.profiles,
		Port:        opts.port,
		Requester:   h.requests,
		Contact:     sip.Uri{Scheme: "sip", User: "optimiq-sipd", Host: testRealm, Port: 5060},
		InstanceID:  "sipd-test",
		Timers:      opts.timers,
		NewLegID: func() string {
			legs++
			return "leg-" + strconv.Itoa(legs)
		},
		NewTag:       func() string { return "edge-tag" },
		AdmitTimeout: time.Second,
		RingTimeout:  time.Minute,
	})
	if err != nil {
		t.Fatalf("invite.New: %v", err)
	}
	h.handler = handler
	return h
}

func (h *harness) parse(wire string) *sip.Request {
	h.t.Helper()
	message, err := h.parser.ParseSIP([]byte(strings.ReplaceAll(wire, "\n", "\r\n")))
	if err != nil {
		h.t.Fatalf("parsing: %v", err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		h.t.Fatalf("parsed a %T", message)
	}
	req.SetSource("203.0.113.7:41234")
	req.SetTransport("UDP")
	return req
}

// invite builds an INVITE, optionally answering a digest challenge.
func (h *harness) invite(challenge *digest.Challenge, extra ...string) *sip.Request {
	h.t.Helper()
	h.cseq++
	headers := ""
	for _, header := range extra {
		headers += header + "\n"
	}
	wire := "INVITE sip:1002@" + testRealm + " SIP/2.0\n" +
		"Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bK" + strconv.Itoa(h.cseq) + ";rport\n" +
		"From: \"Ada\" <sip:1001@" + testRealm + ">;tag=caller-tag\n" +
		"To: <sip:1002@" + testRealm + ">\n" +
		"Call-ID: call-" + strconv.Itoa(h.cseq) + "@pc33\n" +
		"CSeq: " + strconv.Itoa(h.cseq) + " INVITE\n" +
		"Contact: <sip:1001@192.168.1.42:5060>\n" +
		"User-Agent: Yealink SIP-T46U\n" +
		headers +
		"Content-Type: application/sdp\n" +
		"Content-Length: " + strconv.Itoa(len(crlf(testSDP))) + "\n\n" + testSDP
	req := h.parse(wire)
	if challenge != nil {
		credential, err := digest.Digest(challenge, digest.Options{
			Method:   "INVITE",
			URI:      req.Recipient.String(),
			Username: testUser,
			Password: testPass,
			Count:    1,
			Cnonce:   "0a4f113b",
		})
		if err != nil {
			h.t.Fatalf("digest: %v", err)
		}
		req.AppendHeader(sip.NewHeader("Authorization", credential.String()))
	}
	return req
}

func (h *harness) send(handle func(*sip.Request, sip.ServerTransaction), req *sip.Request) []*sip.Response {
	h.t.Helper()
	tx := newRecordingTx()
	handle(req, tx)
	return tx.responses()
}

// recordingTx is a sip.ServerTransaction that records what was written to it.
//
// # Why not sipgo's own siptest.ServerTxRecorder
//
// That recorder drives a real transaction FSM whose retransmission timer writes into an
// unsynchronised slice, so reading its result while the timer is armed is a data race that
// `go test -race` reports inside sipgo rather than inside anything this repository owns. It is a
// pre-existing condition — the registrar's suite has it too — and it is not worth inheriting here.
//
// This fake records instead of retransmitting, which is also more honest about what these tests
// assert: they are about which responses the HANDLER decided to write, not about the transaction
// layer's timers, which sipgo already tests.
type recordingTx struct {
	mu       sync.Mutex
	written  []*sip.Response
	cancels  []func(*sip.Request)
	acks     chan *sip.Request
	done     chan struct{}
	closeOne sync.Once
}

var _ sip.ServerTransaction = (*recordingTx)(nil)

func newRecordingTx() *recordingTx {
	return &recordingTx{acks: make(chan *sip.Request, 1), done: make(chan struct{})}
}

func (tx *recordingTx) Respond(res *sip.Response) error {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	tx.written = append(tx.written, res)
	return nil
}

func (tx *recordingTx) responses() []*sip.Response {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	return append([]*sip.Response(nil), tx.written...)
}

// cancel fires the OnCancel hook the handler installed, which is how a test drives the CANCEL that
// sipgo's transaction layer would otherwise deliver.
func (tx *recordingTx) cancel(req *sip.Request) {
	tx.mu.Lock()
	hooks := make([]func(*sip.Request), len(tx.cancels))
	copy(hooks, tx.cancels)
	tx.mu.Unlock()
	for _, hook := range hooks {
		hook(req)
	}
}

func (tx *recordingTx) Acks() <-chan *sip.Request { return tx.acks }

func (tx *recordingTx) OnCancel(f sip.FnTxCancel) bool {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	tx.cancels = append(tx.cancels, f)
	return true
}

func (tx *recordingTx) OnTerminate(sip.FnTxTerminate) bool { return true }

func (tx *recordingTx) Terminate() { tx.closeOne.Do(func() { close(tx.done) }) }

func (tx *recordingTx) Done() <-chan struct{} { return tx.done }

func (tx *recordingTx) Err() error { return nil }

func statuses(responses []*sip.Response) []int {
	codes := make([]int, 0, len(responses))
	for _, res := range responses {
		codes = append(codes, res.StatusCode)
	}
	return codes
}

func lastStatus(t *testing.T, responses []*sip.Response) int {
	t.Helper()
	if len(responses) == 0 {
		t.Fatal("no response at all: a refusal is always a reply, never a silence")
	}
	return responses[len(responses)-1].StatusCode
}

// challengeFrom reads the WWW-Authenticate off a 401 so the next request can answer it.
func challengeFrom(t *testing.T, res *sip.Response) *digest.Challenge {
	t.Helper()
	header := res.GetHeader("WWW-Authenticate")
	if header == nil {
		t.Fatal("a 401 with no challenge is an instruction the phone cannot follow")
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		t.Fatalf("ParseChallenge: %v", err)
	}
	return challenge
}

// The whole admitted path: challenge, digest, 100 Trying, and an intent the engine can act on.
func TestInviteIsChallengedThenAdmitted(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	first := h.send(h.handler.HandleInvite, h.invite(nil))
	if lastStatus(t, first) != 401 {
		t.Fatalf("statuses = %v, want a 401 challenge", statuses(first))
	}

	second := h.send(h.handler.HandleInvite, h.invite(challengeFrom(t, first[len(first)-1])))
	if lastStatus(t, second) != 100 {
		t.Fatalf("statuses = %v, want the 100 and nothing else: the call is now the engine's", statuses(second))
	}

	intent, found := h.port.Last()
	if !found {
		t.Fatal("the admission request must reach the port")
	}
	switch {
	case intent.LegID != "leg-1":
		t.Errorf("legId = %q", intent.LegID)
	case intent.OrgID != testOrg:
		t.Errorf("orgId = %q, want the credential's tenant", intent.OrgID)
	case intent.Authentication != invite.AuthenticationDigest:
		t.Errorf("authentication = %q", intent.Authentication)
	case intent.RoutingContext != profile.ContextInternal:
		t.Errorf("routingContext = %q, want internal for a digest", intent.RoutingContext)
	case intent.From.Number != "1001" || intent.To.Number != "1002":
		t.Errorf("parties = %+v / %+v", intent.From, intent.To)
	case intent.From.AOR != "sip:1001@acme.example.com":
		t.Errorf("from.aor = %q, want it rebuilt from the credential", intent.From.AOR)
	case intent.From.Name != "Ada":
		t.Errorf("from.name = %q", intent.From.Name)
	case !intent.HasOffer || intent.SDPOffer != crlf(testSDP):
		t.Error("the offer must travel verbatim: the engine is the courier for it")
	case intent.SourceAddress != "203.0.113.7:41234":
		t.Errorf("sourceAddress = %q", intent.SourceAddress)
	case intent.InstanceID != "sipd-test":
		t.Errorf("instanceId = %q", intent.InstanceID)
	case intent.Profile != "internal":
		t.Errorf("profile = %q", intent.Profile)
	}

	// The far end advertises a private media address from a public source, which is the evidence
	// mediad needs to expect a latch rather than be surprised by one.
	if !intent.MediaHint.Mismatch || !intent.MediaHint.Private {
		t.Errorf("mediaHint = %+v, want a mismatch on a private address", intent.MediaHint)
	}

	// The dialog exists, is claimed, and carries what the engine resolved.
	if h.dialogs.Len() != 1 {
		t.Fatalf("dialogs = %d, want 1", h.dialogs.Len())
	}
	claims, _ := h.claims.All(context.Background())
	if len(claims) != 1 || claims[0].LegID != "leg-1" || claims[0].Role != "uas" {
		t.Fatalf("claims = %+v", claims)
	}
	if claims[0].SIPCallID == "" || claims[0].LocalTag != "edge-tag" {
		t.Errorf("the claim must carry the dialog triple, got %+v", claims[0])
	}
}

// An account may only call AS ITSELF. Without this any valid account on the realm could place a
// call carrying somebody else's From and have the engine attribute it to them.
func TestInviteAsSomebodyElseIsForbidden(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	req := h.invite(challenge)
	if from := req.From(); from != nil {
		from.Address.User = "1099"
	}
	if got := lastStatus(t, h.send(h.handler.HandleInvite, req)); got != 403 {
		t.Errorf("status = %d, want 403", got)
	}
	if len(h.port.Requests()) != 0 {
		t.Error("an unauthenticated caller must not reach the broker")
	}
}

func TestInviteWithAnUnknownAccountIsForbidden(t *testing.T) {
	h := newHarness(t, harnessOptions{
		lookup: staticCredentials{err: credentials.ErrNotFound},
	})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	if got := lastStatus(t, h.send(h.handler.HandleInvite, h.invite(challenge))); got != 403 {
		t.Errorf("status = %d, want 403", got)
	}
}

// Every refusal reason must become a status a STRANGER can act on.
func TestEngineRefusalsMapToStatuses(t *testing.T) {
	cases := []struct {
		reason invite.RefusalReason
		status int
	}{
		{invite.ReasonUnattributed, 404},
		{invite.ReasonUnknownTarget, 404},
		{invite.ReasonNotPermitted, 403},
		{invite.ReasonCongestion, 503},
		{invite.ReasonShuttingDown, 503},
		{invite.ReasonBadRequest, 400},
		{invite.ReasonInternal, 500},
		{invite.RefusalReason("something-new"), 500},
	}
	for _, tc := range cases {
		t.Run(string(tc.reason), func(t *testing.T) {
			port := &invite.FakePort{Answer: func(intent invite.CallIntent) (invite.Admission, error) {
				return invite.Admission{LegID: intent.LegID, Reason: tc.reason}, nil
			}}
			h := newHarness(t, harnessOptions{port: port})
			first := h.send(h.handler.HandleInvite, h.invite(nil))
			responses := h.send(h.handler.HandleInvite, h.invite(challengeFrom(t, first[len(first)-1])))

			if got := lastStatus(t, responses); got != tc.status {
				t.Errorf("statuses = %v, want a final %d", statuses(responses), tc.status)
			}
			if h.dialogs.Len() != 0 {
				t.Error("a refused call must leave no dialog behind")
			}
			claims, _ := h.claims.All(context.Background())
			if len(claims) != 0 {
				t.Errorf("a refused call must leave no claim behind, got %+v", claims)
			}
		})
	}
}

// A silent engine leaves this edge holding an INVITE transaction until the caller's Timer B, and the
// caller hears thirty-two seconds of nothing. So the edge answers on its own authority — with a
// Retry-After, which is what makes a carrier fail over instead of retrying here.
func TestASilentEngineIsAnsweredOnOurOwnAuthority(t *testing.T) {
	port := &invite.FakePort{Answer: func(invite.CallIntent) (invite.Admission, error) {
		return invite.Admission{}, errors.New("no responders")
	}}
	h := newHarness(t, harnessOptions{port: port})

	first := h.send(h.handler.HandleInvite, h.invite(nil))
	responses := h.send(h.handler.HandleInvite, h.invite(challengeFrom(t, first[len(first)-1])))

	if got := lastStatus(t, responses); got != 503 {
		t.Fatalf("statuses = %v, want a 503", statuses(responses))
	}
	final := responses[len(responses)-1]
	if final.GetHeader("Retry-After") == nil {
		t.Error("a 503 with no Retry-After makes a carrier retry here rather than fail over")
	}
}

// The RefusingPort is the honest production behaviour of a deployment with no engine: every call is
// refused, loudly, and nothing pretends a call could have been placed.
func TestRefusingPortRefusesEverything(t *testing.T) {
	admission, err := invite.RefusingPort{Reason: invite.ReasonShuttingDown}.
		Admit(context.Background(), invite.CallIntent{LegID: "leg-1"})
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if admission.OK || admission.Reason != invite.ReasonShuttingDown || admission.LegID != "leg-1" {
		t.Errorf("admission = %+v", admission)
	}
	if got := invite.StatusFor(admission.Reason); got.Status != 503 || got.RetryAfter <= 0 {
		t.Errorf("refusal = %+v, want a 503 with a Retry-After", got)
	}
	fallback, _ := invite.RefusingPort{}.Admit(context.Background(), invite.CallIntent{})
	if fallback.Reason != invite.ReasonInternal {
		t.Errorf("the default reason = %q, want internal", fallback.Reason)
	}
}

// A carrier authenticates by SOURCE ADDRESS and resolves in the UNTRUSTED context, which is what
// stops an inbound PSTN call from dialling back out through a trunk.
func TestTrunkProfileAdmitsByACLIntoTheUntrustedContext(t *testing.T) {
	entry, err := profile.ParseEntry("203.0.113.0/24", profile.ActionAllow, 0, "trunk-telnyx", "telnyx")
	if err != nil {
		t.Fatalf("ParseEntry: %v", err)
	}
	set, err := profile.NewSet(profile.External("external", profile.NewACL([]profile.Entry{entry}),
		profile.Listener{Network: "udp", Addr: "0.0.0.0:5060"}))
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	h := newHarness(t, harnessOptions{profiles: set})

	responses := h.send(h.handler.HandleInvite, h.invite(nil))
	if lastStatus(t, responses) != 100 {
		t.Fatalf("statuses = %v, want the call admitted with no challenge", statuses(responses))
	}
	intent, _ := h.port.Last()
	switch {
	case intent.Authentication != invite.AuthenticationTrunkACL:
		t.Errorf("authentication = %q", intent.Authentication)
	case intent.TrunkID != "trunk-telnyx":
		t.Errorf("trunkId = %q, want the ACL entry's attribution", intent.TrunkID)
	case intent.RoutingContext != profile.ContextUntrusted:
		t.Errorf("routingContext = %q, want the untrusted one", intent.RoutingContext)
	case intent.OrgID != "":
		t.Error("a trunk INVITE resolves no tenant here: the engine reads the did-index")
	case intent.From.AOR != "":
		t.Error("there is no credential, so there is no canonical caller AOR to rebuild")
	}
}

func TestASourceOutsideTheTrunkACLIsForbidden(t *testing.T) {
	entry, err := profile.ParseEntry("198.51.100.0/24", profile.ActionAllow, 0, "trunk-other", "other")
	if err != nil {
		t.Fatalf("ParseEntry: %v", err)
	}
	set, err := profile.NewSet(profile.External("external", profile.NewACL([]profile.Entry{entry}),
		profile.Listener{Network: "udp", Addr: "0.0.0.0:5060"}))
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	h := newHarness(t, harnessOptions{profiles: set})

	// 403 and never a challenge: there is no credential a carrier could offer here, so a 401 would
	// be an instruction the far end cannot follow.
	if got := lastStatus(t, h.send(h.handler.HandleInvite, h.invite(nil))); got != 403 {
		t.Errorf("status = %d, want 403", got)
	}
	if len(h.port.Requests()) != 0 {
		t.Error("an unlisted source must be refused before it costs a NATS round trip")
	}
}

// A BYE ends the call, is answered 200, and leaves nothing behind — no dialog, no claim.
func TestByeEndsTheCallAndReleasesEverything(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	h.send(h.handler.HandleInvite, h.invite(challengeFrom(t, first[len(first)-1])))

	bye := h.parse(`BYE sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKbye
From: <sip:1001@` + testRealm + `>;tag=caller-tag
To: <sip:1002@` + testRealm + `>;tag=edge-tag
Call-ID: call-2@pc33
CSeq: 3 BYE
Reason: Q.850;cause=16
Content-Length: 0

`)
	// The dialog was never answered, so a BYE against it is refused 481: RFC 3261 has no confirmed
	// dialog to end and the far end wanted CANCEL. It is still ANSWERED — a refusal is always a
	// reply, never a silence, or the far end retransmits its BYE for thirty-two seconds.
	if got := lastStatus(t, h.send(h.handler.HandleBye, bye)); got != 481 {
		t.Errorf("status = %d, want 481", got)
	}
	// The dialog is still ours until something ends it.
	if h.dialogs.Len() != 1 {
		t.Errorf("dialogs = %d, want the call still up", h.dialogs.Len())
	}
}

// A BYE for a dialog this instance does not hold is 481 — the correct answer, and under a
// misconfigured balancer the log's Call-ID is what makes it diagnosable.
func TestByeForAnUnknownDialogIsFourEightyOne(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	bye := h.parse(`BYE sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKbye
From: <sip:1001@` + testRealm + `>;tag=nobody
To: <sip:1002@` + testRealm + `>;tag=nothing
Call-ID: no-such-call@pc33
CSeq: 3 BYE
Content-Length: 0

`)
	if got := lastStatus(t, h.send(h.handler.HandleBye, bye)); got != 481 {
		t.Errorf("status = %d, want 481", got)
	}
}

// RFC 3891: a Replaces that names no dialog we hold is 481 — the ordinary race when somebody hangs
// up mid-transfer — and it is refused before a leg id is minted or a claim written.
func TestInviteWithAnUnmatchedReplacesIsFourEightyOne(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	req := h.invite(challenge, `Replaces: no-such-call@pc33;to-tag=a;from-tag=b`)
	if got := lastStatus(t, h.send(h.handler.HandleInvite, req)); got != 481 {
		t.Errorf("status = %d, want 481", got)
	}
	if h.dialogs.Len() != 0 {
		t.Error("a refused Replaces must not create a dialog")
	}
	if len(h.port.Requests()) != 0 {
		t.Error("a Replaces that cannot complete must not cost a broker round trip")
	}
}

func TestInviteWithAMalformedReplacesIsBadRequest(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	// No from-tag: RFC 3891 §3 requires both, and a half-matching Replaces would ask this edge to
	// guess which of two dialogs to tear down.
	req := h.invite(challenge, `Replaces: call-1@pc33;to-tag=a`)
	if got := lastStatus(t, h.send(h.handler.HandleInvite, req)); got != 400 {
		t.Errorf("status = %d, want 400", got)
	}
}

// A Replaces that DOES name one of our dialogs is admitted, and the leg it replaces travels to the
// engine — which has to re-bridge the call the replaced leg belonged to.
func TestInviteWithAMatchingReplacesCarriesTheReplacedLeg(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])
	h.send(h.handler.HandleInvite, h.invite(challenge))

	original, found := h.dialogs.Get("leg-1")
	if !found {
		t.Fatal("the consultation dialog must exist")
	}
	replaces := "Replaces: " + original.Identity.SIPCallID +
		";to-tag=" + original.Identity.LocalTag +
		";from-tag=" + original.Identity.RemoteTag

	responses := h.send(h.handler.HandleInvite, h.invite(challenge, replaces))
	if lastStatus(t, responses) != 100 {
		t.Fatalf("statuses = %v, want the replacement admitted", statuses(responses))
	}
	intent, _ := h.port.Last()
	if intent.ReplacesLegID != "leg-1" {
		t.Errorf("replacesLegId = %q, want the correlated leg", intent.ReplacesLegID)
	}
	if intent.Replaces == nil || intent.Replaces.CallID != original.Identity.SIPCallID {
		t.Errorf("replaces = %+v, want the SIP identifiers alongside the leg", intent.Replaces)
	}
}

// RFC 4028: an interval below our floor is a NEGOTIATION step — a 422 carrying the Min-SE the peer
// should retry at — and not a failure.
func TestSessionIntervalBelowTheFloorIsFourTwentyTwo(t *testing.T) {
	h := newHarness(t, harnessOptions{timers: dialog.DefaultTimerPolicy()})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	responses := h.send(h.handler.HandleInvite,
		h.invite(challenge, "Supported: timer", "Session-Expires: 30"))
	final := responses[len(responses)-1]
	if final.StatusCode != 422 {
		t.Fatalf("statuses = %v, want a 422", statuses(responses))
	}
	minSE := final.GetHeader("Min-SE")
	if minSE == nil || minSE.Value() != "90" {
		t.Errorf("Min-SE = %v, want the floor the peer should retry at", minSE)
	}
	if h.dialogs.Len() != 0 {
		t.Error("a 422 is answered before any dialog is created")
	}
}

// Turning session timers off and being sent `Require: timer` must be refused loudly: accepting
// would leave the peer expecting refreshes that never come.
func TestRequireTimerWithTimersOffIsFourTwenty(t *testing.T) {
	h := newHarness(t, harnessOptions{timers: dialog.TimerPolicy{Enabled: false}})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	responses := h.send(h.handler.HandleInvite,
		h.invite(challenge, "Require: timer", "Session-Expires: 600"))
	final := responses[len(responses)-1]
	if final.StatusCode != 420 {
		t.Fatalf("statuses = %v, want a 420", statuses(responses))
	}
	unsupported := final.GetHeader("Unsupported")
	if unsupported == nil || unsupported.Value() != "timer" {
		t.Errorf("Unsupported = %v, want the extension named", unsupported)
	}
}

// A malformed INVITE is refused before anything is created — and every branch of the parser is
// reachable from wire text.
func TestMalformedInvitesAreRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	req := h.invite(challenge)
	// Strip the Contact: RFC 3261 §8.1.1.8 makes it mandatory, and without one no mid-dialog request
	// could ever reach the far end.
	req.RemoveHeader("Contact")

	if got := lastStatus(t, h.send(h.handler.HandleInvite, req)); got != 400 {
		t.Errorf("status = %d, want 400", got)
	}
	if h.dialogs.Len() != 0 {
		t.Error("a malformed INVITE must leave nothing behind")
	}
}

// An INFO carrying DTMF is answered 200 and reported; one carrying something else is answered 200
// too, because INFO is an extension point and refusing an unknown one has broken interop with more
// handsets than it has ever protected.
func TestInfoCarriesDTMF(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	h.send(h.handler.HandleInvite, h.invite(challengeFrom(t, first[len(first)-1])))

	body := "Signal=5\nDuration=160\n"
	info := h.parse(`INFO sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKinfo
From: <sip:1001@` + testRealm + `>;tag=caller-tag
To: <sip:1002@` + testRealm + `>;tag=edge-tag
Call-ID: call-2@pc33
CSeq: 4 INFO
Content-Type: application/dtmf-relay
Content-Length: ` + strconv.Itoa(len(crlf(body))) + `

` + body)
	if got := lastStatus(t, h.send(h.handler.HandleInfo, info)); got != 200 {
		t.Errorf("status = %d, want 200", got)
	}

	unknown := h.parse(`INFO sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKinfo2
From: <sip:1001@` + testRealm + `>;tag=caller-tag
To: <sip:1002@` + testRealm + `>;tag=edge-tag
Call-ID: call-2@pc33
CSeq: 5 INFO
Content-Type: application/vendor-thing
Content-Length: 4

body`)
	if got := lastStatus(t, h.send(h.handler.HandleInfo, unknown)); got != 200 {
		t.Errorf("status = %d, want 200 for an INFO body we do not understand", got)
	}
}

func TestInfoForAnUnknownDialogIsFourEightyOne(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	info := h.parse(`INFO sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKinfo
From: <sip:1001@` + testRealm + `>;tag=nobody
To: <sip:1002@` + testRealm + `>;tag=nothing
Call-ID: no-such-call@pc33
CSeq: 4 INFO
Content-Length: 0

`)
	if got := lastStatus(t, h.send(h.handler.HandleInfo, info)); got != 481 {
		t.Errorf("status = %d, want 481", got)
	}
}

// A re-INVITE before the initial INVITE has been answered is RFC 3261 §14.2's 500 with a
// Retry-After — a peer running ahead of the dialog's own state, not a glare.
func TestReInviteBeforeTheCallIsAnsweredIsFiveHundred(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])
	h.send(h.handler.HandleInvite, h.invite(challenge))

	original, _ := h.dialogs.Get("leg-1")
	reinvite := h.parse(`INVITE sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKre
From: <sip:1001@` + testRealm + `>;tag=` + original.Identity.RemoteTag + `
To: <sip:1002@` + testRealm + `>;tag=` + original.Identity.LocalTag + `
Call-ID: ` + original.Identity.SIPCallID + `
CSeq: 9 INVITE
Contact: <sip:1001@192.168.1.42:5060>
Content-Length: 0

`)
	if got := lastStatus(t, h.send(h.handler.HandleInvite, reinvite)); got != 500 {
		t.Errorf("status = %d, want 500", got)
	}
}

// An UPDATE on a dialog we do not hold is 481, and one on a dialog we do hold is accepted — RFC
// 3311 exists precisely so an early dialog can be renegotiated.
func TestUpdate(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])
	h.send(h.handler.HandleInvite, h.invite(challenge))
	original, _ := h.dialogs.Get("leg-1")

	held := "v=0\nc=IN IP4 192.168.1.42\nm=audio 40000 RTP/AVP 0\na=sendonly\n"
	update := h.parse(`UPDATE sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKup
From: <sip:1001@` + testRealm + `>;tag=` + original.Identity.RemoteTag + `
To: <sip:1002@` + testRealm + `>;tag=` + original.Identity.LocalTag + `
Call-ID: ` + original.Identity.SIPCallID + `
CSeq: 9 UPDATE
Contact: <sip:1001@192.168.1.42:5061>
Content-Type: application/sdp
Content-Length: ` + strconv.Itoa(len(crlf(held))) + `

` + held)
	if got := lastStatus(t, h.send(h.handler.HandleUpdate, update)); got != 200 {
		t.Fatalf("status = %d, want 200", got)
	}
	if !original.Held() {
		t.Error("hold while ringing must be recorded")
	}
	// RFC 3261 §12.2.1.1: the target refreshes, so our BYE goes where the far end is now.
	if original.Target.Contact.Port != 5061 {
		t.Errorf("contact port = %d, want the refreshed target", original.Target.Contact.Port)
	}

	unknown := h.parse(`UPDATE sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKup2
From: <sip:1001@` + testRealm + `>;tag=nobody
To: <sip:1002@` + testRealm + `>;tag=nothing
Call-ID: no-such-call@pc33
CSeq: 9 UPDATE
Content-Length: 0

`)
	if got := lastStatus(t, h.send(h.handler.HandleUpdate, unknown)); got != 481 {
		t.Errorf("status = %d, want 481", got)
	}
}

// A CANCEL that reaches this handler matched no live transaction, which almost always means the
// final response has already gone out: RFC 3261 §9.2's "no effect", answered 481.
func TestCancelForAnUnknownDialogIsFourEightyOne(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	cancel := h.parse(`CANCEL sip:1002@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKcan
From: <sip:1001@` + testRealm + `>;tag=nobody
To: <sip:1002@` + testRealm + `>;tag=nothing
Call-ID: no-such-call@pc33
CSeq: 1 CANCEL
Content-Length: 0

`)
	if got := lastStatus(t, h.send(h.handler.HandleCancel, cancel)); got != 481 {
		t.Errorf("status = %d, want 481", got)
	}
}

// An ACK is never answered — it has no response — and one for a dialog we do not hold is dropped
// rather than turned into an error.
func TestAckIsNeverAnswered(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	ack := h.parse(`ACK sip:optimiq-sipd@` + testRealm + ` SIP/2.0
Via: SIP/2.0/UDP 192.168.1.42:5060;branch=z9hG4bKack
From: <sip:1001@` + testRealm + `>;tag=nobody
To: <sip:1002@` + testRealm + `>;tag=nothing
Call-ID: no-such-call@pc33
CSeq: 1 ACK
Content-Length: 0

`)
	if responses := h.send(h.handler.HandleAck, ack); len(responses) != 0 {
		t.Errorf("responses = %v, want none: an ACK has no response", statuses(responses))
	}
}

// There is no default profile: a packet nobody owns is a packet no policy applies to.
func TestAnInviteNoProfileClaimsIsForbidden(t *testing.T) {
	set, err := profile.NewSet(profile.Internal("internal",
		profile.Listener{Network: "tcp", Addr: "0.0.0.0:5060"}))
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	h := newHarness(t, harnessOptions{profiles: set})

	req := h.invite(nil)
	req.SetTransport("UDP") // no profile serves UDP in this set
	if got := lastStatus(t, h.send(h.handler.HandleInvite, req)); got != 403 {
		t.Errorf("status = %d, want 403", got)
	}
}

func TestNewValidatesItsWiring(t *testing.T) {
	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	set, err := profile.NewSet(profile.Internal("internal",
		profile.Listener{Network: "udp", Addr: "0.0.0.0:5060"}))
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	base := invite.Options{
		Realm:       testRealm,
		Auth:        authenticator,
		Credentials: staticCredentials{},
		Dialogs:     dialog.NewStore(dialog.StoreOptions{}),
		Profiles:    set,
		Port:        &invite.FakePort{},
		NewLegID:    func() string { return "leg" },
	}
	if _, err := invite.New(base); err != nil {
		t.Fatalf("the complete options must build: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*invite.Options)
	}{
		{"no realm", func(o *invite.Options) { o.Realm = "" }},
		{"no authenticator", func(o *invite.Options) { o.Auth = nil }},
		{"no credentials", func(o *invite.Options) { o.Credentials = nil }},
		{"no dialog store", func(o *invite.Options) { o.Dialogs = nil }},
		{"no profiles", func(o *invite.Options) { o.Profiles = nil }},
		{"no port", func(o *invite.Options) { o.Port = nil }},
		{"no leg id minter", func(o *invite.Options) { o.NewLegID = nil }},
		{"an authenticator for another realm", func(o *invite.Options) { o.Realm = "other.example.com" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			options := base
			tc.mutate(&options)
			if _, err := invite.New(options); err == nil {
				t.Error("New must refuse this wiring")
			}
		})
	}
}

// The CANCEL sipgo's transaction layer handles for us: it answers the CANCEL 200 and drives the
// INVITE to 487 by itself, and it tells NOBODY. The hook installed on the transaction is what turns
// that into a dialog termination, and this is the test that it does.
func TestCancelEndsTheDialogAndReleasesTheClaim(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	first := h.send(h.handler.HandleInvite, h.invite(nil))
	challenge := challengeFrom(t, first[len(first)-1])

	req := h.invite(challenge)
	tx := newRecordingTx()
	h.handler.HandleInvite(req, tx)

	if h.dialogs.Len() != 1 {
		t.Fatalf("dialogs = %d, want the admitted call", h.dialogs.Len())
	}

	tx.cancel(req)

	if h.dialogs.Len() != 0 {
		t.Errorf("dialogs = %d, want the cancelled call gone", h.dialogs.Len())
	}
	claims, _ := h.claims.All(context.Background())
	if len(claims) != 0 {
		t.Errorf("claims = %+v, want the claim released", claims)
	}
	if !h.handler.Wait(2 * time.Second) {
		t.Error("the session teardown must finish within the shutdown budget")
	}
	if h.handler.Len() != 0 {
		t.Errorf("the handler still holds %d legs", h.handler.Len())
	}
}
