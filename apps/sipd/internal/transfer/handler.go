package transfer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// SIP statuses this handler emits. Bare integers at a call site are how a 403 becomes a 423.
const (
	statusAccepted       = 202
	statusBadRequest     = 400
	statusUnauthorized   = 401
	statusForbidden      = 403
	statusServerError    = 500
	statusNotImplemented = 501
)

// Options configures a Handler. Every dependency is an interface so the tests run without a broker
// or a socket.
type Options struct {
	// Realm is the digest realm. It must match the Authenticator's.
	Realm string
	// Auth runs the digest exchange. The SAME authenticator the registrar uses, deliberately: a
	// second one with its own secret would mint nonces the registrar rejects and vice versa, and the
	// symptom would be a phone that can register but not transfer.
	Auth *registrar.Authenticator
	// Credentials resolves the account behind the referrer's AOR.
	Credentials credentials.Store
	// Bindings is the location service. Read to confirm the referrer is registered HERE, and never
	// written — a REFER changes no binding.
	Bindings kv.Store
	// Transfers issues the RPC at the engine.
	Transfers Requester
	// Notifier delivers the RFC 3515 progress reports. DiscardNotifier is a valid choice; see its
	// doc comment for what it costs.
	Notifier Notifier
	// Contact is the URI this edge puts in the Contact header of its notifications.
	Contact sip.Uri

	Logger *slog.Logger
	// ServerHeader is the Server / User-Agent header value.
	ServerHeader string
	// BaseContext parents the RPC and the notifications, so a shutdown cancels work in flight.
	// Modelled on net/http.Server.BaseContext: sipgo's handler signature carries no context.
	BaseContext context.Context
	// AuthTimeout bounds the credential lookup and the binding read that gate the 202.
	AuthTimeout time.Duration
	// ReportTimeout bounds everything AFTER the 202: the RPC plus both notifications.
	ReportTimeout time.Duration
	// Now is injectable for the tests.
	Now func() time.Time
	// NewTag mints the To tag for the 202. Injectable so a test can assert the exact NOTIFY headers.
	NewTag func() string
}

// Handler answers REFER.
//
// # What it checks, and why that is a real boundary
//
// This edge is a registrar. It is not in the media path and holds no call state, so it cannot verify
// that the `Call-ID` on a REFER names a dialog it is part of — it is part of none. What it CAN
// establish, and does, before anything reaches the broker:
//
//  1. The REFER answers a digest challenge this fleet minted, with a password only the account
//     holder has. Unauthenticated REFERs are challenged, wrong ones are refused 403.
//  2. The authenticated account is the one in the `From` header. Without this any valid account on
//     the realm could transfer as somebody else — the third-party-REFER hole, the exact shape of
//     the third-party-registration hole the registrar closes.
//  3. That account has a LIVE binding in this deployment's location service. A credential that
//     verifies but has no registration is a phone that is not on this network right now, and a
//     REFER from it is either a replay or a call it cannot possibly be in.
//  4. The `Refer-To` is a dialable SIP URI, and a `Replaces` — if present — parses.
//
// What it deliberately does NOT do is decide whether the referrer is on the call it named. That is
// unanswerable here and answerable in the engine, which holds the legs; the request carries the
// authenticated identity precisely so the engine can check it and refuse `not_permitted`. Stating it
// this way round means the boundary exists in ONE place that can actually enforce it, rather than in
// two places that each enforce half.
//
// # RFC 3515 coverage
//
// Implemented: `202 Accepted`, the implicit subscription, `Event: refer;id=<cseq>`, an `active`
// NOTIFY with `SIP/2.0 100 Trying`, and a `terminated;reason=noresource` NOTIFY with the outcome.
// NOT implemented: an actual subscription state machine — no SUBSCRIBE refresh is honoured, no
// `Refer-Sub: false` negotiation (RFC 4488), and the notifications are fire-and-forget rather than
// retried past the transaction layer's own timers. Those matter for a referee that reports progress
// over minutes; a blind transfer here reaches its final state in under two seconds, and the two
// notifications above are what a handset actually consumes.
type Handler struct {
	realm     string
	auth      *registrar.Authenticator
	creds     credentials.Store
	bindings  kv.Store
	transfers Requester
	notifier  Notifier
	contact   sip.Uri

	log           *slog.Logger
	server        string
	baseCtx       context.Context
	authTimeout   time.Duration
	reportTimeout time.Duration
	now           func() time.Time
	newTag        func() string

	// reports tracks the goroutines reporting outcomes, so Wait can drain them at shutdown rather
	// than leaving a phone mid-transfer when the process exits.
	reports sync.WaitGroup
}

// New validates the options and builds a Handler.
func New(opts Options) (*Handler, error) {
	switch {
	case strings.TrimSpace(opts.Realm) == "":
		return nil, errors.New("transfer: Realm is required")
	case opts.Auth == nil:
		return nil, errors.New("transfer: Auth is required")
	case opts.Credentials == nil:
		return nil, errors.New("transfer: Credentials is required")
	case opts.Bindings == nil:
		return nil, errors.New("transfer: Bindings is required")
	case opts.Transfers == nil:
		return nil, errors.New("transfer: Transfers is required")
	}
	if opts.Auth.Realm() != opts.Realm {
		return nil, fmt.Errorf("transfer: the authenticator challenges for %q but the handler serves %q",
			opts.Auth.Realm(), opts.Realm)
	}

	handler := &Handler{
		realm:         opts.Realm,
		auth:          opts.Auth,
		creds:         opts.Credentials,
		bindings:      opts.Bindings,
		transfers:     opts.Transfers,
		notifier:      opts.Notifier,
		contact:       opts.Contact,
		log:           opts.Logger,
		server:        opts.ServerHeader,
		baseCtx:       opts.BaseContext,
		authTimeout:   opts.AuthTimeout,
		reportTimeout: opts.ReportTimeout,
		now:           opts.Now,
		newTag:        opts.NewTag,
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
	if handler.reportTimeout <= 0 {
		// The RPC's own deadline plus room for two notifications on a slow socket.
		handler.reportTimeout = contract.TimeoutSipTransferRPC + 3*time.Second
	}
	if handler.now == nil {
		handler.now = time.Now
	}
	if handler.newTag == nil {
		handler.newTag = func() string { return sip.GenerateTagN(16) }
	}
	return handler, nil
}

// Wait blocks until every in-flight outcome report has finished or the timeout elapses, and reports
// whether they all finished. Called on the shutdown path so a phone gets its final NOTIFY.
func (h *Handler) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		h.reports.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// HandleRefer implements RFC 3515 §2.4.2 for this edge.
func (h *Handler) HandleRefer(req *sip.Request, tx sip.ServerTransaction) {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.authTimeout)
	defer cancel()

	log := h.log.With(
		"method", "REFER",
		"peer", req.Source(),
		"transport", req.Transport(),
		"sipCallId", headerValue(req, "Call-ID"),
	)

	from := req.From()
	if from == nil {
		log.Info("rejecting a REFER with no From header")
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	// The referrer is the From: a REFER is sent BY the party asking for the transfer, unlike a
	// REGISTER where the To is the address of record being bound.
	aor, user, ok := addressOfRecord(from.Address)
	if !ok {
		log.Info("rejecting a REFER with no usable From address")
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	log = log.With("aor", aor)

	credential, authorized := h.authorize(ctx, req, tx, user, log)
	if !authorized {
		return
	}

	// Parsed AFTER authentication on purpose: an unauthenticated caller learns nothing about which
	// Refer-To spellings this edge accepts, and the parser is not run on an anonymous packet.
	refer, err := ParseRefer(req)
	if err != nil {
		switch {
		case errors.Is(err, ErrUnsupportedReferTo):
			log.Info("rejecting a REFER to something this edge will not dial", "error", err)
			h.respond(tx, req, statusNotImplemented, "Not Implemented")
		default:
			log.Info("rejecting a malformed REFER", "error", err)
			h.respond(tx, req, statusBadRequest, "Bad Request")
		}
		return
	}
	log = log.With("target", refer.Target.User, "attended", refer.Attended())

	if !h.isRegistered(ctx, credential.OrgID, aor, log) {
		// 403 rather than 404: the account is real and its digest verified, it simply has no live
		// binding here, and telling the caller which of the two it was is an enumeration oracle.
		log.Warn("rejecting a REFER from an account with no live registration")
		h.respond(tx, req, statusForbidden, "Forbidden")
		return
	}

	// The 202 goes out BEFORE the RPC. RFC 3515 §2.4.2: accepting a REFER means "I will try and I
	// will tell you", not "I have done it" — and a phone's non-INVITE retransmission timer would
	// fire long before a transfer completes if the transaction were held open across it.
	dialog := h.accept(req, tx, refer, log)
	if dialog == nil {
		return
	}

	h.reports.Add(1)
	go func() {
		defer h.reports.Done()
		h.report(dialog, refer, credential, req, log)
	}()
}

// accept answers 202 and captures what the outcome report needs. It returns nil when the response
// could not be sent, in which case there is nobody left to notify.
func (h *Handler) accept(
	req *sip.Request,
	tx sip.ServerTransaction,
	refer Refer,
	log *slog.Logger,
) *Dialog {
	tag := refer.ToTag
	if tag == "" {
		// The REFER arrived without a To tag, so this response is what establishes the dialog from
		// the phone's point of view and the tag must be ours.
		tag = h.newTag()
	}

	res := sip.NewResponseFromRequest(req, statusAccepted, "Accepted", nil)
	if refer.ToTag == "" {
		// sipgo mints a tag of its own when the request carried none, and it does not tell us which.
		// Overwriting it is not pedantry: the NOTIFY's From tag must be the SAME string the phone saw
		// on the 202, and a phone that cannot match the tags silently drops every notification — so
		// the transfer works while the handset reports that it failed.
		if to := res.To(); to != nil {
			to.Params.Remove("tag")
			to.Params.Add("tag", tag)
		}
	}
	res.AppendHeader(&sip.ContactHeader{Address: h.contact})
	res.AppendHeader(sip.NewHeader("Server", h.server))
	if err := tx.Respond(res); err != nil {
		log.Error("cannot accept the REFER", "error", err)
		return nil
	}

	dialog := &Dialog{
		Recipient: h.recipientFor(req),
		CallID:    refer.CallID,
		ReferCSeq: refer.CSeq,
		LocalTag:  tag,
		RemoteTag: refer.FromTag,
		Transport: req.Transport(),
		Source:    req.Source(),
	}
	if to := req.To(); to != nil {
		dialog.Local = to.Address
	}
	if from := req.From(); from != nil {
		dialog.Remote = from.Address
	}
	return dialog
}

// report runs the whole post-202 half: 100 Trying, the RPC, and the final status.
func (h *Handler) report(
	dialog *Dialog,
	refer Refer,
	credential credentials.Credential,
	req *sip.Request,
	log *slog.Logger,
) {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.reportTimeout)
	defer cancel()

	h.notify(ctx, dialog, FragTrying, StateActive, log)

	response, err := h.transfers.Transfer(ctx, h.requestFor(refer, credential, req))
	switch {
	case err != nil:
		// No answer at all. Distinct from a refusal in the log and identical on the wire, because a
		// handset has one behaviour for a transfer that did not happen.
		log.Error("the transfer request failed", "error", err)
		h.notify(ctx, dialog, FragFailed, StateTerminated, log)
	case !response.Ok:
		log.Warn("the engine refused the transfer",
			"reason", refusalReason(response), "detail", optionalString(response.Error))
		h.notify(ctx, dialog, FragFailed, StateTerminated, log)
	default:
		log.Info("transferred", "orgId", credential.OrgID,
			"legId", optionalString(response.LegID), "callId", optionalString(response.CallID))
		h.notify(ctx, dialog, FragOK, StateTerminated, log)
	}
}

func (h *Handler) notify(
	ctx context.Context,
	dialog *Dialog,
	frag string,
	state SubscriptionState,
	log *slog.Logger,
) {
	if err := h.notifier.Notify(ctx, BuildNotify(dialog, frag, state, h.contact, h.server)); err != nil {
		// A lost notification does not undo a transfer that happened; it leaves a handset's
		// indicator wrong. Logged rather than retried here — the transaction layer owns the retries.
		log.Warn("cannot notify the referrer of the transfer outcome", "frag", frag, "error", err)
	}
}

// requestFor builds the contract request from everything established above.
//
// Note what it takes from where. `orgId` and the referrer come from the CREDENTIAL, which the digest
// exchange resolved; the dialog identifiers and the target come from the MESSAGE, which the phone
// wrote. Mixing those two up is how an authorisation check becomes decorative.
func (h *Handler) requestFor(
	refer Refer,
	credential credentials.Credential,
	req *sip.Request,
) contract.SipTransferRequest {
	request := contract.SipTransferRequest{
		OrgID:     credential.OrgID,
		SIPCallID: refer.CallID,
		ReferredBy: contract.SipTransferRequestReferredBy{
			// Rebuilt from the CREDENTIAL rather than copied from the From header, even though the
			// two are checked to agree above. The check is on the user part alone; taking the whole
			// string from the message would let a phone choose the domain spelling the engine sees.
			AOR:      "sip:" + credential.Username + "@" + strings.ToLower(credential.Realm),
			Username: credential.Username,
		},
		Target: contract.SipTransferRequestTarget{User: refer.Target.User},
		Kind:   contract.SipTransferRequestKindBlind,
	}
	if refer.Attended() {
		request.Kind = contract.SipTransferRequestKindAttended
		request.Replaces = &contract.SipTransferRequestReplaces{
			CallID:    refer.Replaces.CallID,
			ToTag:     refer.Replaces.ToTag,
			FromTag:   refer.Replaces.FromTag,
			EarlyOnly: refer.Replaces.EarlyOnly,
		}
	}
	setOptional(&request.FromTag, refer.FromTag)
	setOptional(&request.ToTag, refer.ToTag)
	setOptional(&request.Target.Host, refer.Target.Host)
	setOptional(&request.Target.URI, refer.Target.URI)
	setOptional(&request.ReferredBy.ExtensionID, credential.ExtensionID)
	setOptional(&request.ReferredBy.DeviceID, credential.DeviceID)
	setOptional(&request.SourceAddress, req.Source())

	cseq := int(refer.CSeq)
	request.ReferCSeq = &cseq

	transport := contract.SIPTransport(strings.ToLower(req.Transport()))
	if transport.Valid() {
		request.Transport = &transport
	}
	return request
}

// ---------------------------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------------------------

// authorize runs the digest exchange for a REFER. It answers the transaction itself on every failure
// path and reports whether the caller should continue.
//
// The status choices mirror the registrar's, for the same reasons: 401 for "no credentials" and
// "stale nonce" because the device can retry, 403 for everything else because re-challenging a wrong
// password produces a loop some handsets run forever.
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

	// An account may only transfer AS ITSELF. Without this any valid account on the realm could send
	// a REFER carrying somebody else's From and have the engine attribute it to them.
	if auth.Username != fromUser {
		log.Warn("rejecting a REFER sent as somebody else", "authenticatedAs", auth.Username)
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

	// REFER, not REGISTER: HA2 is MD5(method:uri), so verifying with the wrong method name accepts
	// nothing and would make every transfer fail with a password error nobody could explain.
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

// isRegistered reports whether the referrer has a live binding in this deployment.
//
// A read failure answers FALSE. Fail-closed, exactly as the credential store is: a location service
// that cannot be consulted is not evidence that a phone is on the network.
func (h *Handler) isRegistered(ctx context.Context, orgID, aor string, log *slog.Logger) bool {
	aorHash, err := contract.AORSubjectToken(aor)
	if err != nil {
		log.Error("cannot derive the AOR subject token", "error", err)
		return false
	}
	binding, found, err := h.bindings.Get(ctx, orgID, aorHash)
	if err != nil {
		log.Error("cannot read the referrer's binding", "error", err)
		return false
	}
	if !found {
		return false
	}
	// A binding whose granted interval has already lapsed is one the sweeper has not reached yet.
	// Treating it as live would accept a REFER from a phone that stopped refreshing minutes ago.
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

func (h *Handler) send(tx sip.ServerTransaction, res *sip.Response) {
	if err := tx.Respond(res); err != nil {
		h.log.Error("cannot send a response", "error", err, "status", res.StatusCode)
	}
}

// recipientFor picks where a notification is addressed: the referrer's Contact when it offered one,
// and the To address otherwise. The observed source address is set separately as the DESTINATION, so
// a phone behind NAT is reached at the address that works even when its Contact is unroutable.
func (h *Handler) recipientFor(req *sip.Request) sip.Uri {
	if contact := req.Contact(); contact != nil {
		return contact.Address
	}
	if from := req.From(); from != nil {
		return from.Address
	}
	return h.contact
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

// setOptional writes a *string field only when the value is non-empty, so an unknown value is ABSENT
// on the wire rather than an empty string the responder has to special-case — and, for the fields
// with a `min(1)` in the schema, so an empty one is not sent as a value that fails validation.
func setOptional(field **string, value string) {
	if value == "" {
		return
	}
	copied := value
	*field = &copied
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func refusalReason(response contract.SipTransferResponse) string {
	if response.Reason == nil {
		return "unspecified"
	}
	return string(*response.Reason)
}
