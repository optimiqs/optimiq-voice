package dialog

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Refresher says which end of the dialog owes the periodic refresh (RFC 4028 §4).
type Refresher int

const (
	// RefresherNone means session timers are not in use on this dialog. A one-sided timer is worse
	// than none: the side that believes in it tears down a call the other considers healthy.
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
// one. Half the interval, per RFC 4028 §10, so a lost refresh still leaves a half-interval for a
// retransmission before the far end tears the call down.
func (t SessionTimer) RefreshAfter() time.Duration {
	if !t.Negotiated() || t.Refresher != RefresherLocal {
		return 0
	}
	return t.Interval / 2
}

// ExpiresAfter is when this side gives up on a call that has not been refreshed: the full interval
// and never earlier (RFC 4028 §10). Both ends acting at once is harmless — a BYE crossing a BYE —
// whereas acting early tears down a call whose refresh is still on the wire.
func (t SessionTimer) ExpiresAfter() time.Duration {
	if !t.Negotiated() {
		return 0
	}
	return t.Interval
}

// TimerPolicy is this edge's own position, from configuration.
type TimerPolicy struct {
	// Enabled turns session timers on at all. Off is legitimate on a LAN, where mediad's RTP timeout
	// already reaps a vanished far end (design §4.5).
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
	// preference. It is REFUSED by Validate while nothing here can send a refresh: the re-INVITE's
	// offer comes from mediad by way of the engine, so a refresher role this process cannot honour
	// is a peer tearing down a live call at the interval it was promised (RFC 4028 §7.2).
	PreferLocalRefresh bool
}

// ErrNoLocalRefresher means the policy volunteers this edge as the session refresher, which it
// cannot be: there is no command surface that builds a refresh re-INVITE or UPDATE.
var ErrNoLocalRefresher = errors.New(
	"dialog: session timers cannot select this edge as the refresher: sipd has no way to build a " +
		"refresh re-INVITE, so the far end would tear the call down at the interval it was promised")

// Validate refuses a configuration this edge cannot honour, at boot rather than at the first call.
func (p TimerPolicy) Validate() error {
	if p.Enabled && p.PreferLocalRefresh {
		return ErrNoLocalRefresher
	}
	return nil
}

// DefaultTimerPolicy is the shape a deployment gets when it turns timers on and configures nothing
// else. The numbers are RFC 4028's own recommendation (1800 s) and its hard floor (90 s). The far
// end refreshes, because this edge cannot (see PreferLocalRefresh).
func DefaultTimerPolicy() TimerPolicy {
	return TimerPolicy{
		Enabled:            true,
		MinSE:              90 * time.Second,
		DefaultSE:          1800 * time.Second,
		MaxSE:              7200 * time.Second,
		PreferLocalRefresh: false,
	}
}

// normalised fills in the RFC's floors for a policy that was configured loosely, so every caller
// below can assume the invariants rather than re-check them.
func (p TimerPolicy) normalised() TimerPolicy {
	p.MinSE = max(p.MinSE, 90*time.Second)
	p.DefaultSE = max(p.DefaultSE, p.MinSE)
	p.MaxSE = max(p.MaxSE, p.DefaultSE)
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

// NegotiateUAS decides what to do with an INVITE (or re-INVITE) that arrived here: 422 with a
// Min-SE when the peer asked below our floor (RFC 4028 §6 — a negotiation step, not a failure), 420
// when it wrote `Require: timer` and this deployment has timers off, otherwise an agreement. A peer
// that said nothing gets no timer, since imposing one produces refreshes it answers 501 to.
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

	// The peer's Min-SE is a floor and not a preference, so the higher of the two wins.
	floor := max(policy.MinSE, request.MinSE)
	if request.SessionExpires > 0 && request.SessionExpires < policy.MinSE {
		return Negotiation{RefuseStatus: 422, MinSEHeader: policy.MinSE}
	}

	interval := request.SessionExpires
	if interval == 0 {
		interval = policy.DefaultSE
	}
	// The floor wins even over our own maximum: clamping below it would propose an interval one of
	// the two ends has already called too small.
	interval = max(min(interval, policy.MaxSE), floor)

	return Negotiation{Timer: SessionTimer{
		Interval:  interval,
		MinSE:     floor,
		Refresher: refresherFor(policy, request, RoleUAS),
	}}
}

// AcceptUACResponse reads the timer headers off a 2xx to an INVITE we sent. A far end that answers
// with no Session-Expires has declined the timer and ours must be forgotten, or this edge tears
// down a call the far end intends to continue.
func AcceptUACResponse(policy TimerPolicy, response TimerRequest) SessionTimer {
	policy = policy.normalised()
	if !policy.Enabled || response.SessionExpires == 0 {
		return SessionTimer{}
	}
	floor := max(policy.MinSE, response.MinSE)
	interval := max(min(response.SessionExpires, policy.MaxSE), floor)
	return SessionTimer{
		Interval:  interval,
		MinSE:     floor,
		Refresher: refresherFor(policy, response, RoleUAC),
	}
}

// RetryAfter422 is what a UAC does with a `422 Session Interval Too Small`: ask again for the value
// the far end named, bounded by our own ceiling because that Min-SE is attacker-influenced on a
// trunk. The second result reports whether a retry is worth making at all.
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
//
// A peer that names US is answered with the opposite choice rather than a role this edge cannot
// perform — §7.2 leaves the refresher to the answering side, and a promised refresh that never
// comes ends a call that is up.
func refresherFor(policy TimerPolicy, request TimerRequest, role Role) Refresher {
	chosen := RefresherRemote
	switch strings.ToLower(strings.TrimSpace(request.RefresherParam)) {
	case "uac":
		if role == RoleUAC {
			chosen = RefresherLocal
		}
	case "uas":
		if role == RoleUAS {
			chosen = RefresherLocal
		}
	default:
		if policy.PreferLocalRefresh {
			chosen = RefresherLocal
		}
	}
	if chosen == RefresherLocal {
		// Nothing here can build a refresh, so the role is declined rather than accepted and
		// dropped. Remove this once a refresh command surface exists (see ErrNoLocalRefresher).
		return RefresherRemote
	}
	return chosen
}

// SetTimer records a negotiated timer on the dialog, keeping the invariant that a timer is either
// fully negotiated or absent in one place.
func (d *Dialog) SetTimer(timer SessionTimer) { d.timer = timer }

// Timer reports the dialog's negotiated session timer.
func (d *Dialog) Timer() SessionTimer { return d.timer }

// ReadTimerHeaders extracts the RFC 4028 request from a message's headers. It takes the accessor
// rather than a *sip.Request so one function serves both, which are unrelated types in sipgo.
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

// optionTagPresent reports whether an option tag appears in any of the given headers. Both the
// comma-separated and the repeated-header forms are legal (RFC 3261 §7.3.1) and handsets use both.
func optionTagPresent(headers []sip.Header, tag string) bool {
	for _, header := range headers {
		for candidate := range strings.SplitSeq(header.Value(), ",") {
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
