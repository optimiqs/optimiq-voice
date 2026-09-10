package dialog

import (
	"errors"
	"testing"
	"time"
)

// A refresher role this edge cannot perform is refused at boot rather than accepted and dropped at
// the first call: RFC 4028 §7.2's obligation is what the far end tears the call down for.
func TestTimerPolicyRefusesALocalRefresherItCannotPerform(t *testing.T) {
	policy := DefaultTimerPolicy()
	if err := policy.Validate(); err != nil {
		t.Fatalf("the default policy must be usable: %v", err)
	}
	if policy.PreferLocalRefresh {
		t.Error("the default policy must not volunteer this edge as the refresher")
	}

	policy.PreferLocalRefresh = true
	if err := policy.Validate(); !errors.Is(err, ErrNoLocalRefresher) {
		t.Errorf("Validate = %v, want ErrNoLocalRefresher", err)
	}

	// Off, the setting is inert: there is no timer to owe a refresh to.
	if err := (TimerPolicy{PreferLocalRefresh: true}).Validate(); err != nil {
		t.Errorf("Validate with timers off = %v, want nil", err)
	}
}

// No negotiated outcome may leave this edge owing a refresh, whichever role the peer named.
func TestNoNegotiationSelectsThisEdgeAsTheRefresher(t *testing.T) {
	policy := TimerPolicy{
		Enabled:            true,
		MinSE:              90 * time.Second,
		DefaultSE:          600 * time.Second,
		MaxSE:              600 * time.Second,
		PreferLocalRefresh: true,
	}
	for _, param := range []string{"", "uac", "uas"} {
		request := TimerRequest{Supported: true, SessionExpires: 600 * time.Second, RefresherParam: param}
		if got := NegotiateUAS(policy, request).Timer; got.Refresher == RefresherLocal {
			t.Errorf("NegotiateUAS with refresher=%q chose us; RefreshAfter would arm an unsendable refresh", param)
		}
		if got := AcceptUACResponse(policy, request); got.Refresher == RefresherLocal {
			t.Errorf("AcceptUACResponse with refresher=%q chose us", param)
		}
	}
}
