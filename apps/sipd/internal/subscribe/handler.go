// Package subscribe implements RFC 6665 SUBSCRIBE/NOTIFY for the two event packages a desk phone
// actually uses: RFC 4235 `dialog` (the busy-lamp key) and RFC 3842 `message-summary` (the voicemail
// lamp).
//
// # What this closes
//
// Every provisioning template in apps/api already writes BLF keys onto handsets — Yealink
// `linekey.N.type = 16`, Snom `blf sip:200@<domain>;user=phone`, Poly `attendant.resourceList` — and
// apps/api already publishes `voicemail.evt.v1.…mwi.updated` whenever a mailbox's counts move. Until
// now sipd answered every SUBSCRIBE with 501, so the keys were provisioned and dark and the MWI
// events had no consumer. This package is the half that was missing on the wire; apps/engine's
// presence publisher is the half that was missing in the bucket.
//
// # What it deliberately does not do
//
// No `presence` (RFC 3856 / pidf+xml) and no eventlist (RFC 4662 BLF-List). The first is a different
// thing wearing the same word — human availability, not dialog state — and no template subscribes to
// it. The second is a bandwidth optimisation for phones with many keys, and it needs a resource-list
// server that does not exist yet. Both are answered 489 with an honest `Allow-Events`, which is what
// makes a phone fall back to per-key subscriptions rather than sit silent.
package subscribe

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// SIP statuses this handler emits. Bare integers at a call site are how a 403 becomes a 423.
const (
	statusOK               = 200
	statusBadRequest       = 400
	statusUnauthorized     = 401
	statusForbidden        = 403
	statusNotAcceptable    = 406
	statusIntervalTooBrief = 423
	statusServerError      = 500
	statusBadEvent         = 489
)

// ExpiryPolicy clamps the interval a subscriber asks for.
//
// Separate from the registrar's ExpiryPolicy even though the shape is the same, because the two
// answer different questions and want different numbers. A registration's interval decides how long
// a phone stays routable; a subscription's decides how long a lamp can be wrong after this instance
// dies (see the Table doc comment). The default here is deliberately much shorter than a
// registration's.
type ExpiryPolicy struct {
	Min     time.Duration
	Max     time.Duration
	Default time.Duration
}

// ErrIntervalTooBrief means the subscriber asked for less than Min.
var ErrIntervalTooBrief = errors.New("subscribe: the requested interval is too brief")

// Validate checks the policy is orderable.
func (p ExpiryPolicy) Validate() error {
	switch {
	case p.Min <= 0:
		return errors.New("subscribe: the minimum subscription interval must be positive")
	case p.Max < p.Min:
		return errors.New("subscribe: the maximum subscription interval must not be below the minimum")
	case p.Default < p.Min || p.Default > p.Max:
		return errors.New("subscribe: the default subscription interval must lie within [min, max]")
	}
	return nil
}

// MinSeconds is the `Min-Expires` header value of a 423.
func (p ExpiryPolicy) MinSeconds() int { return int(p.Min / time.Second) }

// Grant resolves the interval to hand out. An UNSTATED interval takes the default; a stated one is
// refused below Min and silently clamped above Max, because RFC 6665 §4.2.1 lets a notifier shorten
// a subscription and a phone that asked for an hour has no reason to be told it cannot have one.
func (p ExpiryPolicy) Grant(requested time.Duration, stated bool) (time.Duration, error) {
	if !stated {
		return p.Default, nil
	}
	if requested == 0 {
		return 0, nil
	}
	if requested < p.Min {
		return 0, ErrIntervalTooBrief
	}
	if requested > p.Max {
		return p.Max, nil
	}
	return requested, nil
}

// Notifier sends one NOTIFY. An interface so the fan-out is unit-testable without a socket.
type Notifier interface {
	Notify(ctx context.Context, req *sip.Request) error
}

// ClientNotifier sends notifications through a sipgo client transaction.
//
// A transaction rather than a bare write, for the same reason internal/transfer uses one: NOTIFY is
// a non-INVITE request, and the transaction layer owns the T1 retransmission timer that covers a
// notification lost on UDP — the exact case that leaves a lamp wrong.
type ClientNotifier struct {
	client *sipgo.Client
}

var _ Notifier = (*ClientNotifier)(nil)

// NewClientNotifier wraps a sipgo client.
func NewClientNotifier(client *sipgo.Client) (*ClientNotifier, error) {
	if client == nil {
		return nil, errors.New("subscribe: a SIP client is required to send notifications")
	}
	return &ClientNotifier{client: client}, nil
}

// Notify implements Notifier.
func (n *ClientNotifier) Notify(ctx context.Context, req *sip.Request) error {
	tx, err := n.client.TransactionRequest(ctx, req)
	if err != nil {
		return fmt.Errorf("subscribe: sending a NOTIFY: %w", err)
	}
	defer tx.Terminate()

	select {
	case <-tx.Responses():
		return nil
	case <-tx.Done():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DiscardNotifier drops every notification. It is what the unit tests that are not about delivery
// use, and what a deployment with no SIP client would get.
type DiscardNotifier struct{}

var _ Notifier = DiscardNotifier{}

// Notify implements Notifier.
func (DiscardNotifier) Notify(context.Context, *sip.Request) error { return nil }

// Options configures a Handler. Every dependency is an interface so the tests run without a broker
// or a socket.
type Options struct {
	// Realm is the digest realm. It must match the Authenticator's.
	Realm string
	// Auth runs the digest exchange. The SAME authenticator the registrar and the transfer handler
	// use: a second one with its own secret would mint nonces the others reject, and the symptom
	// would be a phone that can register but whose BLF keys never light.
	Auth *registrar.Authenticator
	// Credentials resolves the account behind the subscriber's AOR.
	Credentials credentials.Store
	// Bindings is the location service. Read to confirm the subscriber is registered HERE, never
	// written — a SUBSCRIBE changes no binding.
	Bindings kv.Store
	// Presence is the device-state source for the `dialog` package.
	Presence presence.Store
	// MWI is the message-count source for the `message-summary` package.
	MWI mwi.Source
	// Notifier delivers the notifications.
	Notifier Notifier
	// Contact is the URI this edge puts in the Contact header of its 200s and its notifications.
	Contact sip.Uri
	// Expiry clamps the interval a subscriber asks for.
	Expiry ExpiryPolicy

	Logger *slog.Logger
	// ServerHeader is the Server / User-Agent header value.
	ServerHeader string
	// BaseContext parents every store read and every notification, so a shutdown cancels work in
	// flight. Modelled on net/http.Server.BaseContext: sipgo's handler signature carries no context.
	BaseContext context.Context
	// AuthTimeout bounds the credential lookup and the binding read that gate the 200.
	AuthTimeout time.Duration
	// NotifyTimeout bounds one notification.
	NotifyTimeout time.Duration
	// SweepInterval is how often Run looks for lapsed subscriptions.
	SweepInterval time.Duration
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now func() time.Time
	// NewTag mints the To tag for the 200. Injectable so a test can assert the exact NOTIFY headers.
	NewTag func() string
}

// Handler answers SUBSCRIBE and drives the notifications that follow.
//
// # What it checks before anything reaches the table
//
//  1. The event package is one this edge serves. Checked FIRST, before the digest, and that order is
//     deliberate: `Allow-Events` is a constant this edge already advertises on every OPTIONS and
//     every 200, so answering 489 to an anonymous SUBSCRIBE leaks nothing — and challenging a phone
//     for a package we will never serve produces an authentication loop that some handsets run
//     forever.
//  2. The SUBSCRIBE answers a digest challenge this fleet minted, with a password only the account
//     holder has.
//  3. The authenticated account is the one in the `From` header. Without this any valid account on
//     the realm could subscribe as somebody else — the same hole the registrar's AOR check and the
//     transfer handler's From check close.
//  4. That account has a LIVE binding in this deployment. A credential that verifies but has no
//     registration is a phone that is not on this network right now.
//  5. The watched resource is in the subscriber's own realm, and — for `message-summary` — is the
//     subscriber's OWN account. That last one is not symmetry, it is the only real confidentiality
//     boundary in this file: an extension's dialog state is visible to every colleague by design
//     (that is what a BLF wall IS), and its message counts are not.
type Handler struct {
	realm    string
	auth     *registrar.Authenticator
	creds    credentials.Store
	bindings kv.Store
	presence presence.Store
	mwi      mwi.Source
	notifier Notifier
	contact  sip.Uri
	expiry   ExpiryPolicy

	log           *slog.Logger
	server        string
	baseCtx       context.Context
	authTimeout   time.Duration
	notifyTimeout time.Duration
	sweepInterval time.Duration
	now           func() time.Time
	newTag        func() string

	table *Table
	// notifications tracks the goroutines sending the immediate NOTIFY that follows a 200, so
	// Wait can drain them at shutdown rather than leaving a phone with an accepted subscription it
	// was never told the state of.
	notifications sync.WaitGroup
}

// New validates the options and builds a Handler.
func New(opts Options) (*Handler, error) {
	switch {
	case strings.TrimSpace(opts.Realm) == "":
		return nil, errors.New("subscribe: Realm is required")
	case opts.Auth == nil:
		return nil, errors.New("subscribe: Auth is required")
	case opts.Credentials == nil:
		return nil, errors.New("subscribe: Credentials is required")
	case opts.Bindings == nil:
		return nil, errors.New("subscribe: Bindings is required")
	case opts.Presence == nil:
		return nil, errors.New("subscribe: Presence is required")
	case opts.MWI == nil:
		return nil, errors.New("subscribe: MWI is required")
	}
	if opts.Auth.Realm() != opts.Realm {
		return nil, fmt.Errorf("subscribe: the authenticator challenges for %q but the handler serves %q",
			opts.Auth.Realm(), opts.Realm)
	}
	if err := opts.Expiry.Validate(); err != nil {
		return nil, err
	}

	handler := &Handler{
		realm:         opts.Realm,
		auth:          opts.Auth,
		creds:         opts.Credentials,
		bindings:      opts.Bindings,
		presence:      opts.Presence,
		mwi:           opts.MWI,
		notifier:      opts.Notifier,
		contact:       opts.Contact,
		expiry:        opts.Expiry,
		log:           opts.Logger,
		server:        opts.ServerHeader,
		baseCtx:       opts.BaseContext,
		authTimeout:   opts.AuthTimeout,
		notifyTimeout: opts.NotifyTimeout,
		sweepInterval: opts.SweepInterval,
		now:           opts.Now,
		newTag:        opts.NewTag,
		table:         NewTable(),
	}
	if handler.notifier == nil {
		handler.notifier = DiscardNotifier{}
	}
	if handler.log == nil {
		handler.log = slog.Default()
	}
	if handler.server == "" {
		handler.server = "optimiq-sipd"
	}
	if handler.baseCtx == nil {
		handler.baseCtx = context.Background()
	}
	if handler.authTimeout <= 0 {
		handler.authTimeout = 3 * time.Second
	}
	if handler.notifyTimeout <= 0 {
		handler.notifyTimeout = 3 * time.Second
	}
	if handler.sweepInterval <= 0 {
		handler.sweepInterval = 5 * time.Second
	}
	if handler.now == nil {
		handler.now = time.Now
	}
	if handler.newTag == nil {
		handler.newTag = func() string { return sip.GenerateTagN(16) }
	}
	return handler, nil
}

// Subscriptions returns how many subscriptions this instance holds.
func (h *Handler) Subscriptions() int { return h.table.Len() }

// ---------------------------------------------------------------------------------------------
// SUBSCRIBE
// ---------------------------------------------------------------------------------------------

// HandleSubscribe implements RFC 6665 §4.2 for this edge.
func (h *Handler) HandleSubscribe(req *sip.Request, tx sip.ServerTransaction) {
	log := h.log.With(
		"method", "SUBSCRIBE",
		"peer", req.Source(),
		"transport", req.Transport(),
		"sipCallId", headerValue(req, "Call-ID"),
	)

	event, eventID, ok := parseEvent(headerValue(req, "Event"))
	if !ok || !Supported(event) {
		// 489 and NOT 501. 501 says "this element does not implement the method", which is now false
		// and would stop a phone trying a package we do serve; 489 says "not that package, here is
		// the list", which is the answer a handset can act on.
		log.Info("refusing an unsupported event package", "event", string(event))
		h.respondWithAllowEvents(tx, req, statusBadEvent, "Bad Event")
		return
	}
	log = log.With("event", string(event))

	if !acceptable(headerValue(req, "Accept"), contentTypeFor(event)) {
		log.Info("refusing a subscriber that will not take our body type",
			"accept", headerValue(req, "Accept"), "contentType", contentTypeFor(event))
		res := sip.NewResponseFromRequest(req, statusNotAcceptable, "Not Acceptable", nil)
		res.AppendHeader(sip.NewHeader("Accept", contentTypeFor(event)))
		res.AppendHeader(sip.NewHeader("Server", h.server))
		h.send(tx, res)
		return
	}

	ctx, cancel := context.WithTimeout(h.baseCtx, h.authTimeout)
	defer cancel()

	from := req.From()
	if from == nil {
		log.Info("rejecting a SUBSCRIBE with no From header")
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	// The subscriber is the From: a SUBSCRIBE is sent BY the party that wants to watch, unlike a
	// REGISTER where the To is the address of record being bound.
	subscriberAOR, subscriberUser, ok := addressOfRecord(from.Address)
	if !ok {
		log.Info("rejecting a SUBSCRIBE with no usable From address")
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	log = log.With("aor", subscriberAOR)

	credential, authorized := h.authorize(ctx, req, tx, subscriberUser, log)
	if !authorized {
		return
	}

	if !h.isRegistered(ctx, credential.OrgID, subscriberAOR, log) {
		// 403 rather than 404: the account is real and its digest verified, it simply has no live
		// binding here, and telling the caller which of the two it was is an enumeration oracle.
		log.Warn("rejecting a SUBSCRIBE from an account with no live registration")
		h.respond(tx, req, statusForbidden, "Forbidden")
		return
	}

	resource, entity, ok := h.resourceOf(req, event, credential, log)
	if !ok {
		h.respond(tx, req, statusForbidden, "Forbidden")
		return
	}
	log = log.With("resource", resource)

	requested, stated := expiresHeader(req)
	granted, err := h.expiry.Grant(requested, stated)
	if errors.Is(err, ErrIntervalTooBrief) {
		log.Info("rejecting a too-brief subscription", "requestedSeconds", int(requested/time.Second))
		res := sip.NewResponseFromRequest(req, statusIntervalTooBrief, "Interval Too Brief", nil)
		res.AppendHeader(sip.NewHeader("Min-Expires", strconv.Itoa(h.expiry.MinSeconds())))
		res.AppendHeader(sip.NewHeader("Server", h.server))
		h.send(tx, res)
		return
	}
	if err != nil {
		log.Error("cannot resolve the subscription interval", "error", err)
		h.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}

	inDialogTag := toTag(req.To())
	subscription := h.build(req, event, eventID, credential, subscriberUser, resource, entity, inDialogTag)

	if granted == 0 {
		h.unsubscribe(req, tx, subscription, log)
		return
	}

	now := h.now()
	if existing, found := h.table.Get(subscription.Key()); found {
		// A refresh EXTENDS a subscription; it does not create one. Reusing the record keeps the
		// CSeq and dialog-info version counters monotonic, and a phone that saw version 7 and then
		// a version 0 discards the newer body as stale (RFC 4235 §3.3).
		existing.Refresh(now.Add(granted))
		subscription = existing
	} else {
		subscription.Refresh(now.Add(granted))
		h.table.Put(subscription)
	}

	res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)
	if inDialogTag == "" {
		// sipgo mints a tag of its own when the request carried none, and does not say which. The
		// NOTIFY's From tag must be the SAME string the phone saw on the 200 — a phone that cannot
		// match the tags silently drops every notification, so the lamp never moves and the failure
		// looks exactly like presence not being wired up at all.
		if to := res.To(); to != nil {
			to.Params.Remove("tag")
			to.Params.Add("tag", subscription.LocalTag)
		}
	}
	res.AppendHeader(sip.NewHeader("Expires", strconv.Itoa(int(granted/time.Second))))
	res.AppendHeader(sip.NewHeader("Allow-Events", AllowEvents))
	res.AppendHeader(&sip.ContactHeader{Address: h.contact})
	res.AppendHeader(sip.NewHeader("Server", h.server))
	if err := tx.Respond(res); err != nil {
		log.Error("cannot accept the SUBSCRIBE", "error", err)
		h.table.Remove(subscription.Key())
		return
	}

	log.Info("subscribed",
		"orgId", credential.OrgID,
		"expiresSeconds", int(granted/time.Second),
		"subscriptions", h.table.Len())

	// RFC 6665 §4.1.3: the notifier MUST send a NOTIFY carrying full state immediately on accepting
	// a subscription. After the 200 and off the transaction, because it is a new transaction in the
	// other direction and holding the SUBSCRIBE open across a KV read would put a broker round trip
	// inside a phone's retransmission timer.
	h.notifications.Add(1)
	go func() {
		defer h.notifications.Done()
		h.notifyCurrent(subscription, log)
	}()
}

// unsubscribe answers `Expires: 0` — the phone asking to stop watching.
//
// The 200 goes out first and the final NOTIFY follows, per RFC 6665 §4.2.2: a subscription is not
// gone until its notifier says so, and a phone that got a 200 with no terminal notification keeps
// the subscription in its own table until it times out.
func (h *Handler) unsubscribe(req *sip.Request, tx sip.ServerTransaction, candidate *Subscription, log *slog.Logger) {
	subscription, found := h.table.Remove(candidate.Key())
	if !found {
		// Unsubscribing from something we do not hold is idempotent, not an error: a phone may send
		// `Expires: 0` twice, and an instance that never held the subscription still owes a 200.
		subscription = candidate
	}

	res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)
	if candidate.MintedLocalTag {
		if to := res.To(); to != nil {
			to.Params.Remove("tag")
			to.Params.Add("tag", subscription.LocalTag)
		}
	}
	res.AppendHeader(sip.NewHeader("Expires", "0"))
	res.AppendHeader(sip.NewHeader("Allow-Events", AllowEvents))
	res.AppendHeader(sip.NewHeader("Server", h.server))
	h.send(tx, res)

	log.Info("unsubscribed", "subscriptions", h.table.Len())

	if !found {
		return
	}
	h.notifications.Add(1)
	go func() {
		defer h.notifications.Done()
		h.notifyState(subscription, StateTerminatedClient, log)
	}()
}

// build assembles the subscription record from the request. It does NOT insert it.
func (h *Handler) build(
	req *sip.Request,
	event EventPackage,
	eventID string,
	credential credentials.Credential,
	subscriberUser, resource, entity, inDialogTag string,
) *Subscription {
	localTag := inDialogTag
	if localTag == "" {
		// The SUBSCRIBE arrived without a To tag, so this response is what establishes the dialog
		// from the phone's point of view and the tag must be ours.
		localTag = h.newTag()
	}

	subscription := &Subscription{
		Event:          event,
		OrgID:          credential.OrgID,
		Resource:       resource,
		Entity:         entity,
		Subscriber:     subscriberUser,
		Recipient:      h.recipientFor(req),
		CallID:         headerValue(req, "Call-ID"),
		LocalTag:       localTag,
		RemoteTag:      fromTag(req.From()),
		MintedLocalTag: inDialogTag == "",
		EventID:        eventID,
		Transport:      req.Transport(),
		Destination:    req.Source(),
	}
	if to := req.To(); to != nil {
		subscription.Local = to.Address
	}
	if from := req.From(); from != nil {
		subscription.Remote = from.Address
	}
	return subscription
}

// resourceOf decides what a SUBSCRIBE is asking to watch, and whether it may.
//
// The resource is the To address, not the Request-URI: they are the same on a fresh SUBSCRIBE, and
// on a REFRESH the Request-URI is this edge's own Contact while the To still names the extension.
// Reading the Request-URI would make every refresh look like a subscription to `optimiq-sipd`.
func (h *Handler) resourceOf(
	req *sip.Request,
	event EventPackage,
	credential credentials.Credential,
	log *slog.Logger,
) (resource, entity string, ok bool) {
	to := req.To()
	if to == nil {
		log.Info("rejecting a SUBSCRIBE with no To header")
		return "", "", false
	}
	aor, user, valid := addressOfRecord(to.Address)
	if !valid {
		log.Info("rejecting a SUBSCRIBE with no usable To address")
		return "", "", false
	}
	// Cross-realm watching is refused rather than resolved. This edge serves one realm and its
	// presence bucket is scoped by the org the CREDENTIAL named; accepting a To in another domain
	// would silently read the subscriber's own tenant under a name that says otherwise.
	if !strings.EqualFold(to.Address.Host, h.realm) {
		log.Warn("rejecting a SUBSCRIBE for another realm", "watchedRealm", to.Address.Host)
		return "", "", false
	}

	if event == EventMessageSummary && user != credential.Username {
		// THE confidentiality boundary in this file. Dialog state is public within a tenant by
		// design — a BLF wall is exactly that — but message counts are not, and a phone that could
		// subscribe to `message-summary` for any extension could watch a colleague's mailbox fill up.
		log.Warn("rejecting a message-summary subscription to somebody else's mailbox",
			"watched", user, "authenticatedAs", credential.Username)
		return "", "", false
	}

	return user, aor, true
}

// ---------------------------------------------------------------------------------------------
// notification
// ---------------------------------------------------------------------------------------------

// notifyCurrent sends the full-state notification a fresh or refreshed subscription is owed.
func (h *Handler) notifyCurrent(subscription *Subscription, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.notifyTimeout)
	defer cancel()

	body, contentType, err := h.currentBody(ctx, subscription)
	if err != nil {
		// A presence read that failed is not a reason to tell a phone its colleague is idle. Better
		// no notification at all: the subscription stays active, and the next state change — or the
		// next refresh — carries the truth.
		log.Error("cannot compose the initial notification", "error", err)
		return
	}
	h.deliver(ctx, subscription, body, contentType, activeState(subscription.RemainingSeconds(h.now())), log)
}

// currentBody reads the source of truth for one subscription and renders it.
func (h *Handler) currentBody(ctx context.Context, subscription *Subscription) ([]byte, string, error) {
	if subscription.Event == EventMessageSummary {
		// The cache, not a query. See mwi.Source: sipd has no grant to ask the control plane for a
		// mailbox's counts, so an account this instance has not seen an event for is reported as
		// having no messages until the next `mwi.updated` or `resync`.
		counts, _ := h.mwi.Last(subscription.OrgID, subscription.Resource)
		return messageSummaryBody(subscription.Entity, counts), messageSummaryContentType, nil
	}

	state, found, err := h.presence.Get(ctx, subscription.OrgID, subscription.Resource)
	if err != nil {
		return nil, "", err
	}
	device := contract.PresenceDeviceStateDown
	if found {
		device = state.State
	}
	body, err := dialogInfoBody(subscription.Entity, subscription.Resource, device, subscription.NextVersion())
	if err != nil {
		return nil, "", err
	}
	return body, dialogInfoContentType, nil
}

// notifyState sends a terminal notification carrying the current body, so a phone that is being told
// to go away also gets the last state this edge knows.
func (h *Handler) notifyState(subscription *Subscription, state SubscriptionState, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.notifyTimeout)
	defer cancel()

	body, contentType, err := h.currentBody(ctx, subscription)
	if err != nil {
		// A terminal notification with no body is still worth sending: the Subscription-State header
		// is the part that tells the phone what to do next, and losing it is what freezes a lamp.
		body, contentType = nil, contentTypeFor(subscription.Event)
	}
	h.deliver(ctx, subscription, body, contentType, state, log)
}

// deliver builds and sends one NOTIFY, blocking until the transaction settles.
func (h *Handler) deliver(
	ctx context.Context,
	subscription *Subscription,
	body []byte,
	contentType string,
	state SubscriptionState,
	log *slog.Logger,
) {
	req := BuildNotify(subscription, body, contentType, state, h.contact, h.server)
	if err := h.notifier.Notify(ctx, req); err != nil {
		// A lost notification leaves a lamp wrong; it does not undo anything. Logged rather than
		// retried here — the transaction layer owns the retries.
		log.Warn("cannot notify a subscriber",
			"resource", subscription.Resource, "state", state.State, "error", err)
	}
}

// dispatch sends one NOTIFY OFF the caller's goroutine.
//
// The fan-out cannot be sequential. A NOTIFY is a client transaction, so an unreachable phone holds
// its send for the full notify timeout, and one desk phone that somebody unplugged would stall every
// other lamp in the deployment behind it — on a busy queue, for as long as it stays unplugged.
//
// Concurrency is safe here for a specific reason rather than by luck: the body's `version` attribute
// is allocated by the CALLER, in order, before the goroutine starts. If two notifications for one
// subscription race and arrive out of order, RFC 4235 §3.3 has the watcher keep the higher version
// and discard the older — which is exactly the newest state. The ordering guarantee lives in the
// body, so the transport does not need one.
//
// Tracked on the same WaitGroup as the acceptance notifications, so Wait drains these too.
func (h *Handler) dispatch(
	subscription *Subscription,
	body []byte,
	contentType string,
	state SubscriptionState,
) {
	h.notifications.Add(1)
	go func() {
		defer h.notifications.Done()
		ctx, cancel := context.WithTimeout(h.baseCtx, h.notifyTimeout)
		defer cancel()
		h.deliver(ctx, subscription, body, contentType, state, h.log)
	}()
}

// BuildNotify assembles one NOTIFY for a subscription.
//
// A pure function of the subscription and the body, so every header this edge puts on the wire is
// asserted in a unit test rather than observed on a capture. Note what it does NOT do: it never
// interpolates a device-supplied string into a header value it has not round-tripped through a
// parser — the Call-ID is the one echo, and it is placed as a typed header rather than concatenated,
// which is the CRLF-injection case sipgo's SECURITY note is about.
func BuildNotify(
	subscription *Subscription,
	body []byte,
	contentType string,
	state SubscriptionState,
	contact sip.Uri,
	server string,
) *sip.Request {
	req := sip.NewRequest(sip.NOTIFY, subscription.Recipient)

	// The notification travels from us to the phone, so the SUBSCRIBE's To becomes our From and its
	// From becomes our To — tags and all.
	from := &sip.FromHeader{Address: subscription.Local, Params: sip.NewParams()}
	if subscription.LocalTag != "" {
		from.Params.Add("tag", subscription.LocalTag)
	}
	to := &sip.ToHeader{Address: subscription.Remote, Params: sip.NewParams()}
	if subscription.RemoteTag != "" {
		to.Params.Add("tag", subscription.RemoteTag)
	}
	callID := sip.CallIDHeader(subscription.CallID)
	cseq := &sip.CSeqHeader{SeqNo: subscription.NextCSeq(), MethodName: sip.NOTIFY}

	event := string(subscription.Event)
	if subscription.EventID != "" {
		event += ";id=" + subscription.EventID
	}

	req.AppendHeader(from)
	req.AppendHeader(to)
	req.AppendHeader(&callID)
	req.AppendHeader(cseq)
	req.AppendHeader(sip.NewHeader("Event", event))
	req.AppendHeader(sip.NewHeader("Subscription-State", state.String()))
	// TODO(SLA): stamp Call-Info appearance-index on dialog-info NOTIFY once the subscription carries
	// the appearance. Unlike the INVITE path — where the credential reply threads the appearance
	// straight onto the binding this builder never sees — a dialog-info watcher's appearance lives on
	// the WATCHED resource's binding, not on this subscription. Reaching it would mean resolving that
	// binding at accept time and threading an appearance index onto Subscription; that is the seam,
	// and the INVITE path is the delivered surface.
	req.AppendHeader(&sip.ContactHeader{Address: contact})
	if server != "" {
		req.AppendHeader(sip.NewHeader("User-Agent", server))
	}
	if len(body) > 0 {
		req.AppendHeader(sip.NewHeader("Content-Type", contentType))
		req.SetBody(body)
	}

	if subscription.Transport != "" {
		req.SetTransport(subscription.Transport)
	}
	if subscription.Destination != "" {
		// Destination, not Source: this is where the notification is going.
		req.SetDestination(subscription.Destination)
	}
	return req
}

// ---------------------------------------------------------------------------------------------
// the fan-out
// ---------------------------------------------------------------------------------------------

// Run watches both sources and expires lapsed subscriptions until the context is cancelled.
//
// One goroutine over both channels plus a ticker, rather than three: every branch mutates the same
// table, and a single loop is what makes "a change arrived while a sweep was removing the
// subscription" impossible to get wrong.
func (h *Handler) Run(ctx context.Context) error {
	changes, err := h.presence.Watch(ctx)
	if err != nil {
		return err
	}
	updates, err := h.mwi.Updates(ctx)
	if err != nil {
		return err
	}

	ticker := time.NewTicker(h.sweepInterval)
	defer ticker.Stop()

	h.log.Info("subscription fan-out started",
		"events", AllowEvents, "sweepIntervalSeconds", int(h.sweepInterval/time.Second))

	for {
		select {
		case <-ctx.Done():
			h.log.Info("subscription fan-out stopped")
			return ctx.Err()
		case change, ok := <-changes:
			if !ok {
				changes = nil
				continue
			}
			h.OnPresence(change)
		case update, ok := <-updates:
			if !ok {
				updates = nil
				continue
			}
			h.OnMWI(update)
		case <-ticker.C:
			h.Sweep(ctx)
		}
	}
}

// OnPresence notifies every subscriber watching the extension that moved. Exported so a test can
// drive the fan-out directly instead of racing a channel.
func (h *Handler) OnPresence(change presence.Change) {
	watchers := h.table.Watchers(EventDialog, change.OrgID, change.ExtensionNumber)
	if len(watchers) == 0 {
		return
	}

	device := contract.PresenceDeviceStateDown
	if !change.Deleted {
		device = change.State.State
	}

	now := h.now()
	for _, subscription := range watchers {
		body, err := dialogInfoBody(
			subscription.Entity, subscription.Resource, device, subscription.NextVersion())
		if err != nil {
			h.log.Error("cannot compose a dialog-info body",
				"resource", subscription.Resource, "error", err)
			continue
		}
		h.dispatch(subscription, body, dialogInfoContentType,
			activeState(subscription.RemainingSeconds(now)))
	}
}

// OnMWI notifies every subscriber whose mailbox counts moved.
//
// The match is on the ACCOUNT rather than on a resource key, because the event names a mailbox and a
// subscription names a SIP user, and the contract's `extensionNumber` — the field that would join
// them — is optional and currently never set. See mwi.Update.MatchesAccount.
func (h *Handler) OnMWI(update mwi.Update) {
	candidates := map[string]struct{}{}
	if update.Extension != "" {
		candidates[update.Extension] = struct{}{}
	}
	if update.Mailbox != "" {
		candidates[update.Mailbox] = struct{}{}
	}

	now := h.now()
	notified := map[string]struct{}{}
	for user := range candidates {
		for _, subscription := range h.table.Watchers(EventMessageSummary, update.OrgID, user) {
			key := subscription.Key()
			if _, already := notified[key]; already {
				// A mailbox and an extension that resolve to the same account must not produce two
				// notifications for one event: a phone told twice shows a lamp that flickers.
				continue
			}
			notified[key] = struct{}{}
			h.dispatch(subscription,
				messageSummaryBody(subscription.Entity, update.Counts), messageSummaryContentType,
				activeState(subscription.RemainingSeconds(now)))
		}
	}
}

// Sweep terminates every subscription whose granted interval has lapsed and returns how many it
// removed. Exported so tests can drive it directly instead of waiting for a tick.
func (h *Handler) Sweep(context.Context) int {
	lapsed := h.table.TakeExpired(h.now())
	for _, subscription := range lapsed {
		// RFC 6665 §4.1.2.4: the notifier SHOULD send a terminal notification when a subscription
		// expires. Without it a phone that missed its own refresh window sits believing it is still
		// subscribed, and the lamp stops moving with nothing to tell it why.
		h.dispatch(subscription, nil, contentTypeFor(subscription.Event), StateTerminatedTimeout)
	}
	if len(lapsed) > 0 {
		h.log.Info("expired lapsed subscriptions",
			"count", len(lapsed), "subscriptions", h.table.Len())
	}
	return len(lapsed)
}

// Shutdown terminates every subscription with `reason=deactivated`, which RFC 6665 §4.1.2.4 defines
// as "re-subscribe immediately". It is what turns a rolling deploy into a blip rather than an outage
// of every lamp this instance was serving.
func (h *Handler) Shutdown(ctx context.Context) int {
	drained := h.table.Drain()
	// Sent inline rather than through dispatch, and with the caller's context: this runs AFTER the
	// base context is cancelled, so a dispatched notification would be abandoned before it left the
	// process — which is the one case where a lost notification costs a fleet-wide lamp freeze
	// rather than one stale key.
	for _, subscription := range drained {
		req := BuildNotify(subscription, nil, contentTypeFor(subscription.Event),
			StateTerminatedDeactivated, h.contact, h.server)
		if err := h.notifier.Notify(ctx, req); err != nil {
			h.log.Warn("cannot deactivate a subscription on shutdown",
				"resource", subscription.Resource, "error", err)
		}
	}
	if len(drained) > 0 {
		h.log.Info("deactivated subscriptions on shutdown", "count", len(drained))
	}
	return len(drained)
}

// Wait blocks until every in-flight notification has finished or the timeout elapses, and reports
// whether they all finished.
func (h *Handler) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		h.notifications.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// ---------------------------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------------------------

// authorize runs the digest exchange for a SUBSCRIBE. It answers the transaction itself on every
// failure path and reports whether the caller should continue.
//
// The status choices mirror the registrar's and the transfer handler's, for the same reasons: 401
// for "no credentials" and "stale nonce" because the device can retry, 403 for everything else
// because re-challenging a wrong password produces a loop some handsets run forever.
func (h *Handler) authorize(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	fromUser string,
	log *slog.Logger,
) (credentials.Credential, bool) {
	auth, err := registrar.ParseAuthorization(headerValue(req, "Authorization"))
	if err != nil {
		if errors.Is(err, registrar.ErrNoAuthorization) {
			h.challenge(req, tx, false, log)
			return credentials.Credential{}, false
		}
		log.Info("rejecting a malformed Authorization header", "error", err)
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return credentials.Credential{}, false
	}

	if auth.Realm != h.realm {
		log.Info("re-challenging a credential for another realm", "offeredRealm", auth.Realm)
		h.challenge(req, tx, false, log)
		return credentials.Credential{}, false
	}
	if err := h.auth.CheckNonce(auth.Nonce); err != nil {
		h.challenge(req, tx, errors.Is(err, registrar.ErrNonceStale), log)
		return credentials.Credential{}, false
	}

	// An account may only subscribe AS ITSELF. Without this any valid account on the realm could
	// send a SUBSCRIBE carrying somebody else's From and have this edge attribute the subscription
	// to them — which for `message-summary` is somebody else's mailbox.
	if auth.Username != fromUser {
		log.Warn("rejecting a SUBSCRIBE sent as somebody else", "authenticatedAs", auth.Username)
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	credential, err := h.creds.Lookup(ctx, h.realm, auth.Username)
	if err != nil {
		switch {
		case errors.Is(err, credentials.ErrNotFound):
			log.Info("rejecting an unknown account", "username", auth.Username)
		case errors.Is(err, credentials.ErrDisabled):
			log.Info("rejecting a disabled account", "username", auth.Username)
		default:
			log.Error("cannot look up the account", "username", auth.Username, "error", err)
		}
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	// SUBSCRIBE, not REGISTER: HA2 is MD5(method:uri), so verifying with the wrong method name
	// accepts nothing and would make every BLF key fail with a password error nobody could explain.
	if err := h.auth.Verify(req.Method.String(), auth, credential.HA1); err != nil {
		if errors.Is(err, registrar.ErrNonceStale) {
			h.challenge(req, tx, true, log)
			return credentials.Credential{}, false
		}
		log.Warn("rejecting a failed digest", "username", auth.Username, "reason", err)
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	return credential, true
}

// isRegistered reports whether the subscriber has a live binding in this deployment.
//
// A read failure answers FALSE. Fail-closed, exactly as the transfer handler is: a location service
// that cannot be consulted is not evidence that a phone is on the network.
func (h *Handler) isRegistered(ctx context.Context, orgID, aor string, log *slog.Logger) bool {
	aorHash, err := contract.AORSubjectToken(aor)
	if err != nil {
		log.Error("cannot derive the AOR subject token", "error", err)
		return false
	}
	binding, found, err := h.bindings.Get(ctx, orgID, aorHash)
	if err != nil {
		log.Error("cannot read the subscriber's binding", "error", err)
		return false
	}
	if !found {
		return false
	}
	// A binding whose granted interval has already lapsed is one the sweeper has not reached yet.
	return !binding.Expired(h.now())
}

// ---------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------

func (h *Handler) challenge(req *sip.Request, tx sip.ServerTransaction, stale bool, log *slog.Logger) {
	value, err := h.auth.Challenge(stale)
	if err != nil {
		log.Error("cannot mint a digest challenge", "error", err)
		h.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}
	res := sip.NewResponseFromRequest(req, statusUnauthorized, "Unauthorized", nil)
	res.AppendHeader(sip.NewHeader("WWW-Authenticate", value))
	res.AppendHeader(sip.NewHeader("Server", h.server))
	h.send(tx, res)
}

func (h *Handler) respond(tx sip.ServerTransaction, req *sip.Request, status int, reason string) {
	res := sip.NewResponseFromRequest(req, status, reason, nil)
	res.AppendHeader(sip.NewHeader("Server", h.server))
	h.send(tx, res)
}

func (h *Handler) respondWithAllowEvents(tx sip.ServerTransaction, req *sip.Request, status int, reason string) {
	res := sip.NewResponseFromRequest(req, status, reason, nil)
	res.AppendHeader(sip.NewHeader("Allow-Events", AllowEvents))
	res.AppendHeader(sip.NewHeader("Server", h.server))
	h.send(tx, res)
}

func (h *Handler) send(tx sip.ServerTransaction, res *sip.Response) {
	if err := tx.Respond(res); err != nil {
		h.log.Error("cannot send a response", "error", err, "status", res.StatusCode)
	}
}

// recipientFor picks where a notification is addressed: the subscriber's Contact when it offered
// one, and the From address otherwise. The observed source address is set separately as the
// DESTINATION, so a phone behind NAT is reached at the address that works even when its Contact is
// unroutable.
func (h *Handler) recipientFor(req *sip.Request) sip.Uri {
	if contact := req.Contact(); contact != nil {
		return contact.Address
	}
	if from := req.From(); from != nil {
		return from.Address
	}
	return h.contact
}
