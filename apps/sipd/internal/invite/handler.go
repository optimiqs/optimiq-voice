package invite

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

// SIP statuses this handler emits. Bare integers at a call site are how a 403 becomes a 423.
const (
	statusTrying           = 100
	statusOK               = 200
	statusBadRequest       = 400
	statusUnauthorized     = 401
	statusForbidden        = 403
	statusCallDoesNotExist = 481
	statusServerError      = 500
	statusServiceUnavail   = 503
)

// Responder writes a response OUTSIDE a transaction.
//
// It exists for exactly one job, and the job is RFC 6026: a 2xx to an INVITE is retransmitted by
// the TU — not by the transaction layer, which has already terminated — until the ACK arrives or
// 64×T1 elapses. sipgo's *Server satisfies this, and having it as an interface is what lets the
// retransmission loop be tested with a fake clock and no socket.
type Responder interface {
	WriteResponse(res *sip.Response) error
}

// EventSink publishes one `sip.evt.v1` event.
//
// # Why this is still an interface now that the contract exists
//
// It was a seam because the subject family did not exist. It stays a seam for a different and more
// durable reason: a deployment with no broker — the SIPp rig, an integration test, a laptop — must
// still be able to run the INVITE path, and the honest behaviour there is a log line carrying every
// field the event would have had rather than a publish that fails on every call. LogEventSink is
// that; PublishingSink (publisher.go) is the production one, and it builds the contract's own
// envelopes so the subject and the payload cannot disagree with the TypeScript consumer.
type EventSink interface {
	Publish(ctx context.Context, event Event) error
}

// Event is one dialog event, in this package's vocabulary rather than the contract's.
//
// # Why a struct of our own and not the generated payload
//
// Six generated payloads with no common interface cannot be produced by one effect handler, and a
// handler that switched on the event kind to build six different structs would put the contract's
// shape inside the executor — where a schema change becomes an edit to the code that writes 200 OK
// to a socket. So the executor fills ONE struct from the dialog, and the mapping onto six envelopes
// lives in one file next door (publisher.go) that touches no transaction and no timer.
//
// Every field is either on the dialog or on the effect that produced the event. Nothing here is
// inferred.
type Event struct {
	Kind      dialog.DialogEvent
	LegID     string
	OrgID     string
	CallID    string
	SIPCallID string
	// LocalTag and RemoteTag complete the dialog triple the contract carries as `identity`. It is a
	// LOOKUP KEY on the far side and never an authorisation — the rule
	// `sipTransferRequestSchema.sipCallId` states — and it travels so a packet capture can be lined
	// up against a leg id nothing on the wire contains.
	LocalTag  string
	RemoteTag string
	// Role is which end of the INVITE we are, and it is what makes `dialog.answered` mean two
	// different moments without ambiguity: the ACK for a UAS leg, the 2xx for a UAC one.
	Role dialog.Role
	// Status is the SIP status that produced the event, for `progressed` and `terminated`.
	Status int
	// HasEarlyMedia and SDPAnswer describe a 183 that committed an answer.
	HasEarlyMedia bool
	SDPAnswer     string
	// Direction is the media direction a hold or a resume moved the far end to.
	Direction dialog.Direction
	// Cause, Termination, Initiator and CauseFromReasonHeader are the terminal event's four
	// independent facts: why, how, who, and whether the why was stated or derived.
	Cause                 int
	Termination           dialog.TerminationReason
	Initiator             dialog.Initiator
	CauseFromReasonHeader bool
	// SetupMs is the time from the INVITE to the answer — the post-dial-delay number, measured on
	// the only plane that can see both ends of it.
	SetupMs int
	// AnsweredForSeconds is billsec, counted from the moment the call was genuinely up in this
	// role rather than from when a bridge happened to be built.
	AnsweredForSeconds int
	// Digit and DurationMs carry a SIP INFO keypress. RFC 4733 in-band digits are the media plane's.
	Digit      string
	DurationMs int
	// Detail is free text for the log. It never reaches the wire.
	Detail string
	At     time.Time
}

// LogEventSink is the default EventSink: one structured log line per event.
type LogEventSink struct{ Log *slog.Logger }

var _ EventSink = LogEventSink{}

// Publish implements EventSink.
func (s LogEventSink) Publish(_ context.Context, event Event) error {
	log := s.Log
	if log == nil {
		log = slog.Default()
	}
	log.Info("sip dialog event",
		"event", string(event.Kind),
		"legId", event.LegID,
		"orgId", event.OrgID,
		"callId", event.CallID,
		"sipCallId", event.SIPCallID,
		"role", event.Role.String(),
		"status", event.Status,
		"cause", event.Cause,
		"termination", string(event.Termination),
		"initiator", string(event.Initiator),
		"detail", event.Detail,
		"unpublished", "no JetStream publisher is wired; run with a broker to publish sip.evt.v1")
	return nil
}

// Options configures a Handler. Every dependency is an interface so the tests run without a broker
// or a socket, which is the shape every other package in this service already has.
type Options struct {
	// Realm is the digest realm. It must match the Authenticator's.
	Realm string
	// Auth runs the digest exchange. The SAME authenticator the registrar and the REFER handler
	// use, deliberately: a second one with its own secret would mint nonces the others reject, and
	// the symptom would be a phone that can register but not call.
	Auth *registrar.Authenticator
	// Credentials resolves the account behind the caller's AOR.
	Credentials credentials.Store
	// Dialogs is this instance's dialog table.
	Dialogs *dialog.Store
	// Claims is the `sip-dialogs` bucket. Optional: without it a single instance still works and
	// nothing reaps a dead peer's calls.
	Claims dialog.ClaimStore
	// Profiles is the trust boundary set.
	Profiles *profile.Set
	// Port is the engine seam.
	Port Port
	// Requester sends the BYEs, ACKs and CANCELs this edge originates.
	Requester Requester
	// Caller places the INVITEs this edge originates. Optional: without it `rpc.sip.v1.originate` is
	// refused `not_supported` by name, which is the honest answer for a deployment wired without a
	// SIP client — and a better one than a nil dereference on the first outbound call.
	Caller Caller
	// Bindings is the location service, read to resolve a `{kind:"aor"}` originate. Optional, and
	// its absence refuses those originates rather than failing the whole handler: an inbound-only
	// deployment is a real configuration.
	Bindings kv.Store
	// Trunks is the carrier directory, read to resolve a `{kind:"trunk"}` originate. Optional on the
	// same argument.
	Trunks TrunkDirectory
	// Responder retransmits a 2xx until it is ACKed.
	Responder Responder
	// Events publishes the dialog family.
	Events EventSink
	// Contact is the URI this edge puts in its own responses and requests.
	Contact sip.Uri
	// InstanceID stamps claims and is the token engine commands are addressed at.
	InstanceID string
	// Timers is the RFC 4028 position.
	Timers dialog.TimerPolicy

	Logger       *slog.Logger
	ServerHeader string
	// BaseContext parents every RPC and every effect, so a shutdown cancels work in flight.
	BaseContext context.Context
	// AuthTimeout bounds the credential lookup that gates admission.
	AuthTimeout time.Duration
	// AdmitTimeout bounds the admission RPC. Design §10.2 sets it at 1000 ms: `100 Trying` is
	// already out and nothing is retransmitting behind it, and a person is holding a handset.
	AdmitTimeout time.Duration
	// RingTimeout is how long an admitted call may sit with no command before this edge ends it
	// itself. It is belt and braces for an engine that stopped answering mid-walk; the engine's own
	// ring timeout is shorter and is the one that normally fires.
	RingTimeout time.Duration
	// RetransmitInterval is T1 for the RFC 6026 2xx loop, and RetransmitCap is T2.
	RetransmitInterval time.Duration
	RetransmitCap      time.Duration
	// RetransmitFor is how long the loop runs before giving up — 64×T1 in the RFC.
	RetransmitFor time.Duration

	// NewLegID mints the leg id. Injectable so a test can assert an exact claim.
	NewLegID func() string
	// NewTag mints our To tag.
	NewTag func() string
	Now    func() time.Time
}

// Handler answers INVITE and every request inside the dialogs it creates.
//
// # What it checks before anything reaches the broker
//
//  1. A profile claims the request. There is no default profile: a packet nobody owns is a packet
//     no policy applies to (see internal/profile).
//  2. The profile's authentication passes — a digest this fleet minted, or a source address in the
//     trunk ACL. An unauthenticated INVITE on an internal profile is challenged, not refused, so a
//     phone retries by itself.
//  3. The caller is who it says it is: the authenticated account must be the one in the From. This
//     is the third-party-INVITE hole, the same shape as the third-party-registration hole the
//     registrar closes and the third-party-REFER hole the transfer handler closes.
//
// # What it deliberately does not decide
//
// Whose call it is. A digest resolves a tenant; a trunk match does not, and this edge does not read
// the did-index (design §4.2). The engine attributes, and this edge sends it the evidence.
type Handler struct {
	realm     string
	auth      *registrar.Authenticator
	creds     credentials.Store
	dialogs   *dialog.Store
	claims    dialog.ClaimStore
	profiles  *profile.Set
	port      Port
	requester Requester
	caller    Caller
	bindings  kv.Store
	trunks    TrunkDirectory
	responder Responder
	events    EventSink
	contact   sip.Uri
	instance  string
	timers    dialog.TimerPolicy

	log            *slog.Logger
	server         string
	baseCtx        context.Context
	authTimeout    time.Duration
	admitTimeout   time.Duration
	ringTimeout    time.Duration
	retransmitT1   time.Duration
	retransmitCap  time.Duration
	retransmitFor  time.Duration
	newLegID       func() string
	newTag         func() string
	now            func() time.Time
	backgroundWork sync.WaitGroup

	mu   sync.Mutex
	legs map[string]*leg
}

// leg is one dialog's session plus the sipgo objects only its owning goroutine may touch.
type leg struct {
	session *dialog.Session
	state   *legState
}

// legState holds the per-dialog wire state. Every field is read and written ONLY from inside a
// session task, which is what makes it safe without a lock of its own.
type legState struct {
	invite    *sip.Request
	inviteTx  sip.ServerTransaction
	pendingTx sip.ServerTransaction
	pending   *sip.Request
	// answer is the 2xx being retransmitted, nil when none is.
	answer *sip.Response
	// stopRetransmit cancels the RFC 6026 loop.
	stopRetransmit context.CancelFunc
	// ringTimer ends a call the engine never acted on.
	ringTimer *time.Timer
	// sessionTimer is the RFC 4028 deadline.
	sessionTimer *time.Timer
	// localCSeq numbers the requests this edge originates inside the dialog.
	localCSeq uint32
	// local and remote are the two addresses mid-dialog requests are built from.
	local  sip.Uri
	remote sip.Uri
	// retryAfter is the Retry-After this edge owes on a refusal, in whole seconds. Zero omits it.
	retryAfter int
	// replacesLegID is the dialog this one replaces (RFC 3891), torn down when our 2xx goes out.
	replacesLegID string
	// profile is the trust boundary the dialog arrived on, so mid-dialog decisions apply the same
	// NAT policy the initial request was admitted under.
	profile profile.Profile
}

// New validates the options and builds a Handler.
func New(opts Options) (*Handler, error) {
	switch {
	case strings.TrimSpace(opts.Realm) == "":
		return nil, errors.New("invite: Realm is required")
	case opts.Auth == nil:
		return nil, errors.New("invite: Auth is required")
	case opts.Credentials == nil:
		return nil, errors.New("invite: Credentials is required")
	case opts.Dialogs == nil:
		return nil, errors.New("invite: Dialogs is required")
	case opts.Profiles == nil:
		return nil, errors.New("invite: Profiles is required")
	case opts.Port == nil:
		return nil, errors.New("invite: Port is required")
	}
	if opts.Auth.Realm() != opts.Realm {
		return nil, fmt.Errorf("invite: the authenticator challenges for %q but the handler serves %q",
			opts.Auth.Realm(), opts.Realm)
	}

	handler := &Handler{
		realm:         opts.Realm,
		auth:          opts.Auth,
		creds:         opts.Credentials,
		dialogs:       opts.Dialogs,
		claims:        opts.Claims,
		profiles:      opts.Profiles,
		port:          opts.Port,
		requester:     opts.Requester,
		caller:        opts.Caller,
		bindings:      opts.Bindings,
		trunks:        opts.Trunks,
		responder:     opts.Responder,
		events:        opts.Events,
		contact:       opts.Contact,
		instance:      opts.InstanceID,
		timers:        opts.Timers,
		log:           opts.Logger,
		server:        opts.ServerHeader,
		baseCtx:       opts.BaseContext,
		authTimeout:   opts.AuthTimeout,
		admitTimeout:  opts.AdmitTimeout,
		ringTimeout:   opts.RingTimeout,
		retransmitT1:  opts.RetransmitInterval,
		retransmitCap: opts.RetransmitCap,
		retransmitFor: opts.RetransmitFor,
		newLegID:      opts.NewLegID,
		newTag:        opts.NewTag,
		now:           opts.Now,
		legs:          make(map[string]*leg),
	}
	if handler.requester == nil {
		handler.requester = DiscardRequester{}
	}
	if handler.log == nil {
		handler.log = slog.Default()
	}
	if handler.events == nil {
		handler.events = LogEventSink{Log: handler.log}
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
	if handler.admitTimeout <= 0 {
		handler.admitTimeout = time.Second
	}
	if handler.ringTimeout <= 0 {
		handler.ringTimeout = 180 * time.Second
	}
	if handler.retransmitT1 <= 0 {
		handler.retransmitT1 = sip.T1
	}
	if handler.retransmitCap <= 0 {
		handler.retransmitCap = sip.T2
	}
	if handler.retransmitFor <= 0 {
		handler.retransmitFor = 64 * handler.retransmitT1
	}
	if handler.newLegID == nil {
		return nil, errors.New("invite: NewLegID is required — a leg id is the key to everything")
	}
	if handler.newTag == nil {
		handler.newTag = func() string { return sip.GenerateTagN(16) }
	}
	if handler.now == nil {
		handler.now = time.Now
	}
	return handler, nil
}

// Wait blocks until every background goroutine has finished or the timeout elapses.
func (h *Handler) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		h.backgroundWork.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Len reports how many dialogs this handler holds. A drain refuses to finish while it is non-zero.
func (h *Handler) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.legs)
}

// ---------------------------------------------------------------------------------------------
// INVITE
// ---------------------------------------------------------------------------------------------

// HandleInvite answers an INVITE: a new call, or a re-INVITE inside one we already hold.
func (h *Handler) HandleInvite(req *sip.Request, tx sip.ServerTransaction) {
	if existing, found := h.dialogs.MatchRequest(req); found {
		h.handleMidDialogOffer(existing.LegID, dialog.KindReInvite, req, tx)
		return
	}
	h.handleInitialInvite(req, tx)
}

func (h *Handler) handleInitialInvite(req *sip.Request, tx sip.ServerTransaction) {
	ctx, cancel := context.WithTimeout(h.baseCtx, h.authTimeout)
	defer cancel()

	log := h.log.With(
		"method", "INVITE",
		"peer", req.Source(),
		"transport", req.Transport(),
		"sipCallId", headerValue(req, "Call-ID"),
	)

	owner, err := h.profiles.For(req)
	if err != nil {
		// No profile claims it. 403 and not 401: a challenge would invite a stranger to guess a
		// password on a socket no policy owns.
		log.Warn("refusing an INVITE that no profile claims")
		h.respond(tx, req, statusForbidden, "Forbidden")
		return
	}
	log = log.With("profile", owner.Name)

	parseOpts := ParseOptions{
		InstanceID:     h.instance,
		Profile:        owner.Name,
		RoutingContext: owner.Context,
	}
	switch owner.Auth {
	case profile.AuthDigest:
		credential, authorized := h.authorize(ctx, req, tx, log)
		if !authorized {
			return
		}
		parseOpts.Authentication = AuthenticationDigest
		parseOpts.OrgID = credential.OrgID
		// Rebuilt from the CREDENTIAL rather than copied from the From header, even though the two
		// were just checked to agree: the check is on the user part alone, and taking the whole
		// string from the message would let a phone choose the domain spelling the engine sees.
		parseOpts.CallerAOR = "sip:" + credential.Username + "@" + strings.ToLower(credential.Realm)
	case profile.AuthTrunkACL:
		entry, allowed := owner.ACL.Match(req.Source())
		if !allowed {
			// 403 and never a challenge: there is no credential a carrier could offer here, so a
			// 401 would be an instruction the far end cannot follow.
			log.Warn("refusing an INVITE from a source outside the trunk ACL")
			h.respond(tx, req, statusForbidden, "Forbidden")
			return
		}
		parseOpts.Authentication = AuthenticationTrunkACL
		parseOpts.TrunkID = entry.TrunkID
		log = log.With("trunkId", entry.TrunkID, "aclEntry", entry.Label)
	}

	parseOpts.LegID = h.newLegID()
	intent, err := Parse(req, parseOpts)
	if err != nil {
		log.Info("refusing a malformed INVITE", "error", err)
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return
	}
	log = log.With("legId", intent.LegID, "from", intent.From.Number, "to", intent.To.Number)

	// An attended transfer's completing INVITE. Correlated BEFORE anything is created, because a
	// Replaces that names no dialog we hold must be refused without minting a leg id, writing a
	// claim or spending a broker round trip on a call that cannot complete.
	replacedLegID := ""
	if replaces, present, err := replacesOf(req); present {
		if err != nil {
			log.Info("refusing an INVITE with a malformed Replaces", "error", err)
			h.respond(tx, req, statusBadRequest, "Bad Request")
			return
		}
		replaced, refusal, correlateErr := h.correlateReplaces(replaces)
		if correlateErr != nil {
			log.Info("refusing an INVITE whose Replaces named no dialog we hold",
				"replacesCallId", replaces.CallID, "status", refusal.Status, "error", correlateErr)
			h.respond(tx, req, refusal.Status, refusal.Reason)
			return
		}
		replacedLegID = replaced.LegID
		intent.Replaces = &replaces
		intent.ReplacesLegID = replacedLegID
		log = log.With("replacesLegId", replacedLegID)
	}

	// Session timers are negotiated BEFORE admission, because a 422 is a negotiation step the far
	// end will retry and there is no point spending a broker round trip on a call that is about to
	// be re-sent with a different interval.
	negotiation := dialog.NegotiateUAS(h.timers, dialog.ReadTimerHeaders(req.GetHeaders))
	if negotiation.Refused() {
		h.refuseTimers(req, tx, negotiation, log)
		return
	}

	session, state, err := h.createLeg(req, tx, owner, intent, negotiation.Timer, log)
	if err == nil {
		state.replacesLegID = replacedLegID
	}
	if err != nil {
		log.Error("cannot create the dialog", "error", err)
		h.respond(tx, req, statusServerError, "Server Internal Error")
		return
	}

	// The 100 goes out BEFORE the admission request, always. A silent engine must cost the caller a
	// bounded wait and not a Timer B — the same argument the REFER handler makes for its 202
	// (design §4.2).
	if _, err := session.Apply(ctx, dialog.Input{Trigger: dialog.TriggerLocalTrying}); err != nil {
		log.Error("cannot send 100 Trying", "error", err)
	}

	admitCtx, cancelAdmit := context.WithTimeout(h.baseCtx, h.admitTimeout)
	defer cancelAdmit()
	admission, admitErr := h.port.Admit(admitCtx, intent)

	switch {
	case admitErr != nil:
		// No answer at all. Answered on this edge's own authority, with a Retry-After, and logged
		// as distinct from a refusal — the same distinction `transfer/client.go` draws.
		log.Error("the admission request failed", "error", admitErr)
		h.refuse(session, state, TimeoutRefusal(), log)
	case !admission.OK:
		log.Warn("the engine refused the call",
			"reason", string(admission.Reason), "detail", admission.Detail)
		h.refuse(session, state, StatusFor(admission.Reason), log)
	default:
		h.admitted(session, state, admission, log)
	}
}

// createLeg mints the dialog, its session and its claim, and records the sipgo objects the effects
// will need.
func (h *Handler) createLeg(
	req *sip.Request,
	tx sip.ServerTransaction,
	owner profile.Profile,
	intent CallIntent,
	timer dialog.SessionTimer,
	log *slog.Logger,
) (*dialog.Session, *legState, error) {
	localTag := h.newTag()
	identity := dialog.Identity{
		SIPCallID: intent.SIPCallID,
		LocalTag:  localTag,
		RemoteTag: intent.FromTag,
	}
	if !identity.Established() {
		return nil, nil, dialog.ErrNoIdentity
	}

	target := dialog.Target{
		Observed:  req.Source(),
		Transport: strings.ToLower(req.Transport()),
		RouteSet:  routeSetOf(req.GetHeaders("Record-Route"), dialog.RoleUAS),
	}
	if contact := req.Contact(); contact != nil {
		target.Contact = contact.Address
	}

	created, err := dialog.New(dialog.Options{
		LegID:    intent.LegID,
		OrgID:    intent.OrgID,
		TrunkID:  intent.TrunkID,
		Role:     dialog.RoleUAS,
		Identity: identity,
		Target:   target,
		Profile:  owner.Name,
		Now:      h.now,
	})
	if err != nil {
		return nil, nil, err
	}
	created.SetTimer(timer)

	state := &legState{
		invite:   req,
		inviteTx: tx,
		profile:  owner,
	}
	if to := req.To(); to != nil {
		state.local = to.Address
	}
	if from := req.From(); from != nil {
		state.remote = from.Address
	}

	session := dialog.NewSession(created, dialog.SessionOptions{
		Handler: &executor{handler: h, state: state},
		Logger:  log,
	})
	if err := h.dialogs.Insert(created); err != nil {
		session.Close()
		return nil, nil, err
	}
	h.mu.Lock()
	h.legs[created.LegID] = &leg{session: session, state: state}
	h.mu.Unlock()
	h.writeClaim(created)

	// A CANCEL that arrives before we have answered anything is handled by sipgo's transaction
	// layer (200 to the CANCEL, then 487 on the INVITE). What it does NOT do is tell anybody, so
	// the hook is here and it posts the trigger onto the dialog's own mailbox — which is what makes
	// the CANCEL/answer race decidable rather than lucky.
	tx.OnCancel(func(*sip.Request) {
		ctx, cancel := context.WithTimeout(h.baseCtx, 2*time.Second)
		defer cancel()
		if _, err := session.Apply(ctx, dialog.Input{Trigger: dialog.TriggerRemoteCancel}); err != nil {
			log.Debug("a CANCEL reached a dialog that had already moved on", "error", err)
		}
	})
	return session, state, nil
}

// admitted records what the engine resolved and starts the ring timeout.
func (h *Handler) admitted(
	session *dialog.Session,
	state *legState,
	admission Admission,
	log *slog.Logger,
) {
	ctx, cancel := context.WithTimeout(h.baseCtx, 2*time.Second)
	defer cancel()

	_ = session.Inspect(ctx, func(d *dialog.Dialog) {
		d.OrgID = admission.OrgID
		d.CallID = admission.CallID
		h.writeClaim(d)
		// The ring timeout is armed INSIDE the session, so the timer's own goroutine and the
		// dialog's cannot disagree about whether the call was already answered.
		state.ringTimer = time.AfterFunc(h.ringTimeout, func() {
			timeoutCtx, cancelTimeout := context.WithTimeout(h.baseCtx, 5*time.Second)
			defer cancelTimeout()
			_, _ = session.Apply(timeoutCtx, dialog.Input{
				Trigger: dialog.TriggerTimeout,
				Timeout: dialog.TimeoutRing,
			})
		})
	})
	log.Info("call admitted",
		"orgId", admission.OrgID,
		"callId", admission.CallID,
		"engineInstance", admission.InstanceID,
		"routingContext", admission.RoutingContext,
		"direction", admission.Direction)
}

// refuse ends a dialog that was never admitted, with the status the reason maps to.
func (h *Handler) refuse(session *dialog.Session, state *legState, refusal Refusal, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(h.baseCtx, 2*time.Second)
	defer cancel()

	if refusal.RetryAfter > 0 {
		state.retryAfter = int(refusal.RetryAfter / time.Second)
	}
	if _, err := session.Apply(ctx, dialog.Input{
		Trigger: dialog.TriggerLocalReject,
		Status:  refusal.Status,
		Reason:  refusal.Reason,
		Cause:   dialog.CauseForStatus(refusal.Status),
	}); err != nil {
		log.Error("cannot refuse the call", "error", err)
	}
}

// refuseTimers answers a session-timer negotiation this edge will not accept.
func (h *Handler) refuseTimers(
	req *sip.Request,
	tx sip.ServerTransaction,
	negotiation dialog.Negotiation,
	log *slog.Logger,
) {
	switch negotiation.RefuseStatus {
	case 422:
		log.Info("refusing a session interval below our floor",
			"minSeSeconds", int(negotiation.MinSEHeader/time.Second))
		res := sip.NewResponseFromRequest(req, 422, "Session Interval Too Small", nil)
		res.AppendHeader(sip.NewHeader("Min-SE", fmt.Sprintf("%d", int(negotiation.MinSEHeader/time.Second))))
		res.AppendHeader(sip.NewHeader("Server", h.server))
		h.send(tx, res)
	default:
		log.Info("refusing an INVITE that requires session timers this profile has turned off")
		res := sip.NewResponseFromRequest(req, 420, "Bad Extension", nil)
		res.AppendHeader(sip.NewHeader("Unsupported", "timer"))
		res.AppendHeader(sip.NewHeader("Server", h.server))
		h.send(tx, res)
	}
}

// ---------------------------------------------------------------------------------------------
// mid-dialog requests
// ---------------------------------------------------------------------------------------------

// HandleAck feeds the ACK for our 2xx to the dialog it confirms.
//
// An ACK for a 2xx is its own transaction (RFC 3261 §17.1.1.3), so it arrives here rather than on
// the INVITE's transaction, and it is never answered — an ACK has no response.
func (h *Handler) HandleAck(req *sip.Request, _ sip.ServerTransaction) {
	target, found := h.dialogs.MatchRequest(req)
	if !found {
		h.log.Debug("an ACK arrived for no dialog we hold", "sipCallId", headerValue(req, "Call-ID"))
		return
	}
	h.post(target.LegID, dialog.Input{Trigger: dialog.TriggerRemoteAck})
}

// HandleBye ends a dialog at the far end's request.
func (h *Handler) HandleBye(req *sip.Request, tx sip.ServerTransaction) {
	target, found := h.dialogs.MatchRequest(req)
	if !found {
		// 481 is the correct answer and it is also the honest one: this instance does not hold that
		// dialog. Under a dialog-affine load balancer that means the call is over; under a
		// misconfigured one it means the BYE reached the wrong replica, and the log says which
		// Call-ID so the difference is diagnosable (design §6.4).
		h.respond(tx, req, statusCallDoesNotExist, "Call/Transaction Does Not Exist")
		return
	}
	h.withLeg(target.LegID, func(session *dialog.Session, state *legState) {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()
		cause, stated := causeOfBye(req)
		_, err := session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
			state.pending, state.pendingTx = req, tx
			return d.Apply(dialog.Input{
				Trigger:               dialog.TriggerRemoteBye,
				Cause:                 cause,
				CauseFromReasonHeader: stated,
			})
		})
		if err != nil {
			h.log.Debug("a BYE reached a dialog that had already ended",
				"legId", target.LegID, "error", err)
		}
	})
}

// HandleCancel answers a CANCEL that sipgo's transaction layer did not match.
//
// A CANCEL that DOES match a live INVITE transaction never reaches here — the transaction layer
// answers it 200 and drives the INVITE to 487, and the hook installed in createLeg is what tells
// the dialog. One that reaches here matched nothing, which almost always means the final response
// has already gone out: RFC 3261 §9.2's "no effect", answered 481.
func (h *Handler) HandleCancel(req *sip.Request, tx sip.ServerTransaction) {
	target, found := h.dialogs.MatchRequest(req)
	if !found {
		h.respond(tx, req, statusCallDoesNotExist, "Call/Transaction Does Not Exist")
		return
	}
	h.withLeg(target.LegID, func(session *dialog.Session, state *legState) {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()
		_, err := session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
			state.pending, state.pendingTx = req, tx
			return d.Apply(dialog.Input{Trigger: dialog.TriggerRemoteCancel})
		})
		if errors.Is(err, dialog.ErrCancelTooLate) {
			h.log.Info("a CANCEL lost the race with the 200 and was answered 481",
				"legId", target.LegID)
		}
	})
}

// HandleUpdate answers RFC 3311 UPDATE, which is how a phone renegotiates a session that has not
// been answered yet — hold while ringing, and the early-dialog half of a target refresh.
func (h *Handler) HandleUpdate(req *sip.Request, tx sip.ServerTransaction) {
	target, found := h.dialogs.MatchRequest(req)
	if !found {
		h.respond(tx, req, statusCallDoesNotExist, "Call/Transaction Does Not Exist")
		return
	}
	h.handleMidDialogOffer(target.LegID, dialog.KindUpdate, req, tx)
}

// handleMidDialogOffer is the shared body of re-INVITE and UPDATE.
//
// It ACCEPTS or REFUSES; it does not answer. The answer body comes from mediad by way of the
// engine, so acceptance means "hold the transaction open and expect an answer command" — and the
// command surface that would deliver it is the boundary this wave stops at. Until it exists an
// accepted offer is answered with the answer we already committed, which is correct for the two
// cases that do not change the media (a target refresh and a session-timer refresh) and is the
// honest best available for the ones that do.
func (h *Handler) handleMidDialogOffer(
	legID string,
	kind dialog.MidDialogKind,
	req *sip.Request,
	tx sip.ServerTransaction,
) {
	h.withLeg(legID, func(session *dialog.Session, state *legState) {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()

		log := h.log.With("legId", legID, "method", kind.String())
		var contact *sip.Uri
		if header := req.Contact(); header != nil {
			address := header.Address
			contact = &address
		}

		_, err := session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
			state.pending, state.pendingTx = req, tx

			outcome, err := d.ApplyMidDialog(dialog.MidDialogInput{
				Kind:     kind,
				Body:     req.Body(),
				Contact:  contact,
				Observed: req.Source(),
				Timer:    dialog.ReadTimerHeaders(req.GetHeaders),
			})
			if err != nil || !outcome.Accepted {
				status, reason := outcome.Status, outcome.Reason
				if status == 0 {
					status, reason = statusServerError, "Server Internal Error"
				}
				effects := append([]dialog.Effect(nil), outcome.Effects...)
				effects = append(effects, dialog.Effect{
					Kind: dialog.EffectRespondToRequest, Status: status, Reason: reason,
					Detail: retryAfterDetail(outcome.RetryAfter),
				})
				log.Info("refusing a mid-dialog offer", "status", status, "reason", reason)
				return dialog.Outcome{Effects: effects}, err
			}

			// A refresh renegotiates the interval rather than silently keeping the old one.
			negotiation := dialog.NegotiateUAS(h.timers, dialog.ReadTimerHeaders(req.GetHeaders))
			if !negotiation.Refused() && negotiation.Timer.Negotiated() {
				d.RefreshTimer(negotiation.Timer)
			}
			if outcome.HoldChanged {
				log.Info("the far end changed the media direction",
					"direction", string(outcome.Direction), "held", outcome.Held)
			}
			effects := append([]dialog.Effect(nil), outcome.Effects...)
			effects = append(effects, d.AnswerMidDialog(nil)...)
			return dialog.Outcome{Effects: effects}, nil
		})
		if err != nil && !errors.Is(err, dialog.ErrInvalidState) && !errors.Is(err, dialog.ErrDialogGone) {
			log.Error("cannot process a mid-dialog offer", "error", err)
		}
	})
}

// HandleInfo answers SIP INFO, which carries DTMF on the handsets that do not use RFC 4733.
func (h *Handler) HandleInfo(req *sip.Request, tx sip.ServerTransaction) {
	target, found := h.dialogs.MatchRequest(req)
	if !found {
		h.respond(tx, req, statusCallDoesNotExist, "Call/Transaction Does Not Exist")
		return
	}
	digit, duration, ok := parseDTMF(req)
	if !ok {
		// An INFO body this edge does not understand is answered 200 rather than refused: INFO is
		// an extension point and refusing an unknown one has broken interop with more handsets than
		// it has ever protected.
		h.respond(tx, req, statusOK, "OK")
		return
	}
	h.log.Info("dtmf", "legId", target.LegID, "digit", digit, "durationMs", duration)
	h.publish(Event{
		Kind:       dialog.EventDTMF,
		LegID:      target.LegID,
		OrgID:      target.OrgID,
		CallID:     target.CallID,
		SIPCallID:  target.Identity.SIPCallID,
		LocalTag:   target.Identity.LocalTag,
		RemoteTag:  target.Identity.RemoteTag,
		Role:       target.Role,
		Digit:      digit,
		DurationMs: duration,
		Detail:     digit,
		At:         h.now(),
	})
	h.respond(tx, req, statusOK, "OK")
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

// post feeds one trigger to a dialog's session, with a bounded wait.
func (h *Handler) post(legID string, in dialog.Input) {
	h.withLeg(legID, func(session *dialog.Session, _ *legState) {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()
		if _, err := session.Apply(ctx, in); err != nil {
			h.log.Debug("a trigger reached a dialog that would not take it",
				"legId", legID, "trigger", in.Trigger.String(), "error", err)
		}
	})
}

// withLeg runs a function against a leg's session, if this instance still holds it.
func (h *Handler) withLeg(legID string, run func(*dialog.Session, *legState)) {
	h.mu.Lock()
	found, ok := h.legs[legID]
	h.mu.Unlock()
	if !ok {
		return
	}
	run(found.session, found.state)
}

// forget drops a leg and stops its session. Called from the release-claim effect, which every
// teardown path produces exactly once.
func (h *Handler) forget(legID string) {
	h.mu.Lock()
	found, ok := h.legs[legID]
	delete(h.legs, legID)
	h.mu.Unlock()
	if !ok {
		return
	}
	h.dialogs.Remove(legID)
	if h.claims != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := h.claims.Delete(ctx, legID); err != nil {
			h.log.Warn("cannot release the dialog claim", "legId", legID, "error", err)
		}
	}
	// Closing from inside the session's own goroutine would deadlock, so it happens on a goroutine
	// of its own. Close waits for the loop to drain, which is what makes a command already in the
	// mailbox get an answer rather than vanish.
	h.backgroundWork.Add(1)
	go func() {
		defer h.backgroundWork.Done()
		found.session.Close()
	}()
}

// writeClaim publishes the dialog's `sip-dialogs` record.
func (h *Handler) writeClaim(d *dialog.Dialog) {
	if h.claims == nil {
		return
	}
	ctx, cancel := context.WithTimeout(h.baseCtx, 3*time.Second)
	defer cancel()
	if err := h.claims.Put(ctx, h.dialogs.ClaimFor(d)); err != nil {
		// A claim that cannot be written costs reaping, not the call. Failing the INVITE here would
		// drop a working call because a bucket was full.
		h.log.Warn("cannot write the dialog claim", "legId", d.LegID, "error", err)
	}
}

func (h *Handler) publish(event Event) {
	ctx, cancel := context.WithTimeout(h.baseCtx, 3*time.Second)
	defer cancel()
	if err := h.events.Publish(ctx, event); err != nil {
		h.log.Error("cannot publish a dialog event", "legId", event.LegID, "error", err)
	}
}

// authorize runs the digest exchange for an INVITE.
//
// The status choices mirror the registrar's and the REFER handler's, for the same reasons: 401 for
// "no credentials" and "stale nonce" because the device can retry, 403 for everything else because
// re-challenging a wrong password produces a loop some handsets run forever.
func (h *Handler) authorize(
	ctx context.Context,
	req *sip.Request,
	tx sip.ServerTransaction,
	log *slog.Logger,
) (credentials.Credential, bool) {
	from := req.From()
	if from == nil || from.Address.User == "" {
		log.Info("refusing an INVITE with no usable From address")
		h.respond(tx, req, statusBadRequest, "Bad Request")
		return credentials.Credential{}, false
	}

	auth, err := registrar.ParseAuthorization(headerValue(req, "Authorization"))
	if err != nil {
		if errors.Is(err, registrar.ErrNoAuthorization) {
			h.challenge(req, tx, false, log)
			return credentials.Credential{}, false
		}
		log.Info("refusing a malformed Authorization header", "error", err)
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
	// An account may only CALL AS ITSELF. Without this any valid account on the realm could place a
	// call carrying somebody else's From and have the engine attribute it to them — which is a
	// billing problem before it is an impersonation one.
	if auth.Username != from.Address.User {
		log.Warn("refusing an INVITE sent as somebody else", "authenticatedAs", auth.Username)
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}

	credential, err := h.creds.Lookup(ctx, h.realm, auth.Username)
	if err != nil {
		switch {
		case errors.Is(err, credentials.ErrNotFound):
			log.Info("refusing an unknown account", "username", auth.Username)
		case errors.Is(err, credentials.ErrDisabled):
			log.Info("refusing a disabled account", "username", auth.Username)
		default:
			log.Error("cannot look up the account", "username", auth.Username, "error", err)
		}
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}
	// INVITE, not REGISTER: HA2 is MD5(method:uri), so verifying with the wrong method name accepts
	// nothing and would make every call fail with a password error nobody could explain.
	if err := h.auth.Verify(req.Method.String(), auth, credential.HA1); err != nil {
		if errors.Is(err, registrar.ErrNonceStale) {
			h.challenge(req, tx, true, log)
			return credentials.Credential{}, false
		}
		log.Warn("refusing a failed digest", "username", auth.Username, "reason", err)
		h.respond(tx, req, statusForbidden, "Forbidden")
		return credentials.Credential{}, false
	}
	return credential, true
}

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

// causeOfBye reads the RFC 3326 Reason header off a BYE, which is the only way to learn WHY the
// far end hung up. Absent means normal clearing, because that is what a BYE means when nobody says
// otherwise.
//
// The second result says the cause was STATED rather than assumed, and it travels all the way to
// `dialog.terminated.causeFromReasonHeader`. It is not bookkeeping: a stated cause is better
// evidence than a derived one, and when two CDRs for one call disagree, the one whose cause the far
// end put on the wire is the one to believe.
func causeOfBye(req *sip.Request) (cause int, stated bool) {
	for _, header := range req.GetHeaders("Reason") {
		if cause, found := dialog.CauseFromReason(header.Value()); found {
			return cause, true
		}
	}
	return dialog.CauseNormalClearing, false
}

func retryAfterDetail(after time.Duration) string {
	if after <= 0 {
		return ""
	}
	return "retry-after:" + fmt.Sprintf("%d", int(after/time.Second))
}

// parseDTMF reads an `application/dtmf-relay` INFO body, which is the de facto format every handset
// that sends DTMF over INFO uses:
//
//	Signal=5
//	Duration=160
//
// `application/dtmf` (a bare digit) is accepted too, because several older phones send that.
func parseDTMF(req *sip.Request) (digit string, durationMs int, ok bool) {
	contentType := strings.ToLower(headerValue(req, "Content-Type"))
	body := strings.TrimSpace(string(req.Body()))
	if body == "" {
		return "", 0, false
	}
	switch {
	case strings.Contains(contentType, "dtmf-relay"):
		for _, line := range strings.Split(body, "\n") {
			name, value, found := strings.Cut(strings.TrimSpace(line), "=")
			if !found {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(name)) {
			case "signal":
				digit = strings.TrimSpace(value)
			case "duration":
				if parsed, err := parseInt(strings.TrimSpace(value)); err == nil {
					durationMs = parsed
				}
			}
		}
		return digit, durationMs, digit != ""
	case strings.Contains(contentType, "dtmf"):
		return body, 0, true
	default:
		return "", 0, false
	}
}
