package invite

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
// Unlike Requester, which is fire-and-forget, an INVITE's responses are the call: the 18x is a
// `dialog.progressed`, the 2xx a `dialog.answered`, a final failure the only report of a bad number.
// So the transaction is returned and the caller pumps it.
type Caller interface {
	Invite(ctx context.Context, req *sip.Request) (sip.ClientTransaction, error)
}

// ClientCaller is the production Caller: sipgo's client, transaction retained.
type ClientCaller struct {
	client *sipgo.Client
}

var _ Caller = (*ClientCaller)(nil)

// NewClientCaller wraps a sipgo client. A nil client is a wiring mistake, refused here rather than
// on the first originate.
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

// TrunkDirectory resolves a trunk id to the configuration needed to dial over it. An interface so
// the watcher that fills it (internal/trunk) and the path that reads it share one definition.
type TrunkDirectory interface {
	Trunk(orgID, trunkID string) (trunk.Config, bool)
}

// Originate places an outbound call and returns as soon as the INVITE is on the socket. The 2xx is
// a full transaction away and arrives as `dialog.answered`.
//
// Order: resolve the target, build the request, then create the dialog and insert it into the store
// BEFORE the INVITE goes out — the far end's `100 Trying` can arrive before TransactionRequest has
// returned, and a dialog not yet in the store matches nothing.
//
// It does not fork: several contacts may exist for one AOR, this dials the primary, and the engine
// originates one leg per contact. It holds no codec knowledge; the offer is forwarded verbatim.
func (h *Handler) Originate(
	ctx context.Context,
	request contract.SipOriginateRequest,
) (requestURI, sipCallID string, err error) {
	if h.caller == nil {
		return "", "", fmt.Errorf("invite: originate for leg %s: no SIP client is wired: %w",
			request.LegID, dialog.ErrNotSupported)
	}
	if _, exists := h.session(request.LegID); exists {
		// A repeat originate for a leg already in flight must not place a second call.
		// `ErrDuplicateLeg` becomes `invalid_state` so the engine inspects the leg it has.
		return "", "", fmt.Errorf("invite: originate for leg %s: %w",
			request.LegID, dialog.ErrDuplicateLeg)
	}

	target, err := h.resolveTarget(ctx, request)
	if err != nil {
		return "", "", err
	}
	if target.owner != "" && target.owner != h.instance {
		return "", "", fmt.Errorf("invite: registered flow belongs to another SIP instance: %w", dialog.ErrNoRoute)
	}
	if request.Target.ContactURI != nil && target.requestURI.String() != *request.Target.ContactURI {
		return "", "", fmt.Errorf("invite: registered contact changed after resolution: %w", dialog.ErrUnregisteredTarget)
	}

	invite, callID := h.buildOriginateInvite(request, target)
	session, state, err := h.createOutboundLeg(request, target, invite, callID)
	if err != nil {
		return "", "", fmt.Errorf("invite: originate for leg %s: %w", request.LegID, err)
	}

	tx, err := h.caller.Invite(ctx, invite)
	if err != nil {
		// Nothing reached the wire, so no response and no trigger will ever end this dialog. Torn
		// down here rather than left holding a claim until the reaper notices.
		h.abandonOutbound(session, request.LegID)
		return "", "", fmt.Errorf("invite: originate for leg %s to %s: %w: %w",
			request.LegID, target.requestURI.String(), dialog.ErrNoRoute, err)
	}

	h.armOriginateTimeout(session, state, request)
	h.pumpInviteTransaction(session, state, target.trunkConfig, request.LegID, tx)

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

// dialTarget is a resolved destination: where the INVITE is addressed, where it is sent, and the
// trunk it belongs to when there is one. The Request-URI is what the far end expects to be called;
// the destination is the socket the packet goes to. They differ behind NAT and behind an SBC.
type dialTarget struct {
	contacts   []contract.SipResolveTargetResponseContacts
	owner      string
	requestURI sip.Uri
	// aor is the address of record we resolved, as opposed to requestURI which is the registered
	// CONTACT it currently lives at. Empty for a trunk or a bare URI.
	aor string
	// destination is an explicit host:port to write to, empty when the Request-URI's own host is it.
	destination string
	// from is the address this edge presents as: for a trunk the carrier's domain rather than our
	// realm, since most carriers refuse a From whose domain they do not recognise.
	from      sip.Uri
	transport string
	trunkID   string
	// authUser and authRealm are the trunk's digest identity, carried so a 401 on the INVITE can be
	// answered. Empty for an AOR or a bare URI.
	authUser    string
	authRealm   string
	trunkConfig *trunk.Config
	// sharedLineNumber and appearanceIndex place this target on a shared line appearance (SLA). When
	// appearanceIndex is non-nil the INVITE gets a `Call-Info` appearance-index header so the phone
	// lights the right line key. Nil for an ordinary AOR, a trunk, or a bare URI.
	sharedLineNumber *string
	appearanceIndex  *int
}

// resolveTarget turns the contract's three-shaped target into one address.
func (h *Handler) resolveTarget(
	ctx context.Context,
	request contract.SipOriginateRequest,
) (dialTarget, error) {
	switch request.Target.Kind {
	case contract.SipOriginateRequestTargetKindAOR:
		return h.resolveAOR(ctx, request.OrgID, deref(request.Target.AOR), deref(request.Target.ContactURI))
	case contract.SipOriginateRequestTargetKindTrunk:
		return h.resolveTrunk(request.OrgID, deref(request.Target.TrunkID), deref(request.Target.Number))
	case contract.SipOriginateRequestTargetKindURI:
		return h.resolveURI(deref(request.Target.URI))
	default:
		return dialTarget{}, fmt.Errorf("invite: originate for leg %s: %q is not a dial target kind: %w",
			request.LegID, request.Target.Kind, dialog.ErrNotSupported)
	}
}

// resolveAOR reads this edge's own location service.
//
// A binding that exists but has lapsed is treated as absent: the bucket's TTL is an hour, longer
// than any sane Expires, so an entry can be present and dead.
func (h *Handler) resolveAOR(ctx context.Context, orgID, address, contactURI string) (dialTarget, error) {
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
	// Through internal/aor rather than the flat fields, so every reader agrees on which contact is
	// the primary regardless of how the binding was written.
	live, _ := aor.FromBinding(binding).Expire(h.now())
	primary, ok := live.Primary()
	if contactURI != "" {
		ok = false
		for _, contact := range live.Contacts() {
			if contact.URI == contactURI {
				primary, ok = contact, true
				break
			}
		}
	}
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
		aor:        address,
		owner:      primary.SIPDInstanceID,
		// The observed source, not the Contact: a device behind NAT advertises an address that does
		// not work.
		destination: primary.SourceAddress,
		from:        h.contact,
		transport:   primary.Transport,
		// The shared-line appearance travels with the primary contact.
		sharedLineNumber: primary.SharedLineNumber,
		appearanceIndex:  primary.AppearanceIndex,
	}
	for _, contact := range live.Contacts() {
		owner := contact.SIPDInstanceID
		if owner == "" {
			owner = h.instance
		}
		target.contacts = append(target.contacts, contract.SipResolveTargetResponseContacts{
			RequestURI: contact.URI, InstanceID: owner, Transport: contract.SIPTransport(contact.Transport), Q: contact.Q,
		})
	}
	if target.transport == "" {
		target.transport = strings.ToLower(string(binding.Transport))
	}
	return target, nil
}

// ResolveTarget reads the location service before the engine chooses a media transport.
func (h *Handler) ResolveTarget(ctx context.Context, orgID string, target contract.SipOriginateRequestTarget) (contract.SipResolveTargetResponse, error) {
	resolved, err := h.resolveTarget(ctx, contract.SipOriginateRequest{OrgID: orgID, Target: target})
	if err != nil {
		return contract.SipResolveTargetResponse{}, err
	}
	owner := resolved.owner
	if owner == "" {
		owner = h.instance
	}
	transport := strings.ToLower(resolved.transport)
	if transport == "" {
		transport = "udp"
	}
	uri, wireTransport := resolved.requestURI.String(), contract.SIPTransport(transport)
	return contract.SipResolveTargetResponse{Ok: true, RequestURI: &uri, Transport: &wireTransport, InstanceID: &owner, Contacts: resolved.contacts}, nil
}

// resolveTrunk reads the trunk directory. `unknown_trunk` means the directory has not reached this
// instance, not that the trunk does not exist, so the engine may retry elsewhere.
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

	// SIPProxy and not Registrar: a carrier may take registrations at one address and calls at
	// another.
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
		// The From presents the carrier's domain and not our realm: a carrier that does not
		// recognise the domain refuses the INVITE, usually with a bare 403.
		from:        sip.Uri{Scheme: "sip", Host: domain},
		transport:   config.Transport,
		trunkID:     config.TrunkID,
		authUser:    config.AuthUser,
		authRealm:   config.AuthRealm,
		trunkConfig: &config,
	}
	if proxy := config.OutboundProxy; proxy != "" {
		// The Request-URI still names the carrier and the packet goes to the SBC; rewriting the URI
		// would make the SBC the callee.
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

// buildOriginateInvite assembles the INVITE. Caller-supplied headers pass through headerAllowed, a
// security boundary: a contract that let the engine write `From` would make this edge's own
// authorisation decorative. The check is on names, because a value cannot be validated and a name
// can.
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
	displayName := deref(request.CallerIDName)
	restricted := request.CallerIDPresentation != nil &&
		*request.CallerIDPresentation == contract.SipOriginateRequestCallerIDPresentationRestricted

	fromHeader := &sip.FromHeader{Address: from, DisplayName: displayName, Params: sip.NewParams()}
	if restricted {
		// RFC 3323 §4.1.1.3: literally this display name and this reserved host. A real domain here
		// leaks the tenant; the real identity still travels in P-Asserted-Identity.
		fromHeader.Address = sip.Uri{Scheme: "sip", User: "anonymous", Host: "anonymous.invalid"}
		fromHeader.DisplayName = "Anonymous"
	}
	fromHeader.Params.Add("tag", h.newTag())
	req.AppendHeader(fromHeader)
	// RFC 3261 §8.1.1.2: the To names the LOGICAL recipient — the address of record — while the
	// Request-URI names the contact it currently lives at. The distinction is not cosmetic here: a
	// phone builds every in-dialog request's From from this To (RFC 3261 §12.2), so a registered
	// contact in it makes the callee's own REFER claim an anonymous instance URI.
	to := target.requestURI
	if target.aor != "" {
		aorURI := sip.Uri{}
		if err := sip.ParseUri(target.aor, &aorURI); err == nil {
			to = aorURI
		}
	}
	req.AppendHeader(&sip.ToHeader{Address: to, Params: sip.NewParams()})

	if target.trunkID != "" {
		// RFC 3325 §7, on every trunk INVITE regardless of presentation: carriers authenticate the
		// trunk's identity on PAI and treat From as display-only, so a trunk sending From alone has
		// its tenant's chosen caller ID overwritten upstream. Trunks only — PAI is valid inside a
		// trust domain, never toward a registered device.
		req.AppendHeader(sip.NewHeader("P-Asserted-Identity", assertedIdentity(displayName, from)))
	}
	if restricted {
		// RFC 3323 §4.2: `id`, not `user`. The From is already anonymised here; this asks the
		// trust-domain edge to strip the asserted identity before the call leaves it.
		req.AppendHeader(sip.NewHeader("Privacy", "id"))
	}

	// The Call-ID is minted here and is deliberately not the leg id: it is phone-facing and goes on
	// the wire, so reusing the leg id would expose a platform identifier to every carrier we peer
	// with.
	callID := sip.CallIDHeader(contract.NewEventID() + "@" + h.contact.Host)
	req.AppendHeader(&callID)
	req.AppendHeader(&sip.CSeqHeader{SeqNo: 1, MethodName: sip.INVITE})
	contact := h.contact
	if target.trunkID != "" && target.authUser != "" {
		contact.User = target.authUser
	}
	req.AppendHeader(&sip.ContactHeader{Address: contact})
	req.AppendHeader(sip.NewHeader("Max-Forwards", "70"))
	req.AppendHeader(sip.NewHeader("User-Agent", h.server))
	req.AppendHeader(sip.NewHeader("Allow", "INVITE, ACK, CANCEL, BYE, UPDATE, INFO, OPTIONS, REFER, NOTIFY"))

	// Shared line appearance: tell the phone which appearance so it lights the right line key. The
	// number falls back to the target user when the credential named none; the domain is the
	// request-URI host so the phone recognises the URI. Omitted for an ordinary extension.
	if target.appearanceIndex != nil {
		number := target.requestURI.User
		if target.sharedLineNumber != nil && *target.sharedLineNumber != "" {
			number = *target.sharedLineNumber
		}
		domain := target.requestURI.Host
		req.AppendHeader(sip.NewHeader("Call-Info",
			fmt.Sprintf("<sip:%s@%s>;appearance-index=%d", number, domain, *target.appearanceIndex)))
	}

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

// assertedIdentity renders one RFC 3325 P-Asserted-Identity value: the real identity, with the
// display name only when there is one. One `sip:` form and no `tel:` twin.
func assertedIdentity(displayName string, uri sip.Uri) string {
	if displayName == "" {
		return "<" + uri.String() + ">"
	}
	return "\"" + displayName + "\" <" + uri.String() + ">"
}

// headerAllowed decides whether a caller-supplied header name may go on an INVITE.
//
// The allowlist is structural: anything beginning `X-` is a private extension by RFC convention and
// cannot mean anything to a proxy, plus a short list of standard headers carrying no routing or
// authorisation weight. Everything else — identity (`From`, `P-Asserted-Identity`), routing
// (`Route`, `Record-Route`, `Via`, `Contact`) and credentials — is refused, because letting one
// through would make this edge's own decisions advisory.
func headerAllowed(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return false
	}
	switch strings.ToLower(trimmed) {
	case "x-telnyx-username", "x-telnyx-token":
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
// BEFORE the INVITE goes out. See Originate for why the order is not negotiable.
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
			// indexes on the early key until then, so a 100, a CANCEL and Timer B all find it.
		},
		Target: dialog.Target{
			Contact:   target.requestURI,
			Observed:  target.destination,
			Transport: target.transport,
		},
		Profile:    profileNameForOutbound,
		AccountAOR: target.aor,
		Now:        h.now,
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
	if request.EngineInstanceID != nil {
		state.engineInstanceID = *request.EngineInstanceID
	}
	if owner, found := h.profiles.ByName(profileNameForOutbound); found {
		state.profile = owner
	} else if profiles := h.profiles.Profiles(); len(profiles) > 0 {
		// An outbound leg has no listener and therefore no profile of its own. It borrows the first
		// declared one purely for its NAT policy, the only field the mid-dialog path reads.
		state.profile = profiles[0]
	}

	session := dialog.NewSession(created, dialog.SessionOptions{
		Handler:  &executor{handler: h, state: state},
		OnUpdate: h.dialogs.Touch,
		Logger:   h.log.With("legId", created.LegID),
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

// profileNameForOutbound is the profile an originated leg records on its claim. It deliberately
// never matches a listener profile: the field records the policy the leg was admitted under, and an
// originated leg was admitted by the engine.
const profileNameForOutbound = "outbound"

// abandonOutbound tears a leg down that never reached the wire.
func (h *Handler) abandonOutbound(session *dialog.Session, legID string) {
	h.forget(legID)
	_ = session
}

// armOriginateTimeout gives an unanswered INVITE a deadline: an originate that rings for ever is a
// dialog and an RTP port pair held by nobody. Backstop for a silent engine, whose own shorter ring
// timeout normally fires first.
func (h *Handler) armOriginateTimeout(
	session *dialog.Session,
	state *legState,
	request contract.SipOriginateRequest,
) {
	timeout := h.ringTimeout
	if request.RingTimeoutMs != nil && *request.RingTimeoutMs > 0 {
		timeout = time.Duration(*request.RingTimeoutMs) * time.Millisecond
	}
	timer := time.AfterFunc(timeout, func() {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()
		_, _ = session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
			if d.State().Answered() || d.State() == dialog.StateTerminating || d.State() == dialog.StateTerminated {
				return dialog.Outcome{}, nil
			}
			return d.Apply(dialog.Input{Trigger: dialog.TriggerTimeout, Timeout: dialog.TimeoutRing})
		})
	})
	// Answer may beat timer installation; check on the same serialized dialog task.
	_, err := session.Do(h.baseCtx, func(d *dialog.Dialog) (dialog.Outcome, error) {
		if d.State().Answered() || d.State() == dialog.StateTerminating || d.State() == dialog.StateTerminated {
			timer.Stop()
		} else {
			state.ringTimer = timer
		}
		return dialog.Outcome{}, nil
	})
	if err != nil {
		timer.Stop()
	}
}

// pumpInviteTransaction feeds the client transaction's responses into the dialog machine, one
// goroutine per outstanding INVITE. sipgo closes the response channel when the transaction
// terminates, so the loop ends on its own and needs no separate cancellation.
//
// A UAC dialog's identity is incomplete until the far end answers with a tag (RFC 3261 §12.1.2), so
// the tag is rebound on the first response that carries one; otherwise every mid-dialog request on
// an outbound call would be answered 481.
func (h *Handler) pumpInviteTransaction(session *dialog.Session, state *legState, config *trunk.Config, legID string, tx sip.ClientTransaction) {
	retransmissions := make(chan *sip.Response, 16)
	listenForRetransmissions := func(transaction sip.ClientTransaction) {
		transaction.OnRetransmission(func(response *sip.Response) {
			select {
			case retransmissions <- response:
			default:
				// Bound work during a response flood; the peer will retransmit an unacknowledged 2xx.
			}
		})
	}
	listenForRetransmissions(tx)
	h.backgroundWork.Go(func() {
		defer func() { tx.Terminate() }()
		seenChallenges := make(map[string]bool)
		answered := false

		for {
			select {
			case <-h.baseCtx.Done():
				return
			case <-session.Done():
				return
			case response := <-retransmissions:
				h.applyInviteResponse(session, legID, response)
			case <-tx.Done():
				// The transaction ended without a final response we acted on — Timer B, or a
				// transport error. TimeoutInvite reports Q.850 18, "no user responding".
				if err := tx.Err(); err != nil && !answered {
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
				if config != nil && h.trunkAuth != nil && len(seenChallenges) < 3 {
					key := trunk.ChallengeKey(res)
					if key != "" && !seenChallenges[key] {
						seenChallenges[key] = true
						next, err := h.retryOutboundAuthentication(session, state, *config, res)
						if err == nil {
							tx.Terminate()
							tx = next
							listenForRetransmissions(tx)
							continue
						}
						h.log.Warn("outbound carrier authentication failed", "legId", legID)
					}
				}
				h.applyInviteResponse(session, legID, res)
				if res.StatusCode >= 200 && res.StatusCode < 300 {
					// Keep listening through Timer M so a retransmitted 2xx gets another ACK.
					answered = true
				}
				if res.StatusCode >= 300 {
					return
				}
			}
		}
	})
}

func (h *Handler) retryOutboundAuthentication(session *dialog.Session, state *legState, config trunk.Config, response *sip.Response) (sip.ClientTransaction, error) {
	ctx, cancel := context.WithTimeout(h.baseCtx, 6*time.Second)
	defer cancel()
	go func() {
		select {
		case <-session.Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	var original *sip.Request
	_, err := session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
		if d.State() != dialog.StateInit && d.State() != dialog.StateProceeding && d.State() != dialog.StateEarly {
			return dialog.Outcome{}, errors.New("outbound call is no longer ringing")
		}
		state.authCancel = cancel
		original = state.invite.Clone()
		return dialog.Outcome{}, nil
	})
	if err != nil {
		return nil, err
	}
	authorized, err := h.trunkAuth.Authorize(ctx, config, original, response)
	if err != nil {
		return nil, err
	}
	var next sip.ClientTransaction
	_, err = session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
		if d.State() != dialog.StateInit && d.State() != dialog.StateProceeding && d.State() != dialog.StateEarly {
			return dialog.Outcome{}, errors.New("outbound call ended during authentication")
		}
		var sendErr error
		next, sendErr = h.caller.Invite(ctx, authorized)
		if sendErr != nil {
			return dialog.Outcome{}, sendErr
		}
		// CANCEL and the final ACK must use the authenticated INVITE's CSeq and Via.
		state.invite = authorized
		state.localCSeq = authorized.CSeq().SeqNo
		return dialog.Outcome{}, nil
	})
	return next, err
}

// applyInviteResponse turns one response into one trigger, splitting four ways per RFC 3261
// §12.1.2. An 18x carrying a To tag creates an early dialog — one a CANCEL can end and a session
// timer can be negotiated on; one without a tag creates nothing. sipgo models neither.
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
			// A final response with no To tag: legal for a failure, and still the end of the call.
			in.Trigger = dialog.TriggerRemoteFailure
		}
	case res.StatusCode < 200:
		in.Trigger = dialog.TriggerRemoteEarly
	case res.StatusCode < 300:
		in.Trigger = dialog.TriggerRemoteAnswer
	default:
		in.Trigger = dialog.TriggerRemoteFailure
		if cause, found := causeOfResponse(res); found {
			// An RFC 3326 `Reason` on a failure response wins verbatim over anything derived from
			// the status code.
			in.Cause = cause
			in.CauseFromReasonHeader = true
		}
	}

	if _, err := session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
		previous := d.Target
		if res.StatusCode >= 180 && res.StatusCode < 300 && remoteTag != "" &&
			(d.Identity.RemoteTag == "" || d.Identity.RemoteTag == remoteTag) {
			if contact := res.Contact(); contact != nil {
				d.Target.Contact = contact.Address
			}
			d.Target.RouteSet = routeSetOf(res.GetHeaders("Record-Route"), dialog.RoleUAC)
			d.Target.Observed = res.Source()
			d.Target.Transport = strings.ToLower(res.Transport())
		}
		outcome, err := d.Apply(in)
		if err != nil {
			d.Target = previous
		}
		return outcome, err
	}); err != nil {
		h.log.Debug("a response reached a dialog that would not take it",
			"legId", legID, "status", res.StatusCode, "error", err)
		return
	}

	// Rebound after the trigger, so the store's index never points at a triple the dialog does not
	// yet hold.
	if remoteTag != "" {
		_ = session.Inspect(ctx, func(d *dialog.Dialog) {
			if d.Identity.RemoteTag != remoteTag {
				return
			}
			if err := h.dialogs.Rebind(legID, d.Identity); err != nil {
				// The dialog ended between the trigger and this rebind — a 200 racing a CANCEL, or a
				// hangup that landed first. Expected, and there is nothing left to re-index.
				level := slog.LevelWarn
				if errors.Is(err, dialog.ErrUnknownDialog) {
					level = slog.LevelDebug
				}
				h.log.Log(ctx, level, "cannot re-index an outbound dialog on its remote tag",
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
