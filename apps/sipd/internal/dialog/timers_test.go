package dialog

import (
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
)

func seconds(n int) time.Duration { return time.Duration(n) * time.Second }

// RFC 4028's three answers: 422 with a Min-SE the peer can retry at, 420 when the peer REQUIRES an
// extension we have off, and an agreement otherwise.
func TestNegotiateUAS(t *testing.T) {
	enabled := DefaultTimerPolicy()
	disabled := TimerPolicy{Enabled: false}

	cases := []struct {
		name          string
		policy        TimerPolicy
		request       TimerRequest
		wantRefuse    int
		wantMinSE     time.Duration
		wantInterval  time.Duration
		wantRefresher Refresher
	}{
		{
			name:    "a peer that says nothing gets no timer: a one-sided timer is worse than none",
			policy:  enabled,
			request: TimerRequest{},
		},
		{
			name:          "a peer that supports timers and names no interval gets our default",
			policy:        enabled,
			request:       TimerRequest{Supported: true},
			wantInterval:  seconds(1800),
			wantRefresher: RefresherLocal,
		},
		{
			name:          "a peer's interval is honoured",
			policy:        enabled,
			request:       TimerRequest{Supported: true, SessionExpires: seconds(600)},
			wantInterval:  seconds(600),
			wantRefresher: RefresherLocal,
		},
		{
			name:       "an interval below our floor is 422 with the floor named",
			policy:     enabled,
			request:    TimerRequest{Supported: true, SessionExpires: seconds(30)},
			wantRefuse: 422,
			wantMinSE:  seconds(90),
		},
		{
			name:          "an interval above our ceiling is clamped down rather than refused",
			policy:        enabled,
			request:       TimerRequest{Supported: true, SessionExpires: seconds(86400)},
			wantInterval:  seconds(7200),
			wantRefresher: RefresherLocal,
		},
		{
			name:          "the peer's own Min-SE is a floor and wins over our clamp",
			policy:        TimerPolicy{Enabled: true, MinSE: seconds(90), DefaultSE: seconds(600), MaxSE: seconds(600), PreferLocalRefresh: true},
			request:       TimerRequest{Supported: true, SessionExpires: seconds(1800), MinSE: seconds(1200)},
			wantInterval:  seconds(1200),
			wantRefresher: RefresherLocal,
		},
		{
			name:          "refresher=uac makes the far end the refresher",
			policy:        enabled,
			request:       TimerRequest{Supported: true, SessionExpires: seconds(600), RefresherParam: "uac"},
			wantInterval:  seconds(600),
			wantRefresher: RefresherRemote,
		},
		{
			name:          "refresher=uas makes us the refresher",
			policy:        enabled,
			request:       TimerRequest{Supported: true, SessionExpires: seconds(600), RefresherParam: "uas"},
			wantInterval:  seconds(600),
			wantRefresher: RefresherLocal,
		},
		{
			name:          "with no preference and PreferLocalRefresh off the far end refreshes",
			policy:        TimerPolicy{Enabled: true, MinSE: seconds(90), DefaultSE: seconds(600), MaxSE: seconds(600)},
			request:       TimerRequest{Supported: true},
			wantInterval:  seconds(600),
			wantRefresher: RefresherRemote,
		},
		{
			name:    "timers off and a peer that merely supports them: no timer, no refusal",
			policy:  disabled,
			request: TimerRequest{Supported: true, SessionExpires: seconds(600)},
		},
		{
			name:       "timers off and a peer that REQUIRES them is 420",
			policy:     disabled,
			request:    TimerRequest{Required: true, SessionExpires: seconds(600)},
			wantRefuse: 420,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NegotiateUAS(tc.policy, tc.request)
			if got.RefuseStatus != tc.wantRefuse {
				t.Fatalf("refuse = %d, want %d", got.RefuseStatus, tc.wantRefuse)
			}
			if tc.wantRefuse != 0 {
				if got.MinSEHeader != tc.wantMinSE {
					t.Errorf("Min-SE = %s, want %s", got.MinSEHeader, tc.wantMinSE)
				}
				return
			}
			if got.Timer.Interval != tc.wantInterval {
				t.Errorf("interval = %s, want %s", got.Timer.Interval, tc.wantInterval)
			}
			if got.Timer.Refresher != tc.wantRefresher {
				t.Errorf("refresher = %s, want %s", got.Timer.Refresher, tc.wantRefresher)
			}
		})
	}
}

// A far end that answers with no Session-Expires has DECLINED. Keeping our timer would tear down a
// call the far end has every intention of continuing.
func TestAcceptUACResponse(t *testing.T) {
	policy := DefaultTimerPolicy()

	if timer := AcceptUACResponse(policy, TimerRequest{}); timer.Negotiated() {
		t.Error("a response with no Session-Expires must leave no timer")
	}
	timer := AcceptUACResponse(policy, TimerRequest{SessionExpires: seconds(900), RefresherParam: "uac"})
	if timer.Interval != seconds(900) || timer.Refresher != RefresherLocal {
		t.Errorf("timer = %s/%s, want 900s refreshed locally", timer.Interval, timer.Refresher)
	}
	if timer := AcceptUACResponse(TimerPolicy{}, TimerRequest{SessionExpires: seconds(900)}); timer.Negotiated() {
		t.Error("a disabled policy accepts no timer")
	}
}

// The Min-SE on a 422 is attacker-influenced on a trunk, so it is bounded by our own ceiling.
func TestRetryAfter422IsBounded(t *testing.T) {
	policy := DefaultTimerPolicy()
	cases := []struct {
		name  string
		minSE time.Duration
		want  time.Duration
		ok    bool
	}{
		{"a sane floor is accepted", seconds(120), seconds(120), true},
		{"exactly our ceiling is accepted", seconds(7200), seconds(7200), true},
		{"a day-long floor is refused rather than obeyed", seconds(86400), 0, false},
		{"a zero floor is refused", 0, 0, false},
		{"a negative floor is refused", -seconds(1), 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := RetryAfter422(policy, tc.minSE)
			if ok != tc.ok || got != tc.want {
				t.Errorf("RetryAfter422 = %s/%v, want %s/%v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

// The refresher refreshes at half the interval; the other side waits the whole interval before
// acting. Acting early tears down a call whose refresh is on the wire.
func TestRefreshAndExpiryDeadlines(t *testing.T) {
	local := SessionTimer{Interval: seconds(600), Refresher: RefresherLocal}
	if local.RefreshAfter() != seconds(300) {
		t.Errorf("refresh = %s, want half the interval", local.RefreshAfter())
	}
	if local.ExpiresAfter() != seconds(600) {
		t.Errorf("expiry = %s, want the whole interval", local.ExpiresAfter())
	}

	remote := SessionTimer{Interval: seconds(600), Refresher: RefresherRemote}
	if remote.RefreshAfter() != 0 {
		t.Errorf("a non-refresher owes no refresh, got %s", remote.RefreshAfter())
	}
	if remote.ExpiresAfter() != seconds(600) {
		t.Errorf("expiry = %s, want the whole interval", remote.ExpiresAfter())
	}

	none := SessionTimer{}
	if none.Negotiated() || none.RefreshAfter() != 0 || none.ExpiresAfter() != 0 {
		t.Error("an un-negotiated timer must have no deadlines at all")
	}
}

// The `refresher` token names the ROLE, so it flips with the role rather than with the direction.
func TestRefresherWireToken(t *testing.T) {
	cases := []struct {
		refresher Refresher
		role      Role
		want      string
	}{
		{RefresherLocal, RoleUAS, "uas"},
		{RefresherLocal, RoleUAC, "uac"},
		{RefresherRemote, RoleUAS, "uac"},
		{RefresherRemote, RoleUAC, "uas"},
		{RefresherNone, RoleUAS, ""},
	}
	for _, tc := range cases {
		t.Run(tc.refresher.String()+"/"+tc.role.String(), func(t *testing.T) {
			if got := tc.refresher.WireToken(tc.role); got != tc.want {
				t.Errorf("WireToken = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSessionExpiresHeader(t *testing.T) {
	timer := SessionTimer{Interval: seconds(1800), Refresher: RefresherLocal}
	if got := SessionExpiresHeader(timer, RoleUAS); got != "1800;refresher=uas" {
		t.Errorf("header = %q", got)
	}
	if got := SessionExpiresHeader(SessionTimer{Interval: seconds(90)}, RoleUAS); got != "90" {
		t.Errorf("header with no refresher = %q, want a bare interval", got)
	}
}

// Header reading has to survive the two spellings phones actually send: the compact `x` form and
// option tags split across several Supported headers.
func TestReadTimerHeaders(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string][]string
		want    TimerRequest
	}{
		{
			name: "the ordinary spelling",
			headers: map[string][]string{
				"Session-Expires": {"1800;refresher=uas"},
				"Min-SE":          {"120"},
				"Supported":       {"timer, replaces"},
			},
			want: TimerRequest{
				SessionExpires: seconds(1800), RefresherParam: "uas",
				MinSE: seconds(120), Supported: true,
			},
		},
		{
			name: "the compact form several handsets use",
			headers: map[string][]string{
				"x":         {"600;refresher=uac"},
				"Supported": {"timer"},
			},
			want: TimerRequest{SessionExpires: seconds(600), RefresherParam: "uac", Supported: true},
		},
		{
			name: "option tags split across two headers",
			headers: map[string][]string{
				"Session-Expires": {"900"},
				"Supported":       {"replaces"},
				"Require":         {"timer"},
			},
			want: TimerRequest{SessionExpires: seconds(900), Required: true},
		},
		{
			name:    "nothing at all",
			headers: map[string][]string{},
			want:    TimerRequest{},
		},
		{
			name:    "a non-numeric interval is treated as absent",
			headers: map[string][]string{"Session-Expires": {"soon"}},
			want:    TimerRequest{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ReadTimerHeaders(func(name string) []sip.Header {
				values := tc.headers[name]
				headers := make([]sip.Header, 0, len(values))
				for _, value := range values {
					headers = append(headers, sip.NewHeader(name, value))
				}
				return headers
			})
			if got != tc.want {
				t.Errorf("ReadTimerHeaders = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// A negotiated timer arms on the ACK, and the terminal path always stops it.
func TestSessionTimerArmsOnTheAckAndStopsOnTeardown(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	d.SetTimer(SessionTimer{Interval: seconds(600), MinSE: seconds(90), Refresher: RefresherLocal})

	apply(t, d, Input{Trigger: TriggerLocalAnswer})
	ack := apply(t, d, Input{Trigger: TriggerRemoteAck})
	assertKinds(t, ack, EffectPublish, EffectStartSessionTimer)

	bye := apply(t, d, Input{Trigger: TriggerRemoteBye})
	if !bye.Has(EffectStopSessionTimer) {
		t.Errorf("teardown effects = %v, want the session timer stopped", kindsOf(bye))
	}
}

// RFC 4028 §10: an expiry sends a BYE with the timer named as the cause, so the far end's CDR
// agrees with ours about why the call ended.
func TestSessionExpiryTearsTheCallDownWithATimerCause(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	d.SetTimer(SessionTimer{Interval: seconds(600), Refresher: RefresherRemote})
	apply(t, d, Input{Trigger: TriggerLocalAnswer})
	apply(t, d, Input{Trigger: TriggerRemoteAck})

	outcome := apply(t, d, Input{Trigger: TriggerTimeout, Timeout: TimeoutSession})
	if !outcome.Has(EffectSendBye) {
		t.Fatalf("effects = %v, want a BYE", kindsOf(outcome))
	}
	if d.Cause() != CauseRecoveryOnTimerExpire {
		t.Errorf("cause = %d, want 102", d.Cause())
	}
	if d.Termination() != ReasonTimeout {
		t.Errorf("termination = %s, want timeout", d.Termination())
	}
}
