// Package registrar implements sipd's SIP REGISTRAR.
//
// It turns an authenticated REGISTER into an AOR to contact binding in the `registrations` KV
// bucket and emits the transition events on the REGISTRATIONS stream. Everything outside REGISTER
// and OPTIONS answers 501.
package registrar

import (
	"cmp"
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
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

// SIP statuses this registrar emits; sipgo has no constants for them.
const (
	statusOK               = 200
	statusBadRequest       = 400
	statusUnauthorized     = 401
	statusForbidden        = 403
	statusNotImplemented   = 501
	statusServerError      = 500
	statusIntervalTooBrief = 423
	statusUnavailable      = 503
)

// allowedMethods is the Allow header. It lists only methods this edge actually answers: a phone
// that sees an unhandled method advertised will try to use it, and one that does not see REFER or
// SUBSCRIBE may disable its transfer or BLF keys outright.
const allowedMethods = "REGISTER, OPTIONS, REFER, SUBSCRIBE"

// Options configures a Registrar. Every dependency is an interface so tests need no broker or socket.
type Options struct {
	InstanceID  string
	MaxContacts int
	// Realm is the digest realm. It must match the Authenticator's.
	Realm string
	Auth  *Authenticator
	// Expiry clamps the interval a device asks for.
	Expiry ExpiryPolicy
	// RegistrationACL is the `scope=registration` blocklist, consulted before anything else on the
	// REGISTER path. Nil disables the check, which is what a deployment with no such entries wants.
	RegistrationACL *profile.ACL
	// Lockout throttles credential guessing. Shared with every other handler that authenticates, so
	// a spray cannot get one budget per method. Nil disables it.
	Lockout *Lockout
	// Credentials resolves the account behind an AOR.
	Credentials credentials.Store
	// Bindings is the location service (the registrations KV bucket in production).
	Bindings kv.Store
	// Connections probes the transport layer for a connection-bound binding's socket. Nil disables
	// the unreachable sweep entirely, which is what a process with no WebSocket listener wants.
	Connections ConnectionProbe
	// Publisher emits the transition events. Failures here never fail a REGISTER — see bind().
	Publisher events.Publisher

	Logger *slog.Logger
	// Source is the `source` field of every envelope; "sipd".
	Source string
	// ServerHeader is the Server: header value.
	ServerHeader string
	// AllowEvents is the `Allow-Events` value advertised on OPTIONS. It is passed in rather than
	// imported from internal/subscribe, which depends on this package. Empty omits the header.
	AllowEvents string
	// SweepInterval is how often Run looks for lapsed bindings.
	SweepInterval time.Duration
	// BaseContext parents every store and publish operation, so a shutdown cancels work in flight.
	// sipgo's handler signature carries no context.
	BaseContext context.Context
	// OperationTimeout bounds one KV write or one publish.
	OperationTimeout time.Duration
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now func() time.Time
}

// Registrar handles REGISTER and OPTIONS and sweeps lapsed bindings. It holds no package-level
// state, so several independent registrars can run in one process.
type Registrar struct {
	instanceID  string
	maxContacts int
	realm       string
	auth        *Authenticator
	expiry      ExpiryPolicy
	sourceACL   *profile.ACL
	lockout     *Lockout
	creds       credentials.Store
	bindings    kv.Store
	connections ConnectionProbe
	publisher   events.Publisher

	log           *slog.Logger
	source        string
	server        string
	allowEvents   string
	sweepInterval time.Duration
	baseCtx       context.Context
	opTimeout     time.Duration
	now           func() time.Time

	// authFailures bounds how often a refused REGISTER is reported. See AuthFailureInterval.
	authFailures *authFailureLimiter

	// mu guards tracked. Bindings granted by this instance are tracked locally so their exact
	// deadline is known; see Run for why the KV bucket's TTL is not that deadline.
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
		sourceACL:     opts.RegistrationACL,
		lockout:       opts.Lockout,
		creds:         opts.Credentials,
		bindings:      opts.Bindings,
		connections:   opts.Connections,
		publisher:     opts.Publisher,
		log:           opts.Logger,
		source:        opts.Source,
		server:        opts.ServerHeader,
		allowEvents:   opts.AllowEvents,
		sweepInterval: opts.SweepInterval,
		baseCtx:       opts.BaseContext,
		opTimeout:     opts.OperationTimeout,
		now:           opts.Now,
		authFailures:  newAuthFailureLimiter(AuthFailureInterval),
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

// HandleRegister authenticates and atomically updates every Contact in one REGISTER.
func (r *Registrar) HandleRegister(req *sip.Request, tx sip.ServerTransaction) {
	ctx, cancel := context.WithTimeout(r.baseCtx, r.opTimeout)
	defer cancel()

	log := &requestLog{base: r.log, req: req}

	if !r.admitSource(req, tx, log) {
		return
	}

	aor, user, ok := addressOfRecord(req)
	if !ok {
		log.Info("rejecting a REGISTER with no usable To address")
		r.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	log.aor = aor

	credential, authorized := r.authorize(ctx, req, tx, aor, user, log)
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

// admitSource evaluates the `scope=registration` ACL against the OBSERVED transport source, before
// the AOR is parsed, before a credential is looked up and before a challenge is minted.
//
// First rather than after authentication, because that is the whole value of the rule: a blocked
// network's REGISTER storm costs one longest-prefix match instead of a credential lookup and a
// nonce per packet. It is a blocklist in front of the digest and never a substitute for it — see
// profile.NewWatchedBlocklist.
func (r *Registrar) admitSource(req *sip.Request, tx sip.ServerTransaction, log *requestLog) bool {
	if r.sourceACL == nil {
		return true
	}
	entry, allowed := r.sourceACL.Match(req.Source())
	if allowed {
		return true
	}
	// 403 and not 401: the address is refused whatever credential it holds, and a challenge would
	// invite the retry loop the rule exists to stop.
	log.Info("refusing a REGISTER from a source outside the registration ACL",
		"rule", entry.Label, "network", entry.Prefix.String())
	r.respond(tx, req, statusForbidden, "Forbidden")
	return false
}

// HandleOptions answers the liveness keepalive. It is unconditional and unauthenticated, so a slow
// credential store cannot make this element look down.
func (r *Registrar) HandleOptions(req *sip.Request, tx sip.ServerTransaction) {
	res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)
	res.AppendHeader(sip.NewHeader("Allow", allowedMethods))
	if r.allowEvents != "" {
		res.AppendHeader(sip.NewHeader("Allow-Events", r.allowEvents))
	}
	res.AppendHeader(sip.NewHeader("Accept", "application/sdp"))
	r.send(tx, res)
}

// HandleUnsupported answers everything this edge does not implement, with 501 rather than 405:
// the method is legitimate SIP, it is this element that does not implement it.
func (r *Registrar) HandleUnsupported(req *sip.Request, tx sip.ServerTransaction) {
	r.log.Debug("rejecting an unimplemented method",
		"method", req.Method.String(), "peer", req.Source())
	res := sip.NewResponseFromRequest(req, statusNotImplemented, "Not Implemented", nil)
	res.AppendHeader(sip.NewHeader("Allow", allowedMethods))
	r.send(tx, res)
}

// authorize runs the digest exchange. It answers the transaction itself on every failure path and
// reports whether the caller should continue.
//
// Missing credentials and a stale or forged nonce get 401 plus a challenge, since the device can
// retry. Everything else gets a final 403: re-challenging a wrong password loops some phones for
// ever, and wrong password, unknown account and disabled account are answered identically so the
// response cannot be used to enumerate extensions.
//
// The failures reported as `auth-failed` are exactly those reached AFTER the credential lookup, so
// the organization on the event's subject is one the directory answered with rather than one this
// edge guessed from a header an attacker wrote.
func (r *Registrar) authorize(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	aor, aorUser string,
	log *requestLog,
) (credentials.Credential, bool) {
	accountAuth := r.auth.ForRequest(req)
	if RequestRealm(req) == "" {
		// No tenant matched: the request named no domain, so the challenge carries the deployment
		// default. Logged because a fleet serving several tenants should see none of these.
		log.Info("challenging with the deployment default realm: the request named no domain",
			"realm", accountAuth.Realm())
	}
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

	// An authenticated account may only bind its own address of record; otherwise any valid account
	// on the realm could register a contact for any extension and steal its calls.
	if auth.Username != aorUser {
		log.Warn("rejecting a registration for somebody else's AOR", "authenticatedAs", auth.Username)
		r.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	// Before the lookup, and answered exactly as an unknown account is: a spray that could tell a
	// locked account from an absent one would have an enumeration oracle, and one that reached the
	// directory at all would cost an RPC per packet.
	if refusal, locked := r.lockout.Locked(req.Source(), auth.Username); locked {
		log.Info("refusing a REGISTER from a locked source",
			"username", auth.Username, "retryAfterSeconds", int(refusal.RetryAfter.Seconds()),
			"scope", lockoutScope(refusal))
		r.publishAuthFailure(ctx, req, refusal.OrgID, cmp.Or(refusal.AOR, aor), auth.Username,
			contract.RegistrationAuthFailedReasonBadCredentials, true)
		r.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	credential, err := r.creds.Lookup(ctx, accountAuth.Realm(), auth.Username)
	if err != nil {
		status, reason := statusForbidden, "Forbidden"
		switch {
		case errors.Is(err, credentials.ErrNotFound):
			// A guess at an account that exists nowhere still counts: a spray that walked extension
			// numbers rather than passwords would otherwise never trip the source cap.
			r.lockout.Fail(req.Source(), auth.Username, "", "")
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
		r.respond(tx, req, status, reason)
		return credentials.Credential{}, false
	}

	if err := accountAuth.VerifyRequest(req, auth, credential.HA1); err != nil {
		if errors.Is(err, ErrNonceStale) {
			// A replayed nonce count is a captured credential being re-sent, not the honest expiry
			// the rest of this branch handles, so it is the only stale case worth recording.
			if errors.Is(err, ErrNonceReplayed) {
				r.publishAuthFailure(ctx, req, credential.OrgID, aor, auth.Username,
					contract.RegistrationAuthFailedReasonStaleNonce, false)
			}
			r.challenge(req, tx, true, log)
			return credentials.Credential{}, false
		}
		// A digest that does not verify is the ONLY signal this edge gets that the HA1 it holds may
		// be the previous one: the credential RPC is pull-only and apps/api publishes nothing when a
		// SIP secret is rotated, so there is no invalidation to subscribe to. Re-ask once — the
		// store rate-bounds it — and re-verify, or a rotation refuses a correctly re-REGISTERing
		// phone for a whole positive TTL.
		if fresh, refreshed := r.refresh(ctx, accountAuth.Realm(), auth.Username, credential); refreshed {
			if retry := accountAuth.VerifyRequest(req, auth, fresh.HA1); retry == nil {
				log.Info("accepting a REGISTER against a re-fetched credential; the cached one was stale",
					"username", auth.Username)
				r.lockout.Succeed(req.Source(), auth.Username)
				return fresh, true
			}
		}
		r.lockout.Fail(req.Source(), auth.Username, credential.OrgID, aor)
		log.Warn("rejecting a failed digest", "username", auth.Username, "reason", err)
		r.publishAuthFailure(ctx, req, credential.OrgID, aor, auth.Username,
			contract.RegistrationAuthFailedReasonBadCredentials, false)
		r.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	r.lockout.Succeed(req.Source(), auth.Username)
	return credential, true
}

// lockoutScope names which counter refused, for the log line an operator reads when a whole office
// stops registering.
func lockoutScope(refusal LockoutRefusal) string {
	if refusal.Source {
		return "source"
	}
	return "account"
}

func (r *Registrar) respondWithCurrentBinding(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	orgID, aorHash string,
	log *requestLog,
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

// Run sweeps lapsed bindings until the context is cancelled.
//
// The instance that granted a binding owns its deadline and publishes `expired` exactly once, rather
// than every instance watching the bucket and publishing one event per replica. The bucket's
// one-hour TTL is only a backstop for a crashed registrar; granted intervals are 60-3600 seconds, so
// waiting for it would report a phone as registered long after it stopped refreshing.
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
			if swept := r.SweepUnreachable(ctx); swept > 0 {
				r.log.Info("swept bindings whose connection closed", "count", swept)
			}
		}
	}
}

// Sweep removes only contacts that are still expired at the atomic write, so a refresh on another
// SIP server cannot be deleted by this server's stale deadline.
//
// Only bindings this instance already believes have lapsed are visited, which costs one KV round
// trip per expired binding rather than per tracked one. The CAS callback still re-checks, so a
// refresh that landed elsewhere between the filter and the write is not deleted.
func (r *Registrar) Sweep(ctx context.Context) int {
	now := r.now()
	r.mu.Lock()
	tracked := make([]kv.Binding, 0, len(r.tracked))
	for _, binding := range r.tracked {
		if !lapsed(binding, now) {
			continue
		}
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

// lapsed reports whether anything in a tracked binding is due to be removed. Per-contact deadlines
// are the authority when there are contacts, since the binding's own ExpiresAt is the longest-lived
// contact's and would keep a lapsed second device bound.
func lapsed(binding kv.Binding, now time.Time) bool {
	if len(binding.Contacts) == 0 {
		return binding.Expired(now)
	}
	for _, contact := range binding.Contacts {
		if !now.Before(contact.ExpiresAt.Time) {
			return true
		}
	}
	return false
}

// Rehydrate adopts the bindings already in the bucket, so a restarted instance keeps expiring the
// devices a previous one registered. Already-lapsed bindings are adopted too, so the next Sweep
// emits the `expired` event the crashed instance never published.
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

// LastKnown implements kv.Hint: the binding this instance last wrote or adopted for that AOR.
//
// It lets a re-REGISTER CAS straight against the known revision instead of reading back a value this
// process wrote, halving the broker round trips inside the SIP transaction. A stale revision is
// refused by the server and the store re-reads, so a lost race cannot look like a won one.
func (r *Registrar) LastKnown(orgID, aorHash string) (kv.Binding, bool) {
	key, err := contract.RegistrationKVKey(orgID, aorHash)
	if err != nil {
		return kv.Binding{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	binding, found := r.tracked[key]
	return binding, found
}

// TrackedBindings returns how many bindings this instance is responsible for expiring.
func (r *Registrar) TrackedBindings() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.tracked)
}

func (r *Registrar) challenge(req *sip.Request, tx sip.ServerTransaction, stale bool, log *requestLog) {
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

// okWithBinding builds the 200. Each Contact carries the granted interval, not the requested one,
// so the device refreshes on what it actually got.
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

// send writes a response and logs a transport failure rather than propagating it; the transaction is
// already lost by then.
//
// Every header value added here must be a constant, a number, a challenge minted by this process, or
// a value round-tripped through sip.ParseUri, so no device-controlled string reaches the wire
// unparsed (the CRLF-injection case in sipgo's SECURITY note).
func (r *Registrar) send(tx sip.ServerTransaction, res *sip.Response) {
	if err := tx.Respond(res); err != nil {
		r.log.Error("cannot send a response", "error", err, "status", res.StatusCode)
	}
}

// addressOfRecord extracts the AOR being registered from the To header, plus its user part. To and
// not From: RFC 3261 §10.2 makes To the address of record even for third-party registration.
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
	// Host is lower-cased (case-insensitive per RFC 3261 §19.1.4) so the AOR, and therefore the
	// subject token and the KV key, is stable however the device spelled the domain.
	return scheme + ":" + uri.User + "@" + strings.ToLower(uri.Host), uri.User, true
}

// requestLog carries the fields every line about one request should name, materialising the child
// logger only when a line is actually emitted: the REGISTER success path logs nothing, and building
// one up front cost ~5% of all allocations under a registration storm.
//
// Owned by the goroutine handling the request; not safe for concurrent use.
type requestLog struct {
	base  *slog.Logger
	req   *sip.Request
	aor   string
	built *slog.Logger
}

func (l *requestLog) logger() *slog.Logger {
	if l.built == nil {
		l.built = l.base.With(
			"method", l.req.Method.String(),
			"peer", l.req.Source(),
			"transport", l.req.Transport(),
			"sipCallId", headerValue(l.req, "Call-ID"),
			"aor", l.aor,
		)
	}
	return l.built
}

func (l *requestLog) Debug(msg string, args ...any) { l.logger().Debug(msg, args...) }
func (l *requestLog) Info(msg string, args ...any)  { l.logger().Info(msg, args...) }
func (l *requestLog) Warn(msg string, args ...any)  { l.logger().Warn(msg, args...) }
func (l *requestLog) Error(msg string, args ...any) { l.logger().Error(msg, args...) }

func headerValue(req *sip.Request, name string) string {
	header := req.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

// expiresHeader reads the request-level Expires header, which sipgo's parser leaves as a string.
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

// contactExpires resolves the interval for one contact. An `expires` parameter on the Contact wins
// over the request-level Expires header (RFC 3261 §10.2.1.1).
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

// transportOf maps sipgo's transport name onto the contract vocabulary, defaulting to udp rather
// than writing a value the schema would reject.
func transportOf(req *sip.Request) contract.SIPTransport {
	transport := contract.SIPTransport(strings.ToLower(req.Transport()))
	if !transport.Valid() {
		return contract.SIPTransportUDP
	}
	return transport
}

// optional turns "" into a nil *string, so an unknown value is absent on the wire.
func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
