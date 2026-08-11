package subscribe_test

import (
	"context"
	"encoding/xml"
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
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/subscribe"
)

// The SUBSCRIBE/NOTIFY vertical end to end inside one process: real digest (answered by
// github.com/icholy/digest, the CLIENT side of the same RFC), a real location service, a real
// parser, and fakes only at the two edges that are genuinely elsewhere — the broker and the socket.
//
// Three properties are worth the harness. That an unauthenticated, unregistered, or wrong-realm
// phone never reaches the presence bucket at all. That accepting a subscription ALWAYS produces an
// immediate full-state notification, because a phone that is accepted and told nothing shows a lamp
// that is dark until the extension next moves. And that a state change reaches every watcher with a
// body they can parse.

const (
	testRealm  = "acme.example.com"
	testOrg    = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testUser   = "1001"
	testPass   = "s3cret"
	testAOR    = "sip:1001@acme.example.com"
	testCall   = "3c26700c1adf-blfkey01"
	watchedExt = "1002"
)

// ---------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------

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

func (n *recordingNotifier) all() []*sip.Request {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]*sip.Request(nil), n.sent...)
}

func (n *recordingNotifier) reset() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = nil
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
	t        *testing.T
	handler  *subscribe.Handler
	notifier *recordingNotifier
	bindings *kv.MemoryStore
	presence *presence.MemoryStore
	mwi      *mwi.MemorySource
	parser   *sip.Parser
	now      time.Time
	cseq     int
}

type harnessOptions struct {
	lookup       credentials.Store
	unregistered bool
	expired      bool
	expiry       subscribe.ExpiryPolicy
}

func newHarness(t *testing.T, opts harnessOptions) *harness {
	t.Helper()

	authenticator, err := registrar.NewAuthenticator(testRealm, []byte("test-nonce-secret"), time.Minute)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	h := &harness{
		t:        t,
		notifier: &recordingNotifier{},
		bindings: kv.NewMemoryStore(),
		presence: presence.NewMemoryStore(),
		mwi:      mwi.NewMemorySource(),
		parser:   sip.NewParser(),
		now:      time.Date(2026, 8, 11, 10, 0, 0, 0, time.UTC),
	}

	lookup := opts.lookup
	if lookup == nil {
		lookup = staticCredentials{credential: credentials.Credential{
			OrgID:       testOrg,
			Username:    testUser,
			Realm:       testRealm,
			HA1:         credentials.HA1(testUser, testRealm, testPass),
			ExtensionID: "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51",
		}}
	}

	if !opts.unregistered {
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

	expiry := opts.expiry
	if expiry.Min == 0 {
		expiry = subscribe.ExpiryPolicy{
			Min:     60 * time.Second,
			Max:     600 * time.Second,
			Default: 600 * time.Second,
		}
	}

	handler, err := subscribe.New(subscribe.Options{
		Realm:        testRealm,
		Auth:         authenticator,
		Credentials:  lookup,
		Bindings:     h.bindings,
		Presence:     h.presence,
		MWI:          h.mwi,
		Notifier:     h.notifier,
		Contact:      sip.Uri{Scheme: "sip", User: "optimiq-sipd", Host: "sipd.acme.example.com", Port: 5060},
		Expiry:       expiry,
		Logger:       slog.New(slog.DiscardHandler),
		ServerHeader: "optimiq-sipd",
		Now:          func() time.Time { return h.now },
		NewTag:       func() string { return "sipdtag" },
	})
	if err != nil {
		t.Fatalf("subscribe.New: %v", err)
	}
	h.handler = handler
	return h
}

type subscribeOptions struct {
	event     string
	to        string
	expires   string
	toTag     string
	callID    string
	accept    string
	noContact bool
}

func (o subscribeOptions) withDefaults() subscribeOptions {
	if o.event == "" {
		o.event = "dialog"
	}
	if o.to == "" {
		o.to = "sip:" + watchedExt + "@" + testRealm
	}
	if o.callID == "" {
		o.callID = testCall
	}
	return o
}

// subscribe performs the full two-legged digest exchange and returns the FINAL response.
func (h *harness) subscribe(opts subscribeOptions) *sip.Response {
	h.t.Helper()
	opts = opts.withDefaults()
	challenge := h.send(h.newSubscribe("", opts))
	if challenge.StatusCode != 401 {
		return challenge
	}
	return h.send(h.newSubscribe(h.answerChallenge(challenge), opts))
}

func (h *harness) answerChallenge(res *sip.Response) string {
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
		// SUBSCRIBE, not REGISTER: HA2 is MD5(method:uri), so a handler verifying with the wrong
		// method name would accept nothing and every BLF key would fail with a password error.
		Method:   "SUBSCRIBE",
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

func (h *harness) newSubscribe(authorization string, opts subscribeOptions) *sip.Request {
	h.t.Helper()
	h.cseq++

	to := "To: <" + opts.to + ">"
	if opts.toTag != "" {
		to += ";tag=" + opts.toTag
	}

	lines := []string{
		"SUBSCRIBE " + opts.to + " SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK" + strings.Repeat("a", h.cseq) + ";rport",
		"Max-Forwards: 70",
		"From: <" + testAOR + ">;tag=fromtag",
		to,
		"Call-ID: " + opts.callID,
		"CSeq: " + strconv.Itoa(h.cseq) + " SUBSCRIBE",
		"Event: " + opts.event,
		"User-Agent: Yealink SIP-T46U 108.86.0.40",
	}
	if !opts.noContact {
		lines = append(lines, "Contact: <sip:1001@203.0.113.9:5060>")
	}
	if opts.expires != "" {
		lines = append(lines, "Expires: "+opts.expires)
	}
	if opts.accept != "" {
		lines = append(lines, "Accept: "+opts.accept)
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, "Content-Length: 0", "", "")

	message, err := h.parser.ParseSIP([]byte(strings.Join(lines, "\r\n")))
	if err != nil {
		h.t.Fatalf("building the SUBSCRIBE: %v", err)
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
	h.handler.HandleSubscribe(req, tx)
	// The immediate notification runs on its own goroutine so the 200 is not held behind a KV read;
	// drain it before asserting, exactly as the shutdown path does.
	if !h.handler.Wait(5 * time.Second) {
		h.t.Fatal("the immediate notification did not finish")
	}
	results := tx.Result()
	if len(results) == 0 {
		h.t.Fatal("the handler produced no response; a transaction must always be answered")
	}
	return results[len(results)-1]
}

// drain waits for the dispatched notifications to land. The fan-out sends them off the caller's
// goroutine on purpose — one unplugged desk phone must not stall every other lamp — so a test that
// asserted immediately would be racing the very design it is checking.
func (h *harness) drain() {
	h.t.Helper()
	if !h.handler.Wait(5 * time.Second) {
		h.t.Fatal("the dispatched notifications did not finish")
	}
}

func headerOf(t *testing.T, message interface{ GetHeader(string) sip.Header }, name string) string {
	t.Helper()
	header := message.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

type notifiedDialog struct {
	XMLName xml.Name `xml:"dialog-info"`
	Version int      `xml:"version,attr"`
	Entity  string   `xml:"entity,attr"`
	Dialogs []struct {
		ID    string `xml:"id,attr"`
		State string `xml:"state"`
	} `xml:"dialog"`
}

func parseNotifiedDialog(t *testing.T, req *sip.Request) notifiedDialog {
	t.Helper()
	var document notifiedDialog
	if err := xml.Unmarshal(req.Body(), &document); err != nil {
		t.Fatalf("the NOTIFY body is not dialog-info+xml: %v\n%s", err, req.Body())
	}
	return document
}

// ---------------------------------------------------------------------------------------------
// acceptance and the immediate notification
// ---------------------------------------------------------------------------------------------

func TestSubscribeIsAcceptedAndNotifiedImmediately(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.presence.Set(presence.State{
		OrgID:           testOrg,
		ExtensionNumber: watchedExt,
		State:           contract.PresenceDeviceStateRinging,
		ChannelCount:    1,
		UpdatedAt:       h.now.UnixMilli(),
	})

	res := h.subscribe(subscribeOptions{})
	if res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d %s, want 200", res.StatusCode, res.Reason)
	}
	if got := headerOf(t, res, "Expires"); got != "600" {
		t.Errorf("Expires = %q, want the granted default 600", got)
	}
	if got := headerOf(t, res, "Allow-Events"); got != subscribe.AllowEvents {
		t.Errorf("Allow-Events = %q, want %q", got, subscribe.AllowEvents)
	}
	if res.Contact() == nil {
		t.Error("the 200 carried no Contact; a phone cannot address its refresh")
	}
	if h.handler.Subscriptions() != 1 {
		t.Fatalf("the table holds %d subscriptions, want 1", h.handler.Subscriptions())
	}

	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("got %d notifications, want exactly one full-state NOTIFY on acceptance", len(sent))
	}
	notify := sent[0]

	if notify.Method != sip.NOTIFY {
		t.Errorf("method = %s, want NOTIFY", notify.Method)
	}
	if got := headerOf(t, notify, "Event"); got != "dialog" {
		t.Errorf("Event = %q, want dialog", got)
	}
	if got := headerOf(t, notify, "Subscription-State"); got != "active;expires=600" {
		t.Errorf("Subscription-State = %q, want active;expires=600", got)
	}
	if got := headerOf(t, notify, "Content-Type"); got != "application/dialog-info+xml" {
		t.Errorf("Content-Type = %q", got)
	}
	// The From tag on the notification must be the SAME string the phone saw on the 200; a phone
	// that cannot match the tags silently drops every notification, and the lamp never moves.
	if from := notify.From(); from == nil {
		t.Error("the NOTIFY carried no From header")
	} else if tag, _ := from.Params.Get("tag"); tag != "sipdtag" {
		t.Errorf("NOTIFY From tag = %q, want the tag from the 200", tag)
	}
	if to := notify.To(); to == nil {
		t.Error("the NOTIFY carried no To header")
	} else if tag, _ := to.Params.Get("tag"); tag != "fromtag" {
		t.Errorf("NOTIFY To tag = %q, want the subscriber's From tag", tag)
	}
	if notify.Destination() != "203.0.113.9:5060" {
		// The OBSERVED source, not the Contact: a phone behind NAT is reachable there and generally
		// nowhere else.
		t.Errorf("destination = %q, want the observed source address", notify.Destination())
	}

	document := parseNotifiedDialog(t, notify)
	if document.Entity != "sip:"+watchedExt+"@"+testRealm {
		t.Errorf("entity = %q, want the watched AOR", document.Entity)
	}
	if len(document.Dialogs) != 1 || document.Dialogs[0].State != "early" {
		t.Errorf("a ringing extension rendered as %#v, want one dialog in `early`", document.Dialogs)
	}
	if document.Version != 0 {
		t.Errorf("version = %d, want 0 on the first notification", document.Version)
	}
}

// An extension with no presence entry at all is IDLE, not an error: the bucket only holds extensions
// with channels, so "absent" is the common case and the one a lamp must render dark.
func TestSubscribeToAnExtensionWithNoPresenceNotifiesIdle(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d %s, want 200", res.StatusCode, res.Reason)
	}
	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("got %d notifications, want one", len(sent))
	}
	if document := parseNotifiedDialog(t, sent[0]); len(document.Dialogs) != 0 {
		t.Errorf("an extension with no presence rendered %#v, want no dialog element", document.Dialogs)
	}
}

// ---------------------------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------------------------

func TestUnauthenticatedSubscribeIsChallengedAndNeverReadsPresence(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	req := h.newSubscribe("", subscribeOptions{}.withDefaults())
	res := h.send(req)
	if res.StatusCode != 401 {
		t.Fatalf("SUBSCRIBE = %d %s, want 401", res.StatusCode, res.Reason)
	}
	if headerOf(t, res, "WWW-Authenticate") == "" {
		t.Error("the 401 carried no challenge, so the phone cannot retry")
	}
	if h.handler.Subscriptions() != 0 {
		t.Error("an unauthenticated SUBSCRIBE created a subscription")
	}
	if len(h.notifier.all()) != 0 {
		t.Error("an unauthenticated SUBSCRIBE produced a notification")
	}
}

// 489 rather than 501, and BEFORE the digest. `Allow-Events` is a constant this edge already
// advertises on OPTIONS, so answering an anonymous SUBSCRIBE leaks nothing — and challenging a phone
// for a package we will never serve produces a loop some handsets run forever.
func TestUnsupportedEventPackageIsRefusedWithTheHonestList(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	for _, event := range []string{"presence", "reg", "message-summary-bogus", ""} {
		req := h.newSubscribe("", subscribeOptions{event: event}.withDefaults())
		if event == "" {
			// An Event header is mandatory on a SUBSCRIBE (RFC 6665 §8.2.1); one without it is
			// refused on the same path rather than defaulted to something.
			req.RemoveHeader("Event")
		}
		res := h.send(req)
		if res.StatusCode != 489 {
			t.Errorf("Event %q = %d %s, want 489 Bad Event", event, res.StatusCode, res.Reason)
		}
		if got := headerOf(t, res, "Allow-Events"); got != subscribe.AllowEvents {
			t.Errorf("Event %q: Allow-Events = %q, want %q", event, got, subscribe.AllowEvents)
		}
	}
}

func TestSubscribeFromAnUnregisteredAccountIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{unregistered: true})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 403 {
		t.Fatalf("SUBSCRIBE = %d %s, want 403", res.StatusCode, res.Reason)
	}
	if h.handler.Subscriptions() != 0 {
		t.Error("a phone with no live binding got a subscription")
	}
}

// A binding whose granted interval lapsed is a phone that stopped refreshing minutes ago; the
// sweeper simply has not reached it.
func TestSubscribeFromALapsedBindingIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{expired: true})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 403 {
		t.Fatalf("SUBSCRIBE = %d %s, want 403", res.StatusCode, res.Reason)
	}
}

func TestSubscribeForAnotherRealmIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{to: "sip:1002@evil.example.net"})
	if res.StatusCode != 403 {
		t.Fatalf("SUBSCRIBE = %d %s, want 403", res.StatusCode, res.Reason)
	}
}

// THE confidentiality boundary. Dialog state is public within a tenant by design — a BLF wall is
// exactly that — but message counts are not.
func TestMessageSummaryForSomebodyElsesMailboxIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{
		event: "message-summary",
		to:    "sip:1002@" + testRealm,
	})
	if res.StatusCode != 403 {
		t.Fatalf("SUBSCRIBE = %d %s, want 403", res.StatusCode, res.Reason)
	}
	if h.handler.Subscriptions() != 0 {
		t.Error("a cross-mailbox message-summary subscription was created")
	}
}

func TestTooBriefSubscriptionIsRefusedWithMinExpires(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{expires: "5"})
	if res.StatusCode != 423 {
		t.Fatalf("SUBSCRIBE = %d %s, want 423 Interval Too Brief", res.StatusCode, res.Reason)
	}
	if got := headerOf(t, res, "Min-Expires"); got != "60" {
		t.Errorf("Min-Expires = %q, want 60", got)
	}
}

// RFC 6665 §4.2.1 lets the notifier shorten what a phone asked for. This is the knob that bounds how
// long a lamp can be stale after an instance dies, so a handset asking for an hour gets ten minutes
// and refreshes more often rather than being refused.
func TestAnOverlongSubscriptionIsClampedRatherThanRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{expires: "3600"})
	if res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d %s, want 200", res.StatusCode, res.Reason)
	}
	if got := headerOf(t, res, "Expires"); got != "600" {
		t.Errorf("Expires = %q, want the clamped 600", got)
	}
}

func TestASubscriberThatWillNotTakeOurBodyTypeIsRefused(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{accept: "application/pidf+xml"})
	if res.StatusCode != 406 {
		t.Fatalf("SUBSCRIBE = %d %s, want 406 Not Acceptable", res.StatusCode, res.Reason)
	}
	if got := headerOf(t, res, "Accept"); got != "application/dialog-info+xml" {
		t.Errorf("Accept = %q, want the type we would have sent", got)
	}
}

func TestAcceptHeadersThatDoAllowOurBodyType(t *testing.T) {
	for _, accept := range []string{
		"application/dialog-info+xml",
		"*/*",
		"application/*",
		"application/pidf+xml, application/dialog-info+xml;q=0.8",
	} {
		h := newHarness(t, harnessOptions{})
		if res := h.subscribe(subscribeOptions{accept: accept}); res.StatusCode != 200 {
			t.Errorf("Accept %q = %d %s, want 200", accept, res.StatusCode, res.Reason)
		}
	}
}

// ---------------------------------------------------------------------------------------------
// refresh, unsubscribe, expiry
// ---------------------------------------------------------------------------------------------

// A refresh EXTENDS a subscription; it does not create one. Reusing the record is what keeps the
// dialog-info version counter monotonic — a phone that saw version 7 and then a version 0 discards
// the newer body as stale (RFC 4235 §3.3).
func TestRefreshExtendsTheSameSubscriptionAndKeepsVersionsMonotonic(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("initial SUBSCRIBE = %d", res.StatusCode)
	}
	firstDeadline := h.handler.Subscriptions()
	if firstDeadline != 1 {
		t.Fatalf("the table holds %d subscriptions, want 1", firstDeadline)
	}
	h.notifier.reset()

	h.now = h.now.Add(2 * time.Minute)
	if res := h.subscribe(subscribeOptions{toTag: "sipdtag"}); res.StatusCode != 200 {
		t.Fatalf("refresh SUBSCRIBE = %d", res.StatusCode)
	}
	if h.handler.Subscriptions() != 1 {
		t.Errorf("a refresh created a second subscription (%d held)", h.handler.Subscriptions())
	}

	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("a refresh produced %d notifications, want one", len(sent))
	}
	if document := parseNotifiedDialog(t, sent[0]); document.Version != 1 {
		t.Errorf("version = %d after a refresh, want 1 — a version that restarts is discarded",
			document.Version)
	}
	// And the CSeq must have advanced, or the phone treats the second NOTIFY as a retransmit.
	if cseq := sent[0].CSeq(); cseq == nil || cseq.SeqNo != 2 {
		t.Errorf("NOTIFY CSeq = %v, want 2", cseq)
	}
}

func TestUnsubscribeRemovesTheSubscriptionAndSendsATerminalNotification(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("initial SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	res := h.subscribe(subscribeOptions{toTag: "sipdtag", expires: "0"})
	if res.StatusCode != 200 {
		t.Fatalf("unsubscribe = %d %s, want 200", res.StatusCode, res.Reason)
	}
	h.drain()
	if h.handler.Subscriptions() != 0 {
		t.Errorf("the subscription survived an unsubscribe (%d held)", h.handler.Subscriptions())
	}

	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("an unsubscribe produced %d notifications, want one terminal NOTIFY", len(sent))
	}
	// `noresource` rather than `timeout`: the subscriber asked to stop, and telling it to come back
	// would produce a loop.
	if got := headerOf(t, sent[0], "Subscription-State"); got != "terminated;reason=noresource" {
		t.Errorf("Subscription-State = %q, want terminated;reason=noresource", got)
	}
}

// RFC 6665 §4.1.2.4: the notifier SHOULD send a terminal notification when a subscription expires.
// Without it a phone that missed its own refresh window sits believing it is still subscribed, and
// the lamp stops moving with nothing to tell it why.
func TestALapsedSubscriptionIsSweptAndTheSubscriberToldWhy(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{expires: "60"}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	if swept := h.handler.Sweep(context.Background()); swept != 0 {
		t.Fatalf("a live subscription was swept (%d)", swept)
	}

	h.now = h.now.Add(61 * time.Second)
	if swept := h.handler.Sweep(context.Background()); swept != 1 {
		t.Fatalf("swept %d subscriptions, want 1", swept)
	}
	h.drain()
	if h.handler.Subscriptions() != 0 {
		t.Error("the lapsed subscription is still in the table")
	}

	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("a sweep produced %d notifications, want one", len(sent))
	}
	if got := headerOf(t, sent[0], "Subscription-State"); got != "terminated;reason=timeout" {
		t.Errorf("Subscription-State = %q, want terminated;reason=timeout", got)
	}

	// A second sweep must be a no-op: a terminal NOTIFY per tick would have a phone re-subscribing
	// in a loop.
	if swept := h.handler.Sweep(context.Background()); swept != 0 {
		t.Errorf("the second sweep removed %d subscriptions, want 0", swept)
	}
}

// `terminated;reason=deactivated` is RFC 6665's "re-subscribe immediately", which is what turns a
// rolling deploy into a blip rather than an outage of every lamp this instance was serving.
func TestShutdownTellsEverySubscriberToComeBack(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	if deactivated := h.handler.Shutdown(context.Background()); deactivated != 1 {
		t.Fatalf("deactivated %d subscriptions, want 1", deactivated)
	}
	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("shutdown produced %d notifications, want one", len(sent))
	}
	if got := headerOf(t, sent[0], "Subscription-State"); got != "terminated;reason=deactivated" {
		t.Errorf("Subscription-State = %q, want terminated;reason=deactivated", got)
	}
	if h.handler.Subscriptions() != 0 {
		t.Error("the table survived a shutdown")
	}
}

// ---------------------------------------------------------------------------------------------
// the fan-out
// ---------------------------------------------------------------------------------------------

func TestAPresenceChangeReachesEveryWatcher(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	h.handler.OnPresence(presence.Change{
		OrgID:           testOrg,
		ExtensionNumber: watchedExt,
		State: presence.State{
			OrgID:           testOrg,
			ExtensionNumber: watchedExt,
			State:           contract.PresenceDeviceStateActive,
			ChannelCount:    1,
			UpdatedAt:       h.now.UnixMilli(),
		},
	})
	h.drain()

	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("a presence change produced %d notifications, want one", len(sent))
	}
	document := parseNotifiedDialog(t, sent[0])
	if len(document.Dialogs) != 1 || document.Dialogs[0].State != "confirmed" {
		t.Errorf("an active extension rendered as %#v, want one dialog in `confirmed`",
			document.Dialogs)
	}
	if document.Version != 1 {
		t.Errorf("version = %d, want 1 (0 was the acceptance notification)", document.Version)
	}
	if got := headerOf(t, sent[0], "Subscription-State"); !strings.HasPrefix(got, "active;expires=") {
		t.Errorf("Subscription-State = %q, want an active state with a remaining interval", got)
	}
}

// A deleted key is the bucket's five-minute TTL reaping an extension nobody is writing any more.
// Treating it as "no news" would leave a lamp lit after the last engine that knew about the call
// stopped.
func TestADeletedPresenceKeyClearsTheLamp(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.presence.Set(presence.State{
		OrgID:           testOrg,
		ExtensionNumber: watchedExt,
		State:           contract.PresenceDeviceStateActive,
		UpdatedAt:       h.now.UnixMilli(),
	})
	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	h.handler.OnPresence(presence.Change{
		OrgID: testOrg, ExtensionNumber: watchedExt, Deleted: true,
	})
	h.drain()

	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("a deletion produced %d notifications, want one", len(sent))
	}
	if document := parseNotifiedDialog(t, sent[0]); len(document.Dialogs) != 0 {
		t.Errorf("a deleted key rendered %#v, want no dialog element", document.Dialogs)
	}
}

func TestAPresenceChangeForAnUnwatchedExtensionNotifiesNobody(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	if res := h.subscribe(subscribeOptions{}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	h.handler.OnPresence(presence.Change{
		OrgID:           testOrg,
		ExtensionNumber: "9999",
		State:           presence.State{State: contract.PresenceDeviceStateActive},
	})
	// And another tenant's extension with the SAME number, which is the tenancy mistake worth
	// pinning: the key is org-scoped, and a fan-out that ignored the org would light one customer's
	// lamps from another's calls.
	h.handler.OnPresence(presence.Change{
		OrgID:           "018f4f5e-1c2a-7a3b-9c4d-5e6f70819294",
		ExtensionNumber: watchedExt,
		State:           presence.State{State: contract.PresenceDeviceStateActive},
	})
	h.drain()

	if sent := h.notifier.all(); len(sent) != 0 {
		t.Errorf("got %d notifications for extensions nobody is watching", len(sent))
	}
}

func TestMWISubscriptionIsNotifiedFromTheEvent(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{event: "message-summary", to: testAOR})
	if res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d %s, want 200", res.StatusCode, res.Reason)
	}

	// The acceptance notification: no event has been seen, so the honest answer is "no messages".
	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("got %d notifications on acceptance, want one", len(sent))
	}
	if got := headerOf(t, sent[0], "Content-Type"); got != "application/simple-message-summary" {
		t.Errorf("Content-Type = %q", got)
	}
	if body := string(sent[0].Body()); !strings.Contains(body, "Messages-Waiting: no") {
		t.Errorf("the acceptance body did not report an empty mailbox:\n%s", body)
	}
	h.notifier.reset()

	// apps/api leaves `extensionNumber` unset today, so the match falls back to the mailbox number.
	h.handler.OnMWI(mwi.Update{
		OrgID:   testOrg,
		Mailbox: testUser,
		Counts:  mwi.Counts{New: 2, Saved: 8},
	})
	h.drain()

	sent = h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("an MWI event produced %d notifications, want one", len(sent))
	}
	body := string(sent[0].Body())
	if !strings.Contains(body, "Messages-Waiting: yes") {
		t.Errorf("the lamp was not lit:\n%s", body)
	}
	if !strings.Contains(body, "Voice-Message: 2/8 (0/0)") {
		t.Errorf("the counts are wrong:\n%s", body)
	}
	if !strings.Contains(body, "Message-Account: "+testAOR) {
		t.Errorf("Message-Account is wrong:\n%s", body)
	}
}

// An MWI event that names the extension explicitly must match too, and must not double-notify a
// subscriber that both the extension and the mailbox number resolve to.
func TestMWIMatchesOnEitherIdentifierWithoutDoubleNotifying(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	if res := h.subscribe(subscribeOptions{event: "message-summary", to: testAOR}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	h.handler.OnMWI(mwi.Update{
		OrgID:     testOrg,
		Mailbox:   testUser,
		Extension: testUser,
		Counts:    mwi.Counts{New: 1},
	})
	h.drain()
	if sent := h.notifier.all(); len(sent) != 1 {
		t.Fatalf("got %d notifications, want exactly one", len(sent))
	}
}

func TestMWIForAnotherTenantNotifiesNobody(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	if res := h.subscribe(subscribeOptions{event: "message-summary", to: testAOR}); res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d", res.StatusCode)
	}
	h.notifier.reset()

	h.handler.OnMWI(mwi.Update{
		OrgID:   "018f4f5e-1c2a-7a3b-9c4d-5e6f70819294",
		Mailbox: testUser,
		Counts:  mwi.Counts{New: 5},
	})
	h.drain()
	if sent := h.notifier.all(); len(sent) != 0 {
		t.Errorf("another tenant's MWI event lit %d lamps", len(sent))
	}
}

// A phone with a sixteen-key expansion module watches many extensions over one dialog, telling them
// apart with the Event `id`. Dropping it would make every lamp show the same extension.
func TestTheEventIDIsEchoedOnEveryNotification(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	res := h.subscribe(subscribeOptions{event: "dialog;id=key07"})
	if res.StatusCode != 200 {
		t.Fatalf("SUBSCRIBE = %d %s, want 200", res.StatusCode, res.Reason)
	}
	sent := h.notifier.all()
	if len(sent) != 1 {
		t.Fatalf("got %d notifications, want one", len(sent))
	}
	if got := headerOf(t, sent[0], "Event"); got != "dialog;id=key07" {
		t.Errorf("Event = %q, want dialog;id=key07", got)
	}
}

// Two line keys on one phone watching two extensions are two subscriptions, distinguished only by
// the event id — the Call-ID and both tags are shared.
func TestTwoEventIDsOnOneDialogAreTwoSubscriptions(t *testing.T) {
	h := newHarness(t, harnessOptions{})

	if res := h.subscribe(subscribeOptions{event: "dialog;id=key01"}); res.StatusCode != 200 {
		t.Fatalf("first SUBSCRIBE = %d", res.StatusCode)
	}
	if res := h.subscribe(subscribeOptions{
		event: "dialog;id=key02",
		to:    "sip:1003@" + testRealm,
		toTag: "sipdtag",
	}); res.StatusCode != 200 {
		t.Fatalf("second SUBSCRIBE = %d", res.StatusCode)
	}
	if h.handler.Subscriptions() != 2 {
		t.Errorf("the table holds %d subscriptions, want 2", h.handler.Subscriptions())
	}
}
