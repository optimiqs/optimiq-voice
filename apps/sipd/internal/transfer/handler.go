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
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
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
	statusUnavailable    = 503
)

// Dialogs resolves an in-dialog request against this instance's dialog table. *dialog.Store
// implements it.
type Dialogs interface {
	MatchEstablished(req *sip.Request) (dialog.Membership, bool)
}

// Options configures a Handler. Every dependency is an interface so the tests run without a broker
// or a socket.
type Options struct {
	// Realm is the digest realm. It must match the Authenticator's.
	Realm string
	// Auth runs the digest exchange. It must be the SAME authenticator the registrar uses: a second
	// one with its own secret would mint nonces the registrar rejects.
	Auth *registrar.Authenticator
	// Credentials resolves the account behind the referrer's AOR.
	Credentials credentials.Store
	// Dialogs authorises an in-dialog REFER by dialog membership. Optional: without it every REFER
	// takes the digest path, which the party who ANSWERED a call cannot satisfy.
	Dialogs Dialogs
	// Bindings is the location service. Read to confirm the referrer is registered HERE, and never
	// written — a REFER changes no binding.
	Bindings kv.Store
	// Transfers issues the RPC at the engine.
	Transfers Requester
	// Notifier delivers the RFC 3515 progress reports. DiscardNotifier is a valid choice.
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

// Handler answers REFER. This is the security boundary for transfers; before anything reaches the
// broker it establishes that:
//
//  1. The referrer is either a member of an established dialog this instance holds, or answers a
//     digest challenge this fleet minted. Unauthenticated out-of-dialog REFERs are challenged,
//     wrong ones refused 403.
//  2. On the digest path the authenticated account is the one in the `From` header; on the
//     in-dialog path the acting account is the DIALOG's. Either way the `From` never chooses it.
//  3. That account has a LIVE binding in this deployment's location service.
//  4. The `Refer-To` is a dialable SIP URI, and a `Replaces` — if present — parses.
//
// It deliberately does NOT decide whether the referrer is on the call it named: that is unanswerable
// here and answerable in the engine, which holds the legs and refuses `not_permitted`. The request
// carries the authenticated identity for exactly that.
//
// RFC 3515 coverage is partial: 202 Accepted, the implicit subscription, `Event: refer;id=<cseq>`,
// an `active` 100 Trying NOTIFY and a `terminated;reason=noresource` NOTIFY. There is no
// subscription state machine, no SUBSCRIBE refresh and no RFC 4488 `Refer-Sub` negotiation.
type Handler struct {
	realm     string
	auth      *registrar.Authenticator
	creds     credentials.Store
	dialogs   Dialogs
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

	// reports tracks the goroutines reporting outcomes, so Wait can drain them at shutdown.
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
		dialogs:       opts.Dialogs,
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
	// REGISTER whose To is the address of record being bound.
	fromAOR, fromUser, ok := addressOfRecord(from.Address)
	if !ok {
		log.Info("rejecting a REFER with no usable From address")
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}

	credential, aor, authorized := h.identify(ctx, req, tx, fromAOR, fromUser, log)
	if !authorized {
		return
	}
	log = log.With("aor", aor)

	// Parsed AFTER authentication on purpose: the parser is not run on an anonymous packet, and an
	// unauthenticated caller learns nothing about which Refer-To spellings this edge accepts.
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
	// will tell you", and a phone's non-INVITE retransmission timer would fire long before a
	// transfer completed if the transaction were held open across it.
	dialog := h.accept(req, tx, refer, log)
	if dialog == nil {
		return
	}

	h.reports.Go(func() { h.report(dialog, refer, credential, req, log) })
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
		// sipgo mints a tag of its own when the request carried none and does not tell us which.
		// The NOTIFY's From tag must be the SAME string the phone saw on the 202, or the phone
		// silently drops every notification.
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
		// No answer at all. Distinct from a refusal in the log, identical on the wire.
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
		// A lost notification leaves a handset's indicator wrong but undoes nothing. Not retried
		// here: the transaction layer owns the retries.
		log.Warn("cannot notify the referrer of the transfer outcome", "frag", frag, "error", err)
	}
}

// requestFor builds the contract request. `orgId` and the referrer come from the CREDENTIAL the
// digest exchange resolved; the dialog identifiers and target come from the MESSAGE the phone wrote.
// Mixing the two is how an authorisation check becomes decorative.
func (h *Handler) requestFor(
	refer Refer,
	credential credentials.Credential,
	req *sip.Request,
) contract.SipTransferRequest {
	request := contract.SipTransferRequest{
		OrgID:     credential.OrgID,
		SIPCallID: refer.CallID,
		ReferredBy: contract.SipTransferRequestReferredBy{
			// Rebuilt from the CREDENTIAL, not copied from the From header: the check above is on
			// the user part alone, so the message could still choose the domain spelling.
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

// identify establishes who is asking for the transfer, and returns the account plus its address of
// record. It answers the transaction itself on every failure path.
//
// An IN-DIALOG REFER — Call-ID plus BOTH dialog tags matching a dialog this instance has
// established — is authorised by that membership, the same way BYE, re-INVITE and UPDATE already
// are. RFC 3261 §12.2: an in-dialog request's From is the dialog's own local URI, so it asserts no
// identity — on a session the referrer ANSWERED it is an anonymous instance URI no credential can
// exist for. The two tags are unguessable secrets shared only with the dialog's peers, so matching
// both is the proof; the acting account then comes from the DIALOG and never from the header.
//
// Everything else — out of dialog, an unestablished dialog, or a dialog with no account behind it
// such as a trunk leg — is digest challenged as before.
func (h *Handler) identify(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	fromAOR, fromUser string,
	log *slog.Logger,
) (credentials.Credential, string, bool) {
	if h.dialogs != nil {
		if member, matched := h.dialogs.MatchEstablished(req); matched && member.AccountAOR != "" {
			credential, err := h.accountFor(ctx, member)
			if err == nil {
				return credential, member.AccountAOR, true
			}
			log.Warn("cannot resolve the account behind an established dialog; challenging the REFER",
				"legId", member.LegID, "error", err)
		}
	}
	credential, authorized := h.authorize(ctx, req, tx, fromUser, log)
	return credential, fromAOR, authorized
}

// accountFor resolves the credential behind a dialog's address of record. The org on the credential
// must be the org on the dialog: a credential store that answered for another tenant would put a
// transfer in the wrong one.
func (h *Handler) accountFor(ctx context.Context, member dialog.Membership) (credentials.Credential, error) {
	uri := sip.Uri{}
	if err := sip.ParseUri(member.AccountAOR, &uri); err != nil {
		return credentials.Credential{}, fmt.Errorf("transfer: %q is not a usable address of record: %w",
			member.AccountAOR, err)
	}
	_, user, ok := addressOfRecord(uri)
	if !ok {
		return credentials.Credential{}, fmt.Errorf("transfer: %q is not a usable address of record",
			member.AccountAOR)
	}
	credential, err := h.creds.Lookup(ctx, strings.ToLower(uri.Host), user)
	if err != nil {
		return credentials.Credential{}, err
	}
	if member.OrgID != "" && credential.OrgID != member.OrgID {
		return credentials.Credential{}, fmt.Errorf(
			"transfer: %s resolves to org %s but its dialog belongs to %s",
			member.AccountAOR, credential.OrgID, member.OrgID)
	}
	return credential, nil
}

// authorize runs the digest exchange for a REFER. It answers the transaction itself on every failure
// path and reports whether the caller should continue.
//
// The status choices mirror the registrar's: 401 for "no credentials" and "stale nonce" because the
// device can retry, 403 for everything else because re-challenging a wrong password produces a loop
// some handsets run forever.
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

	// An account may only transfer AS ITSELF: otherwise any valid account on the realm could send a
	// REFER carrying somebody else's From and have the engine attribute it to them.
	if auth.Username != fromUser {
		log.Warn("rejecting a REFER sent as somebody else", "authenticatedAs", auth.Username)
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

	// REFER, not REGISTER: HA2 is hash(method:uri), so the wrong method name fails every digest.
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

// isRegistered reports whether the referrer has a live binding in this deployment. A read failure
// answers FALSE: a location service that cannot be consulted is not evidence a phone is on the
// network.
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
	// A lapsed binding is one the sweeper has not reached yet; treating it as live would accept a
	// REFER from a phone that stopped refreshing minutes ago.
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

// setOptional writes a *string field only when the value is non-empty, so an unknown value is ABSENT
// on the wire rather than an empty string that fails the schema's `min(1)`.
func setOptional(field **string, value string) {
	if value == "" {
		return
	}
	*field = new(value)
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
