// Package registrar implements sipd's SIP REGISTRAR: the first vertical of the Go SIP edge.
//
// It owns exactly one job — turning an authenticated REGISTER into an AOR → contact binding in the
// `registrations` KV bucket, plus the transition events on the REGISTRATIONS stream — and it
// deliberately owns nothing else. Call routing, INVITE proxying and NAT traversal are the next PG
// wave; everything outside REGISTER and OPTIONS answers 501 rather than half-working.
package registrar

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
	location "github.com/optimiqs/optimiq-voice/apps/sipd/internal/aor"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

// SIP statuses this registrar emits. sipgo has no constants for them and bare integers at a call
// site are how a 403 becomes a 423 in review.
const (
	statusOK               = 200
	statusBadRequest       = 400
	statusUnauthorized     = 401
	statusForbidden        = 403
	statusNotImplemented   = 501
	statusServerError      = 500
	statusIntervalTooBrief = 423
)

// allowedMethods is the Allow header. It is the honest list, not an aspirational one: advertising
// INVITE before the proxy exists would make a phone try to place a call through a registrar.
//
// REFER is on it because `internal/transfer` answers it — a desk phone that does not see REFER
// advertised may grey out its own TRANSFER key rather than trying. SUBSCRIBE joined it for the same
// reason when `internal/subscribe` shipped: several vendors probe the Allow set before arming a BLF
// key, and a key that is never armed is indistinguishable from presence that does not work.
const allowedMethods = "REGISTER, OPTIONS, REFER, SUBSCRIBE"

// Options configures a Registrar. Every dependency is an interface so the unit tests run without a
// broker, a socket or a clock.
type Options struct {
	InstanceID  string
	MaxContacts int
	// Realm is the digest realm. It must match the Authenticator's.
	Realm string
	Auth  *Authenticator
	// Expiry clamps the interval a device asks for.
	Expiry ExpiryPolicy
	// Credentials resolves the account behind an AOR.
	Credentials credentials.Store
	// Bindings is the location service (the registrations KV bucket in production).
	Bindings kv.Store
	// Publisher emits the transition events. Failures here never fail a REGISTER — see bind().
	Publisher events.Publisher

	Logger *slog.Logger
	// Source is the `source` field of every envelope; "sipd".
	Source string
	// ServerHeader is the Server: header value.
	ServerHeader string
	// AllowEvents is the `Allow-Events` value advertised on OPTIONS — `internal/subscribe`'s list,
	// passed in rather than imported because that package depends on THIS one for the digest
	// authenticator and the import cannot go both ways. Empty omits the header, which is the honest
	// answer for a build with no subscription handler wired.
	AllowEvents string
	// SweepInterval is how often Run looks for lapsed bindings.
	SweepInterval time.Duration
	// BaseContext parents every store and publish operation, so a shutdown cancels work in flight.
	// Modelled on net/http.Server.BaseContext: sipgo's handler signature carries no context.
	BaseContext context.Context
	// OperationTimeout bounds one KV write or one publish.
	OperationTimeout time.Duration
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now func() time.Time
}

// Registrar handles REGISTER and OPTIONS and sweeps lapsed bindings.
//
// It holds no package-level state: everything is on this struct, so a test can run several
// independent registrars in one process and a future multi-realm edge is a matter of constructing
// more of them.
type Registrar struct {
	instanceID  string
	maxContacts int
	realm       string
	auth        *Authenticator
	expiry      ExpiryPolicy
	creds       credentials.Store
	bindings    kv.Store
	publisher   events.Publisher

	log           *slog.Logger
	source        string
	server        string
	allowEvents   string
	sweepInterval time.Duration
	baseCtx       context.Context
	opTimeout     time.Duration
	now           func() time.Time

	// mu guards tracked. Bindings granted by THIS instance are tracked locally so their exact
	// deadline is known; see the Sweep doc comment for why that is not the KV bucket's TTL.
	mu      sync.Mutex
	tracked map[string]kv.Binding
}

// New validates the options and builds a Registrar.
func New(opts Options) (*Registrar, error) {
	switch {
	case strings.TrimSpace(opts.Realm) == "":
		return nil, errors.New("registrar: Realm is required")
	case opts.Auth == nil:
		return nil, errors.New("registrar: Auth is required")
	case opts.Credentials == nil:
		return nil, errors.New("registrar: Credentials is required")
	case opts.Bindings == nil:
		return nil, errors.New("registrar: Bindings is required")
	case opts.Publisher == nil:
		return nil, errors.New("registrar: Publisher is required")
	}
	if opts.Auth.Realm() != opts.Realm {
		return nil, fmt.Errorf("registrar: the authenticator challenges for %q but the registrar serves %q",
			opts.Auth.Realm(), opts.Realm)
	}
	if err := opts.Expiry.Validate(); err != nil {
		return nil, err
	}

	registrar := &Registrar{
		instanceID:    opts.InstanceID,
		maxContacts:   opts.MaxContacts,
		realm:         opts.Realm,
		auth:          opts.Auth,
		expiry:        opts.Expiry,
		creds:         opts.Credentials,
		bindings:      opts.Bindings,
		publisher:     opts.Publisher,
		log:           opts.Logger,
		source:        opts.Source,
		server:        opts.ServerHeader,
		allowEvents:   opts.AllowEvents,
		sweepInterval: opts.SweepInterval,
		baseCtx:       opts.BaseContext,
		opTimeout:     opts.OperationTimeout,
		now:           opts.Now,
		tracked:       make(map[string]kv.Binding),
	}
	if registrar.log == nil {
		registrar.log = slog.Default()
	}
	if registrar.maxContacts == 0 {
		registrar.maxContacts = 5
	}
	if registrar.maxContacts < 1 || registrar.maxContacts > location.MaxStoredContacts {
		return nil, fmt.Errorf("registrar: MaxContacts must be between 1 and %d", location.MaxStoredContacts)
	}
	if registrar.source == "" {
		registrar.source = "sipd"
	}
	if registrar.server == "" {
		registrar.server = "optimiq-sipd"
	}
	if registrar.sweepInterval <= 0 {
		registrar.sweepInterval = 5 * time.Second
	}
	if registrar.baseCtx == nil {
		registrar.baseCtx = context.Background()
	}
	if registrar.opTimeout <= 0 {
		registrar.opTimeout = 3 * time.Second
	}
	if registrar.now == nil {
		registrar.now = time.Now
	}
	return registrar, nil
}

// ---------------------------------------------------------------------------------------------
// SIP handlers
// ---------------------------------------------------------------------------------------------

// HandleRegister authenticates and atomically updates every Contact in one REGISTER.
func (r *Registrar) HandleRegister(req *sip.Request, tx sip.ServerTransaction) {
	ctx, cancel := context.WithTimeout(r.baseCtx, r.opTimeout)
	defer cancel()

	log := r.log.With(
		"method", "REGISTER",
		"peer", req.Source(),
		"transport", req.Transport(),
		"sipCallId", headerValue(req, "Call-ID"),
	)

	aor, user, ok := addressOfRecord(req)
	if !ok {
		log.Info("rejecting a REGISTER with no usable To address")
		r.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	log = log.With("aor", aor)

	credential, authorized := r.authorize(ctx, req, tx, user, log)
	if !authorized {
		return
	}

	aorHash, err := contract.AORSubjectToken(aor)
	if err != nil {
		log.Error("cannot derive the AOR subject token", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}

	contacts := req.GetHeaders("Contact")
	if len(contacts) == 0 {
		// No Contact at all is a QUERY, not a binding request (RFC 3261 §10.2.3).
		r.respondWithCurrentBinding(ctx, req, tx, credential.OrgID, aorHash, log)
		return
	}

	r.updateRegistration(ctx, req, tx, credential, aor, aorHash, contacts, log)
}

// HandleOptions answers the keepalive every SIP element on the planet uses to decide whether we are
// alive. It must be cheap and unconditional: an OPTIONS that authenticates is an OPTIONS that
// reports "down" whenever the credential store is slow.
func (r *Registrar) HandleOptions(req *sip.Request, tx sip.ServerTransaction) {
	res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)
	res.AppendHeader(sip.NewHeader("Allow", allowedMethods))
	if r.allowEvents != "" {
		res.AppendHeader(sip.NewHeader("Allow-Events", r.allowEvents))
	}
	res.AppendHeader(sip.NewHeader("Accept", "application/sdp"))
	r.send(tx, res)
}

// HandleUnsupported answers everything this edge does not implement yet.
//
// 501 rather than 405: the method is a legitimate SIP method that this element does not implement,
// which is exactly what 501 means. 405 would claim the method is not allowed on this resource and
// would oblige us to advertise an Allow set the caller could act on.
func (r *Registrar) HandleUnsupported(req *sip.Request, tx sip.ServerTransaction) {
	r.log.Debug("rejecting an unimplemented method",
		"method", req.Method.String(), "peer", req.Source())
	res := sip.NewResponseFromRequest(req, statusNotImplemented, "Not Implemented", nil)
	res.AppendHeader(sip.NewHeader("Allow", allowedMethods))
	r.send(tx, res)
}

// ---------------------------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------------------------

// authorize runs the digest exchange. It answers the transaction itself on every failure path and
// reports whether the caller should continue.
//
// # Status choices
//
//   - 401 + challenge for "no credentials" and "stale/forged nonce": the device can and should
//     retry, and with stale=true it does so without prompting a human.
//   - 403 for "wrong password", "unknown account", "disabled account" and "authenticated as
//     somebody else". Re-challenging a wrong password produces a challenge/retry loop that some
//     phones run forever; a final answer stops it. The three account outcomes are deliberately
//     indistinguishable so the response cannot be used to enumerate extensions.
func (r *Registrar) authorize(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	aorUser string,
	log *slog.Logger,
) (credentials.Credential, bool) {
	accountAuth := r.auth.ForRequest(req)
	auth, err := ParseAuthorization(headerValue(req, "Authorization"))
	if err != nil {
		if errors.Is(err, ErrNoAuthorization) {
			r.challenge(req, tx, false, log)
			return credentials.Credential{}, false
		}
		log.Info("rejecting a malformed Authorization header", "error", err)
		r.respond(tx, req, statusBadRequest, "Bad Request")
		return credentials.Credential{}, false
	}

	if auth.Realm != accountAuth.Realm() {
		log.Info("re-challenging a credential for another realm", "offeredRealm", auth.Realm)
		r.challenge(req, tx, false, log)
		return credentials.Credential{}, false
	}
	if err := accountAuth.CheckNonce(auth.Nonce); err != nil {
		r.challenge(req, tx, errors.Is(err, ErrNonceStale), log)
		return credentials.Credential{}, false
	}

	// An authenticated account may only bind ITS OWN address of record. Without this check any
	// valid account on the realm could register a contact for any extension and silently steal its
	// calls — the classic third-party-registration hole.
	if auth.Username != aorUser {
		log.Warn("rejecting a registration for somebody else's AOR", "authenticatedAs", auth.Username)
		r.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	credential, err := r.creds.Lookup(ctx, accountAuth.Realm(), auth.Username)
	if err != nil {
		// Unknown and disabled are logged apart and answered the same.
		switch {
		case errors.Is(err, credentials.ErrNotFound):
			log.Info("rejecting an unknown account", "username", auth.Username)
		case errors.Is(err, credentials.ErrDisabled):
			log.Info("rejecting a disabled account", "username", auth.Username)
		default:
			log.Error("cannot look up the account", "username", auth.Username, "error", err)
		}
		r.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	if err := accountAuth.VerifyRequest(req, auth, credential.HA1); err != nil {
		if errors.Is(err, ErrNonceStale) {
			r.challenge(req, tx, true, log)
			return credentials.Credential{}, false
		}
		log.Warn("rejecting a failed digest", "username", auth.Username, "reason", err)
		r.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	return credential, true
}

// ---------------------------------------------------------------------------------------------
// binding lifecycle
// ---------------------------------------------------------------------------------------------

func (r *Registrar) respondWithCurrentBinding(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	orgID, aorHash string,
	log *slog.Logger,
) {
	binding, found, err := r.bindings.Get(ctx, orgID, aorHash)
	if err != nil {
		log.Error("cannot read the binding for a query", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}
	if !found {
		res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)
		res.AppendHeader(sip.NewHeader("Server", r.server))
		r.send(tx, res)
		return
	}
	r.send(tx, r.okWithBinding(req, binding))
}

// ---------------------------------------------------------------------------------------------
// expiry sweeping
// ---------------------------------------------------------------------------------------------

// Run sweeps lapsed bindings until the context is cancelled.
//
// # Why a ticker over locally-owned bindings, and not a KV watch
//
// The obvious alternative is to watch the registrations bucket and emit `expired` when the server
// drops a key. It does not work here, for two reasons:
//
//  1. The bucket TTL is one hour (packages/events-go: RegistrationsKV) because it is a BACKSTOP for
//     a crashed registrar, not the expiry mechanism. Granted intervals are 60–3600 seconds. Waiting
//     for the bucket TTL would report a phone as registered up to an hour after it stopped
//     refreshing — which is precisely the "calls ring into nowhere" failure the binding exists to
//     prevent.
//  2. A watch fires on every instance. Three replicas watching one bucket would publish three
//     `expired` events for one lapse, and the anti-fraud and presence consumers would count them.
//
// So the instance that GRANTED a binding owns its deadline: it holds the exact expiry locally,
// notices within one sweep interval, deletes the key and publishes once. Rehydrate re-establishes
// that ownership after a restart, and the bucket TTL still cleans up after an instance that dies
// without ever coming back.
func (r *Registrar) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.sweepInterval)
	defer ticker.Stop()

	r.log.Info("expiry sweeper started", "intervalSeconds", int(r.sweepInterval/time.Second))
	for {
		select {
		case <-ctx.Done():
			r.log.Info("expiry sweeper stopped")
			return ctx.Err()
		case <-ticker.C:
			if swept := r.Sweep(ctx); swept > 0 {
				r.log.Info("swept lapsed bindings", "count", swept)
			}
		}
	}
}

// Sweep removes only contacts that are still expired at the atomic write, so a refresh on
// another SIP server cannot be deleted by this server's stale deadline.
func (r *Registrar) Sweep(ctx context.Context) int {
	r.mu.Lock()
	tracked := make([]kv.Binding, 0, len(r.tracked))
	for _, binding := range r.tracked {
		tracked = append(tracked, binding)
	}
	r.mu.Unlock()
	expired := 0
	for _, hint := range tracked {
		before, after, err := r.bindings.Update(ctx, hint.OrgID, hint.AORHash, func(previous *kv.Binding) (*kv.Binding, error) {
			if previous == nil {
				return nil, nil
			}
			live, removed := location.FromBinding(*previous).Expire(r.now())
			if len(removed) == 0 {
				return previous, nil
			}
			return bindingForSet(*previous, live, r.now()), nil
		})
		if err != nil {
			r.log.Error("cannot sweep registration", "error", err)
			continue
		}
		trackedBefore := before
		if trackedBefore == nil {
			trackedBefore = &hint
		}
		r.trackChange(hint.OrgID, hint.AORHash, trackedBefore, after)
		for _, contact := range removedContacts(before, after) {
			r.publishRemoved(ctx, hint, contact, true)
			expired++
		}
	}
	return expired
}

// Rehydrate adopts the bindings already in the bucket, so a restarted instance keeps expiring the
// devices a previous one registered instead of leaving them to the one-hour bucket TTL.
//
// Bindings that have ALREADY lapsed are adopted too: the very next Sweep removes them and emits the
// `expired` event whoever crashed never got to publish.
func (r *Registrar) Rehydrate(ctx context.Context) (int, error) {
	bindings, err := r.bindings.All(ctx)
	if err != nil {
		return 0, fmt.Errorf("registrar: rehydrating bindings: %w", err)
	}

	adopted := 0
	r.mu.Lock()
	for _, binding := range bindings {
		key, err := binding.Key()
		if err != nil {
			continue
		}
		r.tracked[key] = binding
		adopted++
	}
	r.mu.Unlock()
	return adopted, nil
}

// TrackedBindings returns how many bindings this instance is responsible for expiring.
func (r *Registrar) TrackedBindings() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.tracked)
}

// ---------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------

func (r *Registrar) challenge(req *sip.Request, tx sip.ServerTransaction, stale bool, log *slog.Logger) {
	value, err := r.auth.ForRequest(req).Challenge(stale)
	if err != nil {
		log.Error("cannot mint a digest challenge", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}
	res := sip.NewResponseFromRequest(req, statusUnauthorized, "Unauthorized", nil)
	res.AppendHeader(sip.NewHeader("WWW-Authenticate", value))
	res.AppendHeader(sip.NewHeader("Server", r.server))
	r.send(tx, res)
}

func (r *Registrar) respond(tx sip.ServerTransaction, req *sip.Request, status int, reason string) {
	res := sip.NewResponseFromRequest(req, status, reason, nil)
	res.AppendHeader(sip.NewHeader("Server", r.server))
	r.send(tx, res)
}

// okWithBinding builds the 200 that tells the device what it actually got, which is not always what
// it asked for: the Contact carries the GRANTED interval, and a phone that asked for 30 seconds and
// received 60 refreshes on 60.
func (r *Registrar) okWithBinding(req *sip.Request, binding kv.Binding) *sip.Response {
	res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)

	now := r.now()
	for _, contact := range location.FromBinding(binding).Contacts() {
		if contact.Expired(now) {
			continue
		}
		var uri sip.Uri
		if err := sip.ParseUri(contact.URI, &uri); err != nil {
			continue
		}
		params := sip.NewParams()
		remaining := int((contact.ExpiresAt.Sub(now) + time.Second - 1) / time.Second)
		params.Add("expires", strconv.Itoa(remaining))
		params.Add("q", strconv.FormatFloat(contact.Q, 'f', 3, 64))
		if contact.Instance != "" {
			params.Add("+sip.instance", `"<`+contact.Instance+`>"`)
		}
		if contact.RegID > 0 {
			params.Add("reg-id", strconv.Itoa(contact.RegID))
		}
		res.AppendHeader(&sip.ContactHeader{Address: uri, Params: params})
	}
	res.AppendHeader(sip.NewHeader("Expires", strconv.Itoa(binding.ExpiresInSeconds)))
	res.AppendHeader(sip.NewHeader("Server", r.server))
	return res
}

// send writes a response and logs a transport failure rather than propagating it: by the time a
// response cannot be written the transaction is already lost, and there is nobody left to tell.
//
// Every header value this registrar adds is either a constant, a number, a digest challenge it
// minted itself, or a Contact that has been round-tripped through sip.ParseUri — so no
// device-controlled string reaches the wire unparsed, which is the CRLF-injection case sipgo's
// SECURITY note is about. Keep that property when adding headers here.
func (r *Registrar) send(tx sip.ServerTransaction, res *sip.Response) {
	if err := tx.Respond(res); err != nil {
		r.log.Error("cannot send a response", "error", err, "status", res.StatusCode)
	}
}

// ---------------------------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------------------------

// addressOfRecord extracts the AOR being registered from the To header, plus its user part.
//
// It is the To header and not the From: a third party MAY register on behalf of another AOR, and
// RFC 3261 §10.2 makes To the address of record in every case.
func addressOfRecord(req *sip.Request) (aor string, user string, ok bool) {
	to := req.To()
	if to == nil {
		return "", "", false
	}
	uri := to.Address
	if uri.User == "" || uri.Host == "" {
		return "", "", false
	}
	scheme := uri.Scheme
	if scheme == "" {
		scheme = "sip"
	}
	// Host is lower-cased (case-insensitive per RFC 3261 §19.1.4) so the AOR — and therefore the
	// subject token and the KV key — is stable no matter how the device spelled the domain.
	return scheme + ":" + uri.User + "@" + strings.ToLower(uri.Host), uri.User, true
}

func headerValue(req *sip.Request, name string) string {
	header := req.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

// expiresHeader reads the request-level Expires header. sipgo's default parser leaves it generic,
// so it arrives as a string.
func expiresHeader(req *sip.Request) (time.Duration, bool) {
	raw := strings.TrimSpace(headerValue(req, "Expires"))
	if raw == "" {
		return 0, false
	}
	seconds, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		return 0, false
	}
	return time.Duration(seconds) * time.Second, true
}

// contactExpires resolves the interval for one contact. A `expires` parameter on the Contact wins
// over the request-level Expires header (RFC 3261 §10.2.1.1), because a device with several
// contacts may want different lifetimes for each.
func contactExpires(
	contact *sip.ContactHeader,
	headerValue time.Duration,
	headerStated bool,
) (time.Duration, bool) {
	if raw, present := contact.Params.Get("expires"); present {
		if seconds, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && seconds >= 0 {
			return time.Duration(seconds) * time.Second, true
		}
	}
	return headerValue, headerStated
}

func paramOr(contact *sip.ContactHeader, name string) string {
	value, _ := contact.Params.Get(name)
	return strings.Trim(value, `"`)
}

func cseqOf(req *sip.Request) uint32 {
	if header := req.CSeq(); header != nil {
		return header.SeqNo
	}
	return 0
}

// transportOf maps sipgo's transport name onto the contract vocabulary, defaulting to udp for
// anything unrecognised rather than writing a value the TypeScript schema would reject.
func transportOf(req *sip.Request) contract.SIPTransport {
	transport := contract.SIPTransport(strings.ToLower(req.Transport()))
	if !transport.Valid() {
		return contract.SIPTransportUDP
	}
	return transport
}

// optional turns "" into a nil *string, so an unknown value is ABSENT on the wire rather than an
// empty string the consumer has to special-case.
func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
