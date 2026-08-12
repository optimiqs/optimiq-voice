package invite

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/aor"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/trunk"
)

// Caller places an INVITE and hands back its client transaction.
//
// # Why this is not internal/invite.Requester
//
// Requester is fire-and-forget past the transaction layer, which is exactly right for a BYE: its 200
// changes nothing we would act on, and waiting for one would hold a goroutine open against a far end
// that has often already gone. An INVITE is the opposite in every respect — its responses ARE the
// call, the 18x is a `dialog.progressed`, the 2xx is a `dialog.answered`, and a final failure is the
// only thing that will ever tell us the number was wrong. So this returns the transaction, and the
// caller pumps it.
type Caller interface {
	Invite(ctx context.Context, req *sip.Request) (sip.ClientTransaction, error)
}

// ClientCaller is the production Caller: sipgo's client, transaction retained.
type ClientCaller struct {
	client *sipgo.Client
}

var _ Caller = (*ClientCaller)(nil)

// NewClientCaller wraps a sipgo client. A nil client is refused here rather than on the first
// originate, because it is a wiring mistake and not a runtime state.
func NewClientCaller(client *sipgo.Client) (*ClientCaller, error) {
	if client == nil {
		return nil, errors.New("invite: a SIP client is required to originate calls")
	}
	return &ClientCaller{client: client}, nil
}

// Invite implements Caller.
func (c *ClientCaller) Invite(ctx context.Context, req *sip.Request) (sip.ClientTransaction, error) {
	return c.client.TransactionRequest(ctx, req)
}

// TrunkDirectory resolves a trunk id to the configuration needed to dial over it.
//
// An interface so the originate path is testable with a map, and so the WATCHER that fills it
// (internal/trunk) and the path that reads it cannot drift into two opinions about what a trunk is.
type TrunkDirectory interface {
	Trunk(orgID, trunkID string) (trunk.Config, bool)
}

// Originate places an outbound call and returns as soon as the INVITE is on the socket.
//
// # The five steps, and why the order is what it is
//
//  1. RESOLVE the target. Before anything is created, because a target that resolves to nothing must
//     be refused without minting a dialog, writing a claim or leaving a session goroutine behind.
//  2. BUILD the request. Still nothing created; a request that cannot be built is a bad_request.
//  3. CREATE the dialog, its session and its claim, and INSERT it into the store BEFORE the INVITE
//     goes out. This is the one ordering that is not merely tidy: the far end's `100 Trying` can
//     arrive before TransactionRequest has returned, and a dialog that is not in the store yet is a
//     response that matches nothing and a `dialog.progressed` that is never published.
//  4. SEND, and start pumping the transaction on a goroutine of its own.
//  5. RETURN. The 2xx is a full transaction away and arrives as `dialog.answered`.
//
// # What it does NOT do
//
// It does not fork. `registrations` may hold several contacts for one AOR and this dials the PRIMARY
// one; the engine forks, and it forks better, because `dialSimultaneous` already mints one channel
// id per attempt, installs a watcher on each before any originate is issued, settles on the first
// answer and produces a CDR row per attempt. An edge that forked would reproduce the race, the
// per-attempt accounting and the confirmation flow in a process that has no CDR and no plan
// (design §5.3). The multi-contact set is REPORTED — internal/aor writes every live contact into the
// binding — and the engine originates one leg per contact.
//
// It also holds no codec knowledge. The offer was written by mediad's `create-offer` and is
// forwarded verbatim, exactly as an inbound offer is forwarded unparsed.
func (h *Handler) Originate(
	ctx context.Context,
	request contract.SipOriginateRequest,
) (requestURI, sipCallID string, err error) {
	if h.caller == nil {
		return "", "", fmt.Errorf("invite: originate for leg %s: no SIP client is wired: %w",
			request.LegID, dialog.ErrNotSupported)
	}
	if _, exists := h.session(request.LegID); exists {
		// Idempotency has a limit and this is it: a repeat originate for a leg already in flight must
		// not place a second call. `ErrDuplicateLeg` becomes `invalid_state`, which tells the engine
		// to look at the leg it already has rather than to retry.
		return "", "", fmt.Errorf("invite: originate for leg %s: %w",
			request.LegID, dialog.ErrDuplicateLeg)
	}

	target, err := h.resolveTarget(ctx, request)
	if err != nil {
		return "", "", err
	}

	invite, callID := h.buildOriginateInvite(request, target)
	session, state, err := h.createOutboundLeg(request, target, invite, callID)
	if err != nil {
		return "", "", fmt.Errorf("invite: originate for leg %s: %w", request.LegID, err)
	}

	tx, err := h.caller.Invite(ctx, invite)
	if err != nil {
		// Nothing reached the wire. The leg is torn down here rather than left for a timeout: a
		// dialog whose INVITE was never sent will never receive a response, so no trigger will ever
		// end it, and it would sit in the store holding a claim until the reaper noticed.
		h.abandonOutbound(session, request.LegID)
		return "", "", fmt.Errorf("invite: originate for leg %s to %s: %w: %w",
			request.LegID, target.requestURI.String(), dialog.ErrNoRoute, err)
	}

	h.armOriginateTimeout(session, state, request)
	h.pumpInviteTransaction(session, request.LegID, tx)

	h.log.Info("originated a call",
		"legId", request.LegID,
		"orgId", request.OrgID,
		"callId", request.CallID,
		"targetKind", string(request.Target.Kind),
		"requestUri", target.requestURI.String(),
		"destination", target.destination,
		"sipCallId", callID)
	return target.requestURI.String(), callID, nil
}

// dialTarget is a resolved destination: where the INVITE is ADDRESSED, where it is SENT, and the
// trunk it belongs to when there is one.
//
// The two addresses are separate for the reason every other path in this service keeps them
// separate: the Request-URI is what the far end expects to be called, and the destination is the
// socket the packet goes to. For a registered device behind NAT they differ; for a carrier fronted
// by an SBC they differ; conflating them is a call that is never delivered.
type dialTarget struct {
	requestURI sip.Uri
	// destination is an explicit host:port to write to, empty when the Request-URI's own host is it.
	destination string
	// from is the address this edge presents as, which for a trunk is the CARRIER's domain rather
	// than our realm — a From whose domain the carrier does not recognise is refused by most of them.
	from      sip.Uri
	transport string
	trunkID   string
	// authUser and authRealm are the trunk's digest identity, carried so a 401 on the INVITE can be
	// answered. Empty for an AOR or a bare URI.
	authUser  string
	authRealm string
}

// resolveTarget turns the contract's three-shaped target into one address.
func (h *Handler) resolveTarget(
	ctx context.Context,
	request contract.SipOriginateRequest,
) (dialTarget, error) {
	switch request.Target.Kind {
	case contract.SipOriginateRequestTargetKindAOR:
		return h.resolveAOR(ctx, request.OrgID, deref(request.Target.AOR))
	case contract.SipOriginateRequestTargetKindTrunk:
		return h.resolveTrunk(request.OrgID, deref(request.Target.TrunkID), deref(request.Target.Number))
	case contract.SipOriginateRequestTargetKindURI:
		return h.resolveURI(deref(request.Target.URI))
	default:
		return dialTarget{}, fmt.Errorf("invite: originate for leg %s: %q is not a dial target kind: %w",
			request.LegID, request.Target.Kind, dialog.ErrNotSupported)
	}
}

// resolveAOR reads this edge's OWN location service.
//
// # Why the lookup moved here
//
// Today `PJSIP/1001` makes Asterisk consult its own registrar. On this plane the lookup happens in
// the process that OWNS the location service and already writes it, which deletes a duplicate
// registrar rather than adding a hop (design §5.1).
//
// A binding that exists and has LAPSED is treated as absent. The bucket's TTL is an hour, longer
// than any sane Expires, so an entry can be present and dead — and dialling a phone that unplugged
// fifty minutes ago produces a call that rings into a socket nobody is listening on, and a
// `no_route` thirty seconds later instead of an `unregistered_target` now.
func (h *Handler) resolveAOR(ctx context.Context, orgID, address string) (dialTarget, error) {
	if h.bindings == nil {
		return dialTarget{}, fmt.Errorf("invite: no location service is wired: %w", dialog.ErrNotSupported)
	}
	hash, err := contract.AORSubjectToken(address)
	if err != nil {
		return dialTarget{}, fmt.Errorf("invite: %q is not a usable address of record: %w: %w",
			address, dialog.ErrUnregisteredTarget, err)
	}
	binding, found, err := h.bindings.Get(ctx, orgID, hash)
	if err != nil {
		return dialTarget{}, fmt.Errorf("invite: cannot read the registration for %s: %w", address, err)
	}
	if !found {
		return dialTarget{}, fmt.Errorf("invite: %s has no registration: %w",
			address, dialog.ErrUnregisteredTarget)
	}
	// Through internal/aor rather than off the flat fields, so a binding written with a contacts
	// array and one written before that field existed resolve identically — and so the PRIMARY this
	// dials is the same contact every other reader calls the primary.
	primary, ok := aor.FromBinding(binding).Primary()
	if !ok || primary.URI == "" {
		return dialTarget{}, fmt.Errorf("invite: %s has a registration with no contact: %w",
			address, dialog.ErrUnregisteredTarget)
	}
	if primary.Expired(h.now()) {
		return dialTarget{}, fmt.Errorf("invite: %s registered until %s and that has passed: %w",
			address, primary.ExpiresAt.Format(time.RFC3339), dialog.ErrUnregisteredTarget)
	}

	uri := sip.Uri{}
	if err := sip.ParseUri(primary.URI, &uri); err != nil {
		return dialTarget{}, fmt.Errorf("invite: %s is registered at an unparsable contact %q: %w: %w",
			address, primary.URI, dialog.ErrNoRoute, err)
	}
	target := dialTarget{
		requestURI: uri,
		// The observed source, not the Contact. A device behind NAT advertises an address that does
		// not work; the address its packets came from is the one that does. Same split internal/nat
		// draws for every mid-dialog request, applied to the first one.
		destination: primary.SourceAddress,
		from:        h.contact,
		transport:   primary.Transport,
	}
	if target.transport == "" {
		target.transport = strings.ToLower(string(binding.Transport))
	}
	return target, nil
}

// resolveTrunk reads the trunk directory.
//
// `unknown_trunk` when the directory has no entry, and the distinction the contract draws is worth
// preserving in the message: it means the trunk directory has not REACHED this instance, not that
// the trunk does not exist, so the engine's recovery is to try another instance rather than to fail
// the call outright.
func (h *Handler) resolveTrunk(orgID, trunkID, number string) (dialTarget, error) {
	if h.trunks == nil {
		return dialTarget{}, fmt.Errorf("invite: no trunk directory is wired: %w", dialog.ErrUnknownTrunk)
	}
	config, found := h.trunks.Trunk(orgID, trunkID)
	if !found {
		return dialTarget{}, fmt.Errorf("invite: trunk %s is not in this instance's directory: %w",
			trunkID, dialog.ErrUnknownTrunk)
	}
	if !config.Enabled {
		return dialTarget{}, fmt.Errorf("invite: trunk %q is administratively disabled: %w",
			config.Name, dialog.ErrUnknownTrunk)
	}

	// SIPProxy and not Registrar: a carrier may take registrations at one address and CALLS at
	// another, and the column set keeps them apart precisely because some do.
	host, port := splitHostPort(config.SIPProxy)
	if host == "" {
		return dialTarget{}, fmt.Errorf("invite: trunk %q has no proxy to send INVITEs to: %w",
			config.Name, dialog.ErrNoRoute)
	}
	domain := config.SIPDomain
	if domain == "" {
		domain = host
	}

	target := dialTarget{
		requestURI: sip.Uri{Scheme: "sip", User: number, Host: host, Port: port},
		// The From presents the CARRIER's domain and not our realm. A carrier that does not recognise
		// the domain in a From refuses the INVITE, and the refusal is usually a bare 403 with no
		// explanation — which is a long afternoon for whoever is debugging it.
		from:      sip.Uri{Scheme: "sip", Host: domain},
		transport: config.Transport,
		trunkID:   config.TrunkID,
		authUser:  config.AuthUser,
		authRealm: config.AuthRealm,
	}
	if proxy := config.OutboundProxy; proxy != "" {
		// The Request-URI still names the carrier and the packet goes to the SBC. Rewriting the URI
		// instead would make the SBC the callee, which is what a pre-loaded route exists to avoid.
		target.destination = proxy
	}
	return target, nil
}

// resolveURI dials a fully-qualified target verbatim — a REFER into another domain, and the escape
// hatch for anything the two structured kinds cannot express.
func (h *Handler) resolveURI(raw string) (dialTarget, error) {
	uri := sip.Uri{}
	if err := sip.ParseUri(raw, &uri); err != nil {
		return dialTarget{}, fmt.Errorf("invite: %q is not a dialable URI: %w: %w",
			raw, dialog.ErrNoRoute, err)
	}
	if uri.Host == "" {
		return dialTarget{}, fmt.Errorf("invite: %q names no host: %w", raw, dialog.ErrNoRoute)
	}
	return dialTarget{requestURI: uri, from: h.contact}, nil
}

// buildOriginateInvite assembles the INVITE.
//
// # The headers allowlist, which is a security boundary and not tidiness
//
// `sipOriginateRequestSchema.headers` is documented as deliberately not a free-for-all: the edge
// refuses any name that would let a caller forge a routing or authentication header, "because a
// contract that let the engine write `From` would make the edge's own authorisation decorative".
// That check is here, and it is a check on NAMES rather than on values, because a value cannot be
// validated and a name can.
func (h *Handler) buildOriginateInvite(
	request contract.SipOriginateRequest,
	target dialTarget,
) (*sip.Request, string) {
	req := sip.NewRequest(sip.INVITE, target.requestURI)

	from := target.from
	if number := deref(request.CallerIDNumber); number != "" {
		from.User = number
	}
	if from.User == "" {
		from.User = h.contact.User
	}
	fromHeader := &sip.FromHeader{Address: from, Params: sip.NewParams()}
	fromHeader.Params.Add("tag", h.newTag())
	if name := deref(request.CallerIDName); name != "" {
		fromHeader.DisplayName = name
	}
	req.AppendHeader(fromHeader)
	req.AppendHeader(&sip.ToHeader{Address: target.requestURI, Params: sip.NewParams()})

	// The Call-ID is minted HERE and is not the leg id. One string names the leg, the mediad session
	// and this dialog (design §3.1); the SIP Call-ID is a separate, phone-facing identifier that goes
	// on the wire, and using the leg id for both would put a platform identifier in front of every
	// carrier we peer with.
	callID := sip.CallIDHeader(contract.NewEventID() + "@" + h.contact.Host)
	req.AppendHeader(&callID)
	req.AppendHeader(&sip.CSeqHeader{SeqNo: 1, MethodName: sip.INVITE})
	req.AppendHeader(&sip.ContactHeader{Address: h.contact})
	req.AppendHeader(sip.NewHeader("Max-Forwards", "70"))
	req.AppendHeader(sip.NewHeader("User-Agent", h.server))
	req.AppendHeader(sip.NewHeader("Allow", "INVITE, ACK, CANCEL, BYE, UPDATE, INFO, OPTIONS, REFER, NOTIFY"))

	for name, value := range request.Headers {
		if !headerAllowed(name) {
			h.log.Warn("refusing to put a caller-supplied header on an INVITE",
				"legId", request.LegID, "header", name)
			continue
		}
		req.AppendHeader(sip.NewHeader(name, value))
	}

	req.SetBody([]byte(request.SDPOffer))
	req.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))

	if target.transport != "" {
		req.SetTransport(strings.ToUpper(target.transport))
	}
	if target.destination != "" {
		req.SetDestination(target.destination)
	}
	return req, callID.Value()
}

// headerAllowed decides whether a caller-supplied header name may go on an INVITE.
//
// # An allowlist by SHAPE, not an enumeration
//
// `X-` headers are the whole point of the field — a tenant's carrier expects `X-Account-Code`, the
// support desk wants `X-Optimiq-Call-Id` in the capture — and enumerating them would mean a code
// change per carrier. So the rule is structural: anything beginning `X-` is a private extension by
// RFC convention and cannot mean anything to a proxy, plus a short list of genuinely useful standard
// headers that carry no routing or authorisation weight.
//
// Everything else is refused, and the ones that matter are worth naming: `From` and `P-Asserted-
// Identity` are the caller's identity, which this edge asserts and the engine may not overwrite;
// `Route` and `Record-Route` decide where the packet goes; `Via` decides where the response comes
// back; `Authorization` and `Proxy-Authorization` are credentials; `Contact` is where mid-dialog
// requests reach us. Letting any of them through would make this edge's own decisions advisory.
func headerAllowed(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return false
	}
	if len(trimmed) > 2 && strings.EqualFold(trimmed[:2], "x-") {
		return true
	}
	switch strings.ToLower(trimmed) {
	case "subject", "priority", "call-info", "alert-info", "user-to-user":
		return true
	default:
		return false
	}
}

// createOutboundLeg mints the UAC dialog, its session and its claim, and inserts it into the store
// BEFORE the INVITE goes out. See Originate's step 3 for why the order is not negotiable.
func (h *Handler) createOutboundLeg(
	request contract.SipOriginateRequest,
	target dialTarget,
	invite *sip.Request,
	callID string,
) (*dialog.Session, *legState, error) {
	localTag, _ := invite.From().Params.Get("tag")
	created, err := dialog.New(dialog.Options{
		LegID:   request.LegID,
		OrgID:   request.OrgID,
		CallID:  request.CallID,
		TrunkID: target.trunkID,
		Role:    dialog.RoleUAC,
		Identity: dialog.Identity{
			SIPCallID: callID,
			LocalTag:  localTag,
			// RemoteTag is unknown until the far end answers with one (RFC 3261 §12.1.2). The store
			// indexes on the EARLY key until then, which is what lets a 100, a CANCEL and Timer B all
			// find this dialog before anybody has told us the far end's tag.
		},
		Target: dialog.Target{
			Contact:   target.requestURI,
			Observed:  target.destination,
			Transport: target.transport,
		},
		Profile: profileNameForOutbound,
		Now:     h.now,
	})
	if err != nil {
		return nil, nil, err
	}

	state := &legState{
		invite:    invite,
		local:     invite.From().Address,
		remote:    target.requestURI,
		localCSeq: 1,
	}
	if owner, found := h.profiles.ByName(profileNameForOutbound); found {
		state.profile = owner
	} else if profiles := h.profiles.Profiles(); len(profiles) > 0 {
		// An outbound leg has no listener and therefore no profile of its own. It borrows the first
		// declared one purely for its NAT policy, which is the only field the mid-dialog path reads —
		// and the first declared profile is the internal one in every configuration this service
		// builds.
		state.profile = profiles[0]
	}

	session := dialog.NewSession(created, dialog.SessionOptions{
		Handler: &executor{handler: h, state: state},
		Logger:  h.log.With("legId", created.LegID),
	})
	if err := h.dialogs.Insert(created); err != nil {
		session.Close()
		return nil, nil, err
	}
	h.mu.Lock()
	h.legs[created.LegID] = &leg{session: session, state: state}
	h.mu.Unlock()
	h.writeClaim(created)
	return session, state, nil
}

// profileNameForOutbound is the profile an originated leg records on its claim. It is not a listener
// profile and never matches one, which is deliberate: a claim that named `internal` would suggest the
// call arrived on the internal listener, and the profile field exists so a mid-dialog decision can
// apply the policy the leg was ADMITTED under. An originated leg was admitted by the engine.
const profileNameForOutbound = "outbound"

// abandonOutbound tears a leg down that never reached the wire.
func (h *Handler) abandonOutbound(session *dialog.Session, legID string) {
	h.forget(legID)
	_ = session
}

// armOriginateTimeout gives an unanswered INVITE a deadline.
//
// Bounded rather than open, for the reason `originateRequestSchema.ringTimeoutSeconds` gives: an
// originate that rings for ever is a dialog and an RTP port pair held by nobody. The engine's own
// ring timeout is normally shorter and is the one that fires; this is the belt-and-braces path for
// an engine that stopped answering mid-walk, which is the same job the inbound ring timer does.
func (h *Handler) armOriginateTimeout(
	session *dialog.Session,
	state *legState,
	request contract.SipOriginateRequest,
) {
	timeout := h.ringTimeout
	if request.RingTimeoutMs != nil && *request.RingTimeoutMs > 0 {
		timeout = time.Duration(*request.RingTimeoutMs) * time.Millisecond
	}
	legID := request.LegID
	timer := time.AfterFunc(timeout, func() {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()
		_, _ = session.Apply(ctx, dialog.Input{
			Trigger: dialog.TriggerTimeout,
			Timeout: dialog.TimeoutRing,
		})
	})
	// Recorded on the leg state so the release-claim effect stops it, exactly as the inbound path
	// does. A timer left armed on a leg that answered would CANCEL a live call thirty seconds in.
	_, _ = session.Do(h.baseCtx, func(*dialog.Dialog) (dialog.Outcome, error) {
		state.ringTimer = timer
		return dialog.Outcome{}, nil
	})
	_ = legID
}

// pumpInviteTransaction feeds the client transaction's responses into the dialog machine.
//
// # One goroutine per outstanding INVITE, and it ends with the transaction
//
// The responses ARE the call: an 18x is a `dialog.progressed`, the 2xx is a `dialog.answered` and
// the ACK that must follow it, and a final failure is the only thing that will ever say the number
// was wrong. sipgo's client transaction delivers them on a channel and closes it when the
// transaction terminates, so the loop below has a natural end and needs no separate cancellation.
//
// # Why the tag is rebound here
//
// A UAC dialog's identity is INCOMPLETE until the far end answers with a tag (RFC 3261 §12.1.2), and
// the BYE that arrives ten minutes later is matched on the complete triple. Rebinding on the first
// response that carries one is what stops this edge answering 481 to every mid-dialog request on
// every outbound call.
func (h *Handler) pumpInviteTransaction(session *dialog.Session, legID string, tx sip.ClientTransaction) {
	h.backgroundWork.Add(1)
	go func() {
		defer h.backgroundWork.Done()
		defer tx.Terminate()

		for {
			select {
			case <-h.baseCtx.Done():
				return
			case <-tx.Done():
				// The transaction ended without a final response we acted on — Timer B, or a
				// transport error. Either way the call never happened, and TimeoutInvite is the
				// trigger that says so with Q.850 18, "no user responding".
				if err := tx.Err(); err != nil {
					h.post(legID, dialog.Input{
						Trigger: dialog.TriggerTimeout,
						Timeout: dialog.TimeoutInvite,
					})
				}
				return
			case res, ok := <-tx.Responses():
				if !ok {
					return
				}
				h.applyInviteResponse(session, legID, res)
				if res.StatusCode >= 200 {
					// A final response ends the INVITE transaction. Anything after it belongs to a
					// different transaction and reaches this edge through the server side.
					return
				}
			}
		}
	}()
}

// applyInviteResponse turns one response into one trigger.
//
// The four-way split is RFC 3261 §12.1.2's, and the line that matters is between a provisional with
// a tag and one without: an 18x carrying a To tag CREATES an early dialog, which is a dialog a
// CANCEL can end and a session timer can be negotiated on, and one without a tag is a hop-by-hop
// acknowledgement that creates nothing. sipgo models neither, which is why this edge does.
func (h *Handler) applyInviteResponse(session *dialog.Session, legID string, res *sip.Response) {
	ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
	defer cancel()

	remoteTag := ""
	if to := res.To(); to != nil {
		remoteTag, _ = to.Params.Get("tag")
	}

	in := dialog.Input{
		Status:    res.StatusCode,
		Reason:    res.Reason,
		Body:      res.Body(),
		RemoteTag: remoteTag,
	}
	switch {
	case res.StatusCode < 180 || remoteTag == "":
		in.Trigger = dialog.TriggerRemoteProvisional
		if res.StatusCode >= 200 {
			// A final response with no To tag. Legal for a failure — a proxy's 404 need not create a
			// dialog — and it is still the end of the call.
			in.Trigger = dialog.TriggerRemoteFailure
		}
	case res.StatusCode < 200:
		in.Trigger = dialog.TriggerRemoteEarly
	case res.StatusCode < 300:
		in.Trigger = dialog.TriggerRemoteAnswer
	default:
		in.Trigger = dialog.TriggerRemoteFailure
		if cause, found := causeOfResponse(res); found {
			// An RFC 3326 `Reason` on a failure response is the far end's own account of why, and it
			// wins verbatim over anything derived from the status code.
			in.Cause = cause
			in.CauseFromReasonHeader = true
		}
	}

	if _, err := session.Apply(ctx, in); err != nil {
		h.log.Debug("a response reached a dialog that would not take it",
			"legId", legID, "status", res.StatusCode, "error", err)
		return
	}

	// Rebound AFTER the trigger, so the machine has already committed the tag it learned and the
	// store's index and the dialog agree. Doing it first would leave a window in which the index
	// pointed at a triple the dialog did not yet hold.
	if remoteTag != "" {
		_ = session.Inspect(ctx, func(d *dialog.Dialog) {
			if d.Identity.RemoteTag != remoteTag {
				return
			}
			if err := h.dialogs.Rebind(legID, d.Identity); err != nil {
				h.log.Warn("cannot re-index an outbound dialog on its remote tag",
					"legId", legID, "error", err)
			}
		})
	}
}

// causeOfResponse reads an RFC 3326 Reason header off a response.
func causeOfResponse(res *sip.Response) (int, bool) {
	for _, header := range res.GetHeaders("Reason") {
		if cause, found := dialog.CauseFromReason(header.Value()); found {
			return cause, true
		}
	}
	return 0, false
}

// splitHostPort separates `host:port` without failing on a bare host, which is how a trunk's proxy is
// usually written.
func splitHostPort(value string) (string, int) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", 0
	}
	uri := sip.Uri{}
	if err := sip.ParseUri(trimmed, &uri); err == nil && uri.Host != "" {
		return uri.Host, uri.Port
	}
	host, port, found := strings.Cut(trimmed, ":")
	if !found {
		return trimmed, 0
	}
	number := 0
	for _, r := range port {
		if r < '0' || r > '9' {
			return trimmed, 0
		}
		number = number*10 + int(r-'0')
	}
	return host, number
}
