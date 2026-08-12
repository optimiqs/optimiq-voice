package dialog

import (
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Refresher says which end of the dialog owes the periodic refresh (RFC 4028 §4).
type Refresher int

const (
	// RefresherNone means session timers are not in use on this dialog. It is the honest state for
	// a peer that never offered `Supported: timer`, and it must not be confused with "we are the
	// refresher and have not started yet": a one-sided timer is worse than none, because the side
	// that thinks there is a timer tears down a call the other side considers healthy.
	RefresherNone Refresher = iota
	// RefresherLocal means this edge refreshes. We send a re-INVITE or UPDATE at the mid-point.
	RefresherLocal
	// RefresherRemote means the far end refreshes and we only watch the deadline.
	RefresherRemote
)

// String renders the refresher as the wire token, from the point of view of the UAC that started
// the dialog — which is what `refresher=uac|uas` means and why it cannot be rendered without
// knowing the role.
func (r Refresher) String() string {
	switch r {
	case RefresherLocal:
		return "local"
	case RefresherRemote:
		return "remote"
	default:
		return "none"
	}
}

// WireToken renders the RFC 4028 `refresher` parameter for a message this side is about to send.
// A UAS that refreshes writes `refresher=uas`; a UAC that refreshes writes `refresher=uac`. The
// role has to be passed in because the token names the ROLE, not the direction.
func (r Refresher) WireToken(role Role) string {
	switch r {
	case RefresherLocal:
		if role == RoleUAS {
			return "uas"
		}
		return "uac"
	case RefresherRemote:
		if role == RoleUAS {
			return "uac"
		}
		return "uas"
	default:
		return ""
	}
}

// SessionTimer is the negotiated RFC 4028 state of one dialog.
type SessionTimer struct {
	// Interval is the agreed Session-Expires.
	Interval time.Duration
	// MinSE is the floor that was agreed, kept because a refresh must not undercut it.
	MinSE time.Duration
	// Refresher is who owes the refresh.
	Refresher Refresher
}

// Negotiated reports whether session timers are in use on this dialog.
func (t SessionTimer) Negotiated() bool {
	return t.Refresher != RefresherNone && t.Interval > 0
}

// RefreshAfter is when this side must send its refresh, and is zero when this side does not owe
// one.
//
// Half the interval, which is RFC 4028 §10's rule and is generous on purpose: a refresh that is
// lost still leaves a whole half-interval for a retransmission to succeed before the far end starts
// tearing the call down.
func (t SessionTimer) RefreshAfter() time.Duration {
	if !t.Negotiated() || t.Refresher != RefresherLocal {
		return 0
	}
	return t.Interval / 2
}

// ExpiresAfter is when this side gives up on a call that has not been refreshed.
//
// The full interval, and never earlier. RFC 4028 §10 lets the non-refresher act at the expiry; both
// ends acting at once is harmless (a BYE crossing a BYE is the ordinary simultaneous-hangup case
// this dialog layer already handles), whereas acting EARLY tears down a call whose refresh is on
// the wire.
func (t SessionTimer) ExpiresAfter() time.Duration {
	if !t.Negotiated() {
		return 0
	}
	return t.Interval
}

// TimerPolicy is this edge's own position, from configuration.
type TimerPolicy struct {
	// Enabled turns session timers on at all. Off is a legitimate deployment: two extensions on one
	// LAN do not need a keepalive, and mediad's RTP timeout already reaps a far end that vanished
	// (design §4.5). It becomes mandatory in front of carriers.
	Enabled bool
	// MinSE is the shortest interval we will accept. RFC 4028 §4 sets the floor at 90 seconds and
	// says so for a reason: a shorter one turns every call into a re-INVITE storm.
	MinSE time.Duration
	// DefaultSE is what we ask for as the UAC, and what we impose when a peer offers timers without
	// naming an interval.
	DefaultSE time.Duration
	// MaxSE clamps what a peer may ask for. A carrier that asks for a day-long session interval has
	// effectively disabled the timer.
	MaxSE time.Duration
	// PreferLocalRefresh makes this edge volunteer as the refresher when the peer expresses no
	// preference. Preferring to refresh is the safer default for a B2BUA: we are the one process
	// that certainly knows whether the call is still up, because we hold both dialogs.
	PreferLocalRefresh bool
}

// DefaultTimerPolicy is the shape a deployment gets when it turns timers on and configures nothing
// else. The numbers are RFC 4028's own recommendation (1800 s) and its hard floor (90 s).
func DefaultTimerPolicy() TimerPolicy {
	return TimerPolicy{
		Enabled:            true,
		MinSE:              90 * time.Second,
		DefaultSE:          1800 * time.Second,
		MaxSE:              7200 * time.Second,
		PreferLocalRefresh: true,
	}
}

// normalised fills in the RFC's floors for a policy that was configured loosely, so every caller
// below can assume the invariants rather than re-check them.
func (p TimerPolicy) normalised() TimerPolicy {
	if p.MinSE < 90*time.Second {
		p.MinSE = 90 * time.Second
	}
	if p.DefaultSE < p.MinSE {
		p.DefaultSE = p.MinSE
	}
	if p.MaxSE < p.DefaultSE {
		p.MaxSE = p.DefaultSE
	}
	return p
}

// TimerRequest is what a peer's message said about session timers.
type TimerRequest struct {
	// SessionExpires is the `Session-Expires` value, zero when the header was absent.
	SessionExpires time.Duration
	// Refresher is the `refresher` parameter verbatim: "uac", "uas" or "".
	RefresherParam string
	// MinSE is the peer's `Min-SE`, zero when absent.
	MinSE time.Duration
	// Supported is true when `Supported: timer` was present. It means the peer UNDERSTANDS session
	// timers; it does not mean the peer wants one.
	Supported bool
	// Required is true when `Require: timer` was present, which means the peer will not proceed
	// without them.
	Required bool
}

// Negotiation is the outcome of reading a peer's timer request against our policy.
type Negotiation struct {
	// Timer is what was agreed. Zero when nothing was.
	Timer SessionTimer
	// RefuseStatus is non-zero when the request cannot be accepted at all: 422 when the interval is
	// below our floor, 420 when the peer REQUIRES an extension we have turned off.
	RefuseStatus int
	// MinSEHeader is the `Min-SE` to put on a 422, which is what tells the peer what to ask for
	// next. A 422 without it is a refusal the peer cannot act on.
	MinSEHeader time.Duration
}

// Refused reports whether the request must be answered with a failure rather than accepted.
func (n Negotiation) Refused() bool { return n.RefuseStatus != 0 }

// NegotiateUAS decides what to do with an INVITE (or re-INVITE) that arrived here.
//
// # The three answers, and why each is what it is
//
//  1. 422 Session Interval Too Small, when the peer asked for less than our floor. RFC 4028 §6
//     requires the Min-SE header on it, and a peer that gets one retries at that value — so a 422
//     is a negotiation step and not a failure.
//  2. 420 Bad Extension, when the peer wrote `Require: timer` and this deployment has session
//     timers off. Refusing loudly is the only honest answer: accepting would leave the peer
//     expecting refreshes that will never come, and it would tear the call down mid-conversation.
//  3. An agreement, otherwise. A peer that says nothing at all gets no timer, because imposing one
//     on a UA that never advertised support produces refreshes it answers 501 to.
func NegotiateUAS(policy TimerPolicy, request TimerRequest) Negotiation {
	policy = policy.normalised()

	if !policy.Enabled {
		if request.Required {
			return Negotiation{RefuseStatus: 420}
		}
		return Negotiation{}
	}
	if !request.Supported && !request.Required && request.SessionExpires == 0 {
		// The peer knows nothing about session timers. A one-sided timer is worse than none.
		return Negotiation{}
	}

	floor := policy.MinSE
	if request.MinSE > floor {
		// The peer's floor is higher than ours. It is a floor and not a preference, so it wins.
		floor = request.MinSE
	}
	if request.SessionExpires > 0 && request.SessionExpires < policy.MinSE {
		return Negotiation{RefuseStatus: 422, MinSEHeader: policy.MinSE}
	}

	interval := request.SessionExpires
	if interval == 0 {
		interval = policy.DefaultSE
	}
	if interval > policy.MaxSE {
		interval = policy.MaxSE
	}
	if interval < floor {
		// Clamping down below an agreed floor would be proposing something we just said was too
		// small. The floor wins even when it exceeds our own maximum: it is the peer's hard limit.
		interval = floor
	}

	return Negotiation{Timer: SessionTimer{
		Interval:  interval,
		MinSE:     floor,
		Refresher: refresherFor(policy, request, RoleUAS),
	}}
}

// AcceptUACResponse reads the timer headers off a 2xx to an INVITE we sent.
//
// A far end that answers with no Session-Expires has declined the timer, and we must forget ours —
// keeping it would make this edge tear down a call the far end has every intention of continuing,
// which is the exact one-sided failure NegotiateUAS refuses to create in the other direction.
func AcceptUACResponse(policy TimerPolicy, response TimerRequest) SessionTimer {
	policy = policy.normalised()
	if !policy.Enabled || response.SessionExpires == 0 {
		return SessionTimer{}
	}
	interval := response.SessionExpires
	if interval > policy.MaxSE {
		interval = policy.MaxSE
	}
	floor := policy.MinSE
	if response.MinSE > floor {
		floor = response.MinSE
	}
	if interval < floor {
		interval = floor
	}
	return SessionTimer{
		Interval:  interval,
		MinSE:     floor,
		Refresher: refresherFor(policy, response, RoleUAC),
	}
}

// RetryAfter422 is what a UAC does with a `422 Session Interval Too Small`: ask again for the value
// the far end named, bounded by our own ceiling.
//
// Bounded, because the Min-SE on a 422 is attacker-influenced on a trunk: a peer that answers 422
// with `Min-SE: 86400` would otherwise talk us into a session timer that never fires. The second
// result reports whether a retry is worth making at all.
func RetryAfter422(policy TimerPolicy, minSE time.Duration) (time.Duration, bool) {
	policy = policy.normalised()
	switch {
	case minSE <= 0:
		return 0, false
	case minSE > policy.MaxSE:
		return 0, false
	default:
		return minSE, true
	}
}

// refresherFor applies RFC 4028 §7.2's rule: the party named in the `refresher` parameter
// refreshes, and when nobody is named the answering side chooses.
func refresherFor(policy TimerPolicy, request TimerRequest, role Role) Refresher {
	switch strings.ToLower(strings.TrimSpace(request.RefresherParam)) {
	case "uac":
		if role == RoleUAC {
			return RefresherLocal
		}
		return RefresherRemote
	case "uas":
		if role == RoleUAS {
			return RefresherLocal
		}
		return RefresherRemote
	}
	if policy.PreferLocalRefresh {
		return RefresherLocal
	}
	return RefresherRemote
}

// SetTimer records a negotiated timer on the dialog. It is a method rather than an exported field
// so the invariant — a timer is either fully negotiated or absent — has one place to hold.
func (d *Dialog) SetTimer(timer SessionTimer) { d.timer = timer }

// Timer reports the dialog's negotiated session timer.
func (d *Dialog) Timer() SessionTimer { return d.timer }

// ---------------------------------------------------------------------------------------------
// header reading
// ---------------------------------------------------------------------------------------------

// ReadTimerHeaders extracts the RFC 4028 request from a message's headers.
//
// It takes the accessors rather than a *sip.Request so one function serves requests and responses,
// which carry the same four headers and are two unrelated types in sipgo.
func ReadTimerHeaders(headers func(name string) []sip.Header) TimerRequest {
	request := TimerRequest{}

	for _, header := range headers("Session-Expires") {
		value, params := splitHeaderParams(header.Value())
		if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds > 0 {
			request.SessionExpires = time.Duration(seconds) * time.Second
		}
		if refresher, found := params["refresher"]; found {
			request.RefresherParam = refresher
		}
	}
	// The compact form. RFC 4028 §5 assigns `x` to Session-Expires, and several handsets use it.
	if request.SessionExpires == 0 {
		for _, header := range headers("x") {
			value, params := splitHeaderParams(header.Value())
			if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds > 0 {
				request.SessionExpires = time.Duration(seconds) * time.Second
			}
			if refresher, found := params["refresher"]; found {
				request.RefresherParam = refresher
			}
		}
	}
	for _, header := range headers("Min-SE") {
		value, _ := splitHeaderParams(header.Value())
		if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds > 0 {
			request.MinSE = time.Duration(seconds) * time.Second
		}
	}
	request.Supported = optionTagPresent(headers("Supported"), "timer")
	request.Required = optionTagPresent(headers("Require"), "timer")
	return request
}

// splitHeaderParams splits `1800;refresher=uas` into its value and its lower-cased parameters.
func splitHeaderParams(raw string) (string, map[string]string) {
	parts := strings.Split(raw, ";")
	params := make(map[string]string, len(parts))
	for _, part := range parts[1:] {
		name, value, found := strings.Cut(strings.TrimSpace(part), "=")
		if !found {
			continue
		}
		params[strings.ToLower(strings.TrimSpace(name))] = strings.ToLower(strings.Trim(strings.TrimSpace(value), `"`))
	}
	return parts[0], params
}

// optionTagPresent reports whether an option tag appears in any of the given headers.
//
// Comma-separated within one header AND repeated across several is legal (RFC 3261 §7.3.1), and
// handsets do both, so a reader that handles only one of the two finds `timer` on some phones and
// not on others — which would be a session timer that silently does not exist.
func optionTagPresent(headers []sip.Header, tag string) bool {
	for _, header := range headers {
		for _, candidate := range strings.Split(header.Value(), ",") {
			if strings.EqualFold(strings.TrimSpace(candidate), tag) {
				return true
			}
		}
	}
	return false
}

// SessionExpiresHeader renders the `Session-Expires` value this side puts on a message.
func SessionExpiresHeader(timer SessionTimer, role Role) string {
	seconds := int(timer.Interval / time.Second)
	token := timer.Refresher.WireToken(role)
	if token == "" {
		return strconv.Itoa(seconds)
	}
	return strconv.Itoa(seconds) + ";refresher=" + token
}
