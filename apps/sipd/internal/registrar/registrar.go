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
	realm     string
	auth      *Authenticator
	expiry    ExpiryPolicy
	creds     credentials.Store
	bindings  kv.Store
	publisher events.Publisher

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

// HandleRegister implements RFC 3261 §10.3 for a single binding per AOR.
//
// Multiple simultaneous contacts per AOR (one desk phone plus one softphone, which is what makes
// forking useful) are NOT supported yet: the location model is one binding per AOR, and adding the
// second is a change to the KV value shape as well as to this handler. It is the first thing the
// proxy wave will need.
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

	contact, ok := contacts[0].(*sip.ContactHeader)
	if !ok {
		log.Info("rejecting a REGISTER with an unparsable Contact")
		r.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}

	headerExpires, headerStated := expiresHeader(req)

	if contact.Address.Wildcard {
		// `Contact: *` is only legal with Expires: 0, and means "drop everything for this AOR".
		if !headerStated || headerExpires != 0 {
			log.Info("rejecting a wildcard Contact without Expires: 0")
			r.respond(tx, req, statusBadRequest, "Bad Request")
			return
		}
		r.unbind(ctx, req, tx, credential, aor, aorHash, log)
		return
	}

	requested, stated := contactExpires(contact, headerExpires, headerStated)
	granted, err := r.expiry.Grant(requested, stated)
	if errors.Is(err, ErrIntervalTooBrief) {
		log.Info("rejecting a too-brief registration", "requestedSeconds", int(requested/time.Second))
		res := sip.NewResponseFromRequest(req, statusIntervalTooBrief, "Interval Too Brief", nil)
		res.AppendHeader(sip.NewHeader("Min-Expires", strconv.Itoa(r.expiry.MinSeconds())))
		r.send(tx, res)
		return
	}
	if err != nil {
		log.Error("cannot resolve the registration interval", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}

	if granted == 0 {
		r.unbind(ctx, req, tx, credential, aor, aorHash, log)
		return
	}
	r.bind(ctx, req, tx, credential, aor, aorHash, contact, granted, log)
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

	if auth.Realm != r.realm {
		log.Info("re-challenging a credential for another realm", "offeredRealm", auth.Realm)
		r.challenge(req, tx, false, log)
		return credentials.Credential{}, false
	}
	if err := r.auth.CheckNonce(auth.Nonce); err != nil {
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

	credential, err := r.creds.Lookup(ctx, r.realm, auth.Username)
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

	if err := r.auth.Verify(req.Method.String(), auth, credential.HA1); err != nil {
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

func (r *Registrar) bind(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	credential credentials.Credential,
	aor, aorHash string,
	contact *sip.ContactHeader,
	granted time.Duration,
	log *slog.Logger,
) {
	now := r.now()

	previous, existed, err := r.bindings.Get(ctx, credential.OrgID, aorHash)
	if err != nil {
		log.Error("cannot read the existing binding", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}

	registeredAt := now
	if existed {
		// A refresh extends a binding, it does not create one. Keeping the original instant is what
		// makes `registeredForSeconds` on the eventual `expired` event mean anything.
		registeredAt = previous.RegisteredAt.Time
	}

	binding := kv.Binding{
		OrgID:            credential.OrgID,
		AOR:              aor,
		AORHash:          aorHash,
		Contact:          contact.Address.String(),
		Transport:        transportOf(req),
		UserAgent:        headerValue(req, "User-Agent"),
		SourceAddress:    req.Source(),
		DeviceID:         credential.DeviceID,
		ExtensionID:      credential.ExtensionID,
		SharedLineNumber: credential.SharedLineNumber,
		AppearanceIndex:  credential.AppearanceIndex,
		CallID:           headerValue(req, "Call-ID"),
		CSeq:             cseqOf(req),
		Instance:         paramOr(contact, "+sip.instance"),
		RegisteredAt:     contract.NewEventTime(registeredAt),
		ExpiresAt:        contract.NewEventTime(now.Add(granted)),
		ExpiresInSeconds: int(granted / time.Second),
	}

	// KV first, event second, response last. The location service is the truth a call is routed
	// against; telling a phone it is registered before the binding is durable would make the next
	// INVITE ring into nothing.
	if err := r.bindings.Put(ctx, binding); err != nil {
		log.Error("cannot store the binding", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}

	key, err := binding.Key()
	if err == nil {
		r.mu.Lock()
		r.tracked[key] = binding
		r.mu.Unlock()
	}

	refreshed := existed
	envelope, err := contract.NewRegistrationRegisteredEnvelope(
		contract.EnvelopeInput[contract.RegistrationRegisteredData]{
			OrgID:  binding.OrgID,
			Source: r.source,
			At:     now,
			Data: contract.RegistrationRegisteredData{
				AOR:              binding.AOR,
				Contact:          binding.Contact,
				Transport:        binding.Transport,
				UserAgent:        optional(binding.UserAgent),
				SourceAddress:    optional(binding.SourceAddress),
				DeviceID:         optional(binding.DeviceID),
				ExtensionID:      optional(binding.ExtensionID),
				ExpiresInSeconds: binding.ExpiresInSeconds,
				Refreshed:        &refreshed,
			},
		})
	if err != nil {
		log.Error("cannot build the registered event", "error", err)
	} else if err := r.publisher.Registered(ctx, envelope); err != nil {
		// The binding is durable; the event is observability and presence. Failing the REGISTER now
		// would drop a working device off the network because a stream was full.
		log.Error("cannot publish the registered event", "error", err)
	}

	log.Info("registered",
		"orgId", binding.OrgID,
		"contact", binding.Contact,
		"expiresSeconds", binding.ExpiresInSeconds,
		"refreshed", refreshed,
	)
	r.send(tx, r.okWithBinding(req, binding))
}

func (r *Registrar) unbind(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	credential credentials.Credential,
	aor, aorHash string,
	log *slog.Logger,
) {
	previous, existed, err := r.bindings.Get(ctx, credential.OrgID, aorHash)
	if err != nil {
		log.Error("cannot read the existing binding", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}
	if err := r.bindings.Delete(ctx, credential.OrgID, aorHash); err != nil {
		log.Error("cannot delete the binding", "error", err)
		r.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}
	if key, keyErr := contract.RegistrationKVKey(credential.OrgID, aorHash); keyErr == nil {
		r.mu.Lock()
		delete(r.tracked, key)
		r.mu.Unlock()
	}

	// De-registration is idempotent: a device that sends Expires: 0 twice gets two 200s and one
	// event. Publishing a second `unregistered` for a binding that was already gone would make the
	// stream lie about how many devices dropped.
	if existed {
		reason := contract.RegistrationUnregisteredReasonClient
		envelope, err := contract.NewRegistrationUnregisteredEnvelope(
			contract.EnvelopeInput[contract.RegistrationUnregisteredData]{
				OrgID:  credential.OrgID,
				Source: r.source,
				At:     r.now(),
				Data: contract.RegistrationUnregisteredData{
					AOR:           previous.AOR,
					Contact:       previous.Contact,
					Transport:     previous.Transport,
					UserAgent:     optional(previous.UserAgent),
					SourceAddress: optional(previous.SourceAddress),
					DeviceID:      optional(previous.DeviceID),
					ExtensionID:   optional(previous.ExtensionID),
					Reason:        &reason,
				},
			})
		if err != nil {
			log.Error("cannot build the unregistered event", "error", err)
		} else if err := r.publisher.Unregistered(ctx, envelope); err != nil {
			log.Error("cannot publish the unregistered event", "error", err)
		}
	}

	log.Info("unregistered", "orgId", credential.OrgID, "existed", existed)
	_ = aor
	res := sip.NewResponseFromRequest(req, statusOK, "OK", nil)
	res.AppendHeader(sip.NewHeader("Server", r.server))
	r.send(tx, res)
}

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

// Sweep expires every tracked binding whose deadline has passed and returns how many it removed.
// Exported so tests can drive it directly instead of waiting for a tick.
func (r *Registrar) Sweep(ctx context.Context) int {
	now := r.now()

	r.mu.Lock()
	var lapsed []kv.Binding
	for key, binding := range r.tracked {
		if binding.Expired(now) {
			lapsed = append(lapsed, binding)
			delete(r.tracked, key)
		}
	}
	r.mu.Unlock()

	// The store and publish calls happen outside the lock: they are network I/O, and holding the
	// registrar's mutex across them would stall every REGISTER on the box behind a slow broker.
	for _, binding := range lapsed {
		log := r.log.With("aor", binding.AOR, "orgId", binding.OrgID)

		if err := r.bindings.Delete(ctx, binding.OrgID, binding.AORHash); err != nil {
			log.Error("cannot delete a lapsed binding", "error", err)
		}

		registeredFor := int(binding.RegisteredFor(now) / time.Second)
		envelope, err := contract.NewRegistrationExpiredEnvelope(
			contract.EnvelopeInput[contract.RegistrationExpiredData]{
				OrgID:  binding.OrgID,
				Source: r.source,
				At:     now,
				Data: contract.RegistrationExpiredData{
					AOR:                  binding.AOR,
					Contact:              binding.Contact,
					Transport:            binding.Transport,
					UserAgent:            optional(binding.UserAgent),
					SourceAddress:        optional(binding.SourceAddress),
					DeviceID:             optional(binding.DeviceID),
					ExtensionID:          optional(binding.ExtensionID),
					RegisteredForSeconds: &registeredFor,
				},
			})
		if err != nil {
			log.Error("cannot build the expired event", "error", err)
			continue
		}
		if err := r.publisher.Expired(ctx, envelope); err != nil {
			log.Error("cannot publish the expired event", "error", err)
		}
		log.Info("expired", "registeredForSeconds", registeredFor)
	}
	return len(lapsed)
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
	value, err := r.auth.Challenge(stale)
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

	var uri sip.Uri
	if err := sip.ParseUri(binding.Contact, &uri); err == nil {
		params := sip.NewParams()
		params.Add("expires", strconv.Itoa(binding.ExpiresInSeconds))
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
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 0 {
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
