package dialog

import "testing"

// RFC 3398 §7.2.4.1, plus the class fallbacks the RFC leaves to the gateway.
func TestCauseForStatus(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   int
	}{
		{"404 is an unallocated number", 404, CauseUnallocatedNumber},
		{"486 is user busy", 486, CauseUserBusy},
		{"480 is subscriber absent", 480, CauseSubscriberAbsent},
		{"487 is normal clearing: the caller gave up", 487, CauseNormalClearing},
		{"403 is call rejected", 403, CauseCallRejected},
		{"503 is a temporary failure", 503, CauseTemporaryFailure},
		{"488 is an incompatible destination", 488, CauseIncompatibleDestination},
		{"408 is no user responding", 408, CauseNoUserResponse},
		{"415 is a bearer capability we cannot meet", 415, CauseBearerCapabilityNotAvail},
		{"600 busy everywhere is still user busy", 600, CauseUserBusy},
		{"603 decline is a rejection", 603, CauseCallRejected},
		{"a 200 on a teardown path is normal clearing", 200, CauseNormalClearing},
		{"an unlisted 4xx falls back by class", 499, CauseInterworking},
		{"an unlisted 5xx falls back to a temporary failure", 599, CauseTemporaryFailure},
		{"an unlisted 6xx falls back to a rejection", 699, CauseCallRejected},
		{"a redirect we did not follow is no route", 302, CauseNoRouteDestination},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CauseForStatus(tc.status); got != tc.want {
				t.Errorf("CauseForStatus(%d) = %d, want %d", tc.status, got, tc.want)
			}
		})
	}
}

// RFC 3326: the far end's own switch telling us what it decided beats re-deriving it from a status
// line. Every rejection below is a value that would put an unbillable cause on a CDR.
func TestCauseFromReason(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  int
		found bool
	}{
		{"a plain Q.850 cause", "Q.850;cause=17", 17, true},
		{"case-insensitive protocol", "q.850;cause=34", 34, true},
		{"a quoted value", `Q.850;cause="41"`, 41, true},
		{"extra parameters are ignored", `Q.850;cause=16;text="Normal"`, 16, true},
		{"whitespace is tolerated", " Q.850 ; cause = 21 ", 21, true},
		{"several reasons, one of them Q.850", "SIP;cause=480, Q.850;cause=20", 20, true},
		{"a SIP reason is not re-derived here", "SIP;cause=486;text=\"Busy\"", 0, false},
		{"an unknown protocol is not guessed at", "MYPROTO;cause=7", 0, false},
		{"a cause above the Q.850 range is treated as absent", "Q.850;cause=200", 0, false},
		{"a negative cause is treated as absent", "Q.850;cause=-1", 0, false},
		{"a non-numeric cause is treated as absent", "Q.850;cause=busy", 0, false},
		{"no cause parameter at all", "Q.850;text=\"nope\"", 0, false},
		{"an empty header", "", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, found := CauseFromReason(tc.value)
			if found != tc.found {
				t.Fatalf("found = %v, want %v", found, tc.found)
			}
			if found && got != tc.want {
				t.Errorf("cause = %d, want %d", got, tc.want)
			}
		})
	}
}

// The reverse direction: `rpc.sip.v1.hangup` hands this edge a cause for an unanswered leg, and an
// unanswered leg ends with a status rather than a BYE.
func TestStatusForCause(t *testing.T) {
	cases := []struct {
		cause  int
		status int
	}{
		{CauseUnallocatedNumber, 404},
		{CauseNormalClearing, 487},
		{CauseUserBusy, 486},
		{CauseNoAnswer, 480},
		{CauseSubscriberAbsent, 480},
		{CauseCallRejected, 403},
		{CauseDestinationOutOfOrder, 502},
		{CauseInvalidNumberFormat, 484},
		{CauseTemporaryFailure, 503},
		{CauseSwitchCongestion, 503},
		{CauseIncompatibleDestination, 488},
		{CauseRecoveryOnTimerExpire, 408},
		// Anything without a defensible status becomes 480 — an answer the caller can act on —
		// rather than 500, which would blame us for a decision somebody else made.
		{99, 480},
		{0, 480},
	}
	for _, tc := range cases {
		t.Run(StatusForCauseName(tc.cause), func(t *testing.T) {
			if got, _ := StatusForCause(tc.cause); got != tc.status {
				t.Errorf("StatusForCause(%d) = %d, want %d", tc.cause, got, tc.status)
			}
		})
	}
}

func TestReasonHeaderRoundTrips(t *testing.T) {
	for _, cause := range []int{1, 16, 17, 21, 34, 102, 127} {
		value := ReasonHeader(cause)
		got, found := CauseFromReason(value)
		if !found || got != cause {
			t.Errorf("ReasonHeader(%d) = %q, which parses back as %d/%v", cause, value, got, found)
		}
	}
}
