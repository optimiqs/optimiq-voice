// Package subscribe implements RFC 6665 SUBSCRIBE/NOTIFY for the two event packages a desk phone
// actually uses: RFC 4235 `dialog` (the busy-lamp key) and RFC 3842 `message-summary` (the voicemail
// lamp).
//
// It serves no `presence` (RFC 3856 / pidf+xml) — that is human availability, not dialog state —
// and no eventlist (RFC 4662 BLF-List), which needs a resource-list server this platform lacks.
// Both are answered 489 with an honest `Allow-Events`, so a phone falls back to per-key
// subscriptions rather than sitting silent.
package subscribe

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// SIP statuses this handler emits.
const (
	statusOK               = 200
	statusBadRequest       = 400
	statusUnauthorized     = 401
	statusForbidden        = 403
	statusNotAcceptable    = 406
	statusIntervalTooBrief = 423
	statusServerError      = 500
	statusBadEvent         = 489
	statusUnavailable      = 503
)

// ExpiryPolicy clamps the interval a subscriber asks for.
//
// Separate from the registrar's identically shaped policy and deliberately much shorter: this
// interval bounds how long a lamp can be wrong after the instance holding it dies.
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

// ClientNotifier sends notifications through a sipgo client transaction rather than a bare write:
// the transaction layer owns the T1 retransmission timer covering a NOTIFY lost on UDP.
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
	// Auth runs the digest exchange. It MUST be the same authenticator the registrar and transfer
	// handler use: a second one with its own secret would mint nonces the others reject.
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
	// NotifyConcurrency bounds how many NOTIFY client transactions are in flight at once. Zero takes
	// defaultNotifyConcurrency.
	NotifyConcurrency int
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now func() time.Time
	// NewTag mints the To tag for the 200. Injectable so a test can assert the exact NOTIFY headers.
	NewTag func() string
}

// Handler answers SUBSCRIBE and drives the notifications that follow. Nothing reaches the table
// until, in this order:
//
//  1. the event package is one this edge serves — checked BEFORE the digest, because `Allow-Events`
//     is already advertised publicly and challenging for a package we never serve loops some
//     handsets forever;
//  2. the digest verifies against a nonce this fleet minted;
//  3. the authenticated account is the one in the `From` header;
//  4. that account has a live binding in this deployment;
//  5. the watched resource is in the subscriber's own realm and — for `message-summary` — is the
//     subscriber's OWN account. That is the confidentiality boundary here: dialog state is visible
//     to every colleague by design, message counts are not.
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
	// slots bounds how many NOTIFY client transactions this handler holds open at once; the INVITE
	// path shares the same sipgo client. A saturated fan-out DROPS rather than queues: RFC 4235
	// versioning makes a skipped intermediate notification safe.
	slots chan struct{}
	// concurrency is the capacity of slots, kept so the shed log and the shutdown pool can name it.
	concurrency int
	// dropped counts notifications shed by a saturated fan-out, so the shedding is visible.
	dropped atomic.Int64
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
		concurrency:   cmp.Or(opts.NotifyConcurrency, defaultNotifyConcurrency),
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
	handler.slots = make(chan struct{}, handler.concurrency)
	return handler, nil
}

// Subscriptions returns how many subscriptions this instance holds.
func (h *Handler) Subscriptions() int { return h.table.Len() }

// Dropped returns how many notifications a saturated fan-out has shed since boot.
func (h *Handler) Dropped() int64 { return h.dropped.Load() }

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
		// 489 and not 501: 501 would stop a phone trying a package we do serve, while 489 plus
		// `Allow-Events` is an answer a handset can act on.
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
		// The NOTIFY's From tag must be the same string the phone saw on the 200; sipgo would
		// otherwise mint one of its own and every notification would be dropped silently.
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
	h.notifications.Go(func() {
		h.notifyCurrent(subscription, log)
	})
}

// unsubscribe answers `Expires: 0` — the phone asking to stop watching.
//
// The 200 goes out first and the final NOTIFY follows (RFC 6665 §4.2.2): a subscription is not gone
// until its notifier says so.
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
	h.notifications.Go(func() {
		h.notifyState(subscription, StateTerminatedClient, log)
	})
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
// The resource is the To address, not the Request-URI: on a refresh the Request-URI is this edge's
// own Contact while the To still names the extension.
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
	// Cross-realm watching is refused rather than resolved: the presence bucket is scoped by the org
	// the CREDENTIAL named, so a To in another domain would read the subscriber's own tenant.
	if !strings.EqualFold(to.Address.Host, h.auth.ForRequest(req).Realm()) {
		log.Warn("rejecting a SUBSCRIBE for another realm", "watchedRealm", to.Address.Host)
		return "", "", false
	}

	if event == EventMessageSummary && user != credential.Username {
		// The confidentiality boundary in this file: dialog state is public within a tenant by design,
		// but message counts are not.
		log.Warn("rejecting a message-summary subscription to somebody else's mailbox",
			"watched", user, "authenticatedAs", credential.Username)
		return "", "", false
	}

	return user, aor, true
}

// notifyCurrent sends the full-state notification a fresh or refreshed subscription is owed.
func (h *Handler) notifyCurrent(subscription *Subscription, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.notifyTimeout)
	defer cancel()

	body, contentType, err := h.currentBody(ctx, subscription)
	if err != nil {
		// A failed presence read is not a reason to tell a phone its colleague is idle. The
		// subscription stays active and the next change or refresh carries the truth.
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

// defaultNotifyConcurrency is how many NOTIFY client transactions may be in flight at once, both
// for the change fan-out and for the shutdown deactivation sweep.
//
// The bound is per NOTIFY, not per change, and that is what sizes it: one busy extension with N
// busy-lamp watchers costs N transactions for a SINGLE state transition. A BLF wall of five hundred
// keys over a handful of watched extensions therefore needs hundreds of slots to deliver one change,
// and the load rig measures the consequence directly — at 32 slots, 500 watchers over 5 extensions
// see two thirds of their notifications shed at 50 changes/s, and the same fraction at 200.
// Five hundred and twelve delivers all of them at both rates while still bounding an unreachable
// fleet to 512 transactions held for one notify timeout.
const defaultNotifyConcurrency = 512

// dispatch sends one NOTIFY OFF the caller's goroutine: a NOTIFY is a client transaction, so one
// unreachable phone would otherwise stall every other lamp for the full notify timeout.
//
// Concurrency is safe because the body's `version` attribute is allocated by the CALLER, in order,
// before the goroutine starts: RFC 4235 §3.3 has a watcher keep the higher version, so the ordering
// guarantee lives in the body rather than the transport.
//
// Tracked on the same WaitGroup as the acceptance notifications, so Wait drains these too.
func (h *Handler) dispatch(
	batch *notifyBatch,
	subscription *Subscription,
	body []byte,
	contentType string,
	state SubscriptionState,
) {
	select {
	case h.slots <- struct{}{}:
	default:
		// Shed, and say so. The watcher is not left stale: the next change for this subscription
		// carries a higher version and RFC 4235 §3.3 has the watcher keep that one.
		if dropped := h.dropped.Add(1); dropped%100 == 1 {
			h.log.Warn("shedding notifications: the fan-out is saturated",
				"resource", subscription.Resource, "dropped", dropped, "limit", h.concurrency)
		}
		return
	}
	batch.pending.Add(1)
	h.notifications.Go(func() {
		defer batch.pending.Done()
		defer func() { <-h.slots }()
		h.deliver(batch.ctx, subscription, body, contentType, state, h.log)
	})
}

// notifyBatch is the deadline every notification derived from ONE state change shares.
//
// One context per change rather than one per watcher: they start and are abandoned together, and a
// child of the long-lived base context holds a lock on it for its whole life — measured at a quarter
// of all mutex delay at 200 changes/s over 500 watchers.
type notifyBatch struct {
	ctx     context.Context
	cancel  context.CancelFunc
	pending sync.WaitGroup
}

func (h *Handler) newBatch() *notifyBatch {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.notifyTimeout)
	return &notifyBatch{ctx: ctx, cancel: cancel}
}

// close releases the batch's context once the last notification in it has finished. Called for
// effect and not waited on, because the fan-out must not block the loop that reads the changes.
func (b *notifyBatch) close() {
	go func() {
		b.pending.Wait()
		b.cancel()
	}()
}

// BuildNotify assembles one NOTIFY for a subscription. It is a pure function of the subscription
// and the body.
//
// It never interpolates a device-supplied string into a header value: the Call-ID is the one echo
// and it is placed as a typed header rather than concatenated (CRLF injection).
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
	// TODO(SLA): stamp the Call-Info appearance-index here once Subscription carries an appearance
	// index resolved from the WATCHED resource's binding at accept time.
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

// Run watches both sources and expires lapsed subscriptions until the context is cancelled.
//
// One goroutine over both channels plus a ticker, rather than three: every branch mutates the same
// table, so a single loop removes the change-during-sweep race by construction.
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
	batch := h.newBatch()
	defer batch.close()
	for _, subscription := range watchers {
		body, err := dialogInfoBody(
			subscription.Entity, subscription.Resource, device, subscription.NextVersion())
		if err != nil {
			h.log.Error("cannot compose a dialog-info body",
				"resource", subscription.Resource, "error", err)
			continue
		}
		h.dispatch(batch, subscription, body, dialogInfoContentType,
			activeState(subscription.RemainingSeconds(now)))
	}
}

// OnMWI notifies every subscriber whose mailbox counts moved.
//
// The match is on the ACCOUNT rather than a resource key: the event names a mailbox, a subscription
// names a SIP user, and the joining `extensionNumber` is optional. See mwi.Update.MatchesAccount.
func (h *Handler) OnMWI(update mwi.Update) {
	candidates := map[string]struct{}{}
	if update.Extension != "" {
		candidates[update.Extension] = struct{}{}
	}
	if update.Mailbox != "" {
		candidates[update.Mailbox] = struct{}{}
	}

	now := h.now()
	batch := h.newBatch()
	defer batch.close()
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
			h.dispatch(batch, subscription,
				messageSummaryBody(subscription.Entity, update.Counts), messageSummaryContentType,
				activeState(subscription.RemainingSeconds(now)))
		}
	}
}

// Sweep terminates every subscription whose granted interval has lapsed and returns how many it
// removed. Exported so tests can drive it directly instead of waiting for a tick.
func (h *Handler) Sweep(context.Context) int {
	lapsed := h.table.TakeExpired(h.now())
	batch := h.newBatch()
	defer batch.close()
	for _, subscription := range lapsed {
		// RFC 6665 §4.1.2.4: the notifier SHOULD send a terminal notification when a subscription
		// expires. Without it a phone that missed its own refresh window sits believing it is still
		// subscribed, and the lamp stops moving with nothing to tell it why.
		h.dispatch(batch, subscription, nil, contentTypeFor(subscription.Event), StateTerminatedTimeout)
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
	// Sent on the caller's context rather than through dispatch: this runs AFTER the base context is
	// cancelled, so a dispatched notification would be abandoned before it left the process.
	//
	// Bounded-parallel rather than sequential: Notify blocks until its client transaction settles,
	// and the whole loop shares one shutdown deadline, so a few dead phones would otherwise consume
	// it and freeze every other lamp in the fleet.
	workers := min(h.concurrency, len(drained))
	queue := make(chan *Subscription)
	var group sync.WaitGroup
	for range workers {
		group.Go(func() {
			for subscription := range queue {
				req := BuildNotify(subscription, nil, contentTypeFor(subscription.Event),
					StateTerminatedDeactivated, h.contact, h.server)
				if err := h.notifier.Notify(ctx, req); err != nil {
					h.log.Warn("cannot deactivate a subscription on shutdown",
						"resource", subscription.Resource, "error", err)
				}
			}
		})
	}
	for _, subscription := range drained {
		select {
		case queue <- subscription:
		case <-ctx.Done():
			// The shutdown deadline passed. Stop feeding rather than blocking on a worker that is
			// itself waiting on a transaction nobody will answer.
			close(queue)
			group.Wait()
			h.log.Warn("the shutdown deadline passed before every subscription was deactivated",
				"subscriptions", len(drained))
			return len(drained)
		}
	}
	close(queue)
	group.Wait()
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

// authorize runs the digest exchange for a SUBSCRIBE. It answers the transaction itself on every
// failure path and reports whether the caller should continue.
//
// 401 for "no credentials" and "stale nonce" because the device can retry; 403 for everything else,
// because re-challenging a wrong password produces a loop some handsets run forever.
func (h *Handler) authorize(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	fromUser string,
	log *slog.Logger,
) (credentials.Credential, bool) {
	accountAuth := h.auth.ForRequest(req)
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

	if auth.Realm != accountAuth.Realm() {
		log.Info("re-challenging a credential for another realm", "offeredRealm", auth.Realm)
		h.challenge(req, tx, false, log)
		return credentials.Credential{}, false
	}
	if err := accountAuth.CheckNonce(auth.Nonce); err != nil {
		h.challenge(req, tx, errors.Is(err, registrar.ErrNonceStale), log)
		return credentials.Credential{}, false
	}

	// An account may only subscribe AS ITSELF: otherwise any valid account on the realm could send a
	// SUBSCRIBE carrying somebody else's From, which for `message-summary` is another's mailbox.
	if auth.Username != fromUser {
		log.Warn("rejecting a SUBSCRIBE sent as somebody else", "authenticatedAs", auth.Username)
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	credential, err := h.creds.Lookup(ctx, accountAuth.Realm(), auth.Username)
	if err != nil {
		status, reason := statusForbidden, "Forbidden"
		switch {
		case errors.Is(err, credentials.ErrNotFound):
			log.Info("rejecting an unknown account", "username", auth.Username)
		case errors.Is(err, credentials.ErrDisabled):
			log.Info("rejecting a disabled account", "username", auth.Username)
		default:
			// No answer from the credential RPC is not a claim about this account: a 403 tells the
			// phone its credentials are wrong and most handsets stop retrying, so a burst that
			// exceeds the responder's deadline would black out a fleet until somebody re-provisions
			// it. 503 is the retriable answer (RFC 3261 §21.5.4).
			log.Error("cannot look up the account", "username", auth.Username, "error", err)
			status, reason = statusUnavailable, "Service Unavailable"
		}
		h.respond(tx, req, status, reason)
		return credentials.Credential{}, false
	}

	// SUBSCRIBE, not REGISTER: HA2 is MD5(method:uri), so verifying with the wrong method name
	// accepts nothing.
	if err := accountAuth.VerifyRequest(req, auth, credential.HA1); err != nil {
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
// A read failure answers FALSE: a location service that cannot be consulted is not evidence that a
// phone is on the network.
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

func (h *Handler) challenge(req *sip.Request, tx sip.ServerTransaction, stale bool, log *slog.Logger) {
	value, err := h.auth.ForRequest(req).Challenge(stale)
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
