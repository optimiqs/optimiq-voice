package events_test

import (
	"testing"

	events "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// The generated Q.850 table is a COPY, so these tests guard the two things a generator cannot:
// that the copy is internally coherent, and that the handful of codes the rest of the platform
// hard-depends on are the numbers everyone thinks they are.
//
// Cross-language equality with packages/telephony is guarded elsewhere and differently — by
// `codegen:check`, which regenerates and fails on any diff. Re-asserting it here would be asserting
// that a pure function is pure.

// Pinned spot values.
//
// Every one of these is load-bearing somewhere outside this package: 16 and 17 decide a CDR
// disposition, 19 versus 18 is "it rang" versus "nothing answered", 41 is what a reaped dialog
// carries when its owning sipd died (design §6.2), and 487 is the first FreeSWITCH extension —
// the boundary where the Q.850 range stops and a re-code would be silent.
func TestHangupCauseCodesArePinned(t *testing.T) {
	t.Parallel()

	for cause, want := range map[events.HangupCause]int{
		events.HangupCauseNone:                     0,
		events.HangupCauseUnallocatedNumber:        1,
		events.HangupCauseNormalClearing:           16,
		events.HangupCauseUserBusy:                 17,
		events.HangupCauseNoUserResponse:           18,
		events.HangupCauseNoAnswer:                 19,
		events.HangupCauseNormalUnspecified:        31,
		events.HangupCauseNormalTemporaryFailure:   41,
		events.HangupCauseBearercapabilityNotavail: 58,
		events.HangupCauseIncompatibleDestination:  88,
		events.HangupCauseRecoveryOnTimerExpire:    102,
		events.HangupCauseInterworking:             127,
		events.HangupCauseOriginatorCancel:         487,
		events.HangupCauseLoseRace:                 702,
		events.HangupCauseUserNotRegistered:        806,
		events.HangupCauseSrtpReadError:            813,
	} {
		if got, found := events.HangupCauseCodeOf(cause); !found || got != want {
			t.Errorf("HangupCauseCodeOf(%q) = %d, %t; want %d, true", cause, got, found, want)
		}
	}
}

// Every named cause has a code, and every code maps back to the name it came from.
//
// The reverse map is built by iterating the forward one, so a DUPLICATE code would silently make
// one name unreachable rather than failing to compile — which is exactly the mistake a hand-edited
// table makes and a generated one inherits from its source.
func TestHangupCauseTableIsBijective(t *testing.T) {
	t.Parallel()

	if len(events.HangupCauses) != len(events.HangupCauseCodes) {
		t.Fatalf("HangupCauses has %d entries, HangupCauseCodes has %d",
			len(events.HangupCauses), len(events.HangupCauseCodes))
	}
	if len(events.HangupCauseNames) != len(events.HangupCauseCodes) {
		t.Fatalf("two causes share a code: %d names for %d causes",
			len(events.HangupCauseNames), len(events.HangupCauseCodes))
	}

	for _, cause := range events.HangupCauses {
		code, found := events.HangupCauseCodeOf(cause)
		if !found {
			t.Errorf("%q is listed in HangupCauses but has no code", cause)
			continue
		}
		back, found := events.HangupCauseFromCode(code)
		if !found || back != cause {
			t.Errorf("HangupCauseFromCode(%d) = %q, %t; want %q, true", code, back, found, cause)
		}
		if !events.IsHangupCause(string(cause)) {
			t.Errorf("IsHangupCause(%q) = false; want true", cause)
		}
	}
}

// Q.850 members stay inside 0-127 and the extensions stay outside it.
//
// The split is not cosmetic: a cause code above 127 cannot have come from a carrier, so anything
// reading a CDR row can tell "the far end said this" from "we decided this" by the number alone.
func TestHangupCauseRangesSplitAtQ850(t *testing.T) {
	t.Parallel()

	for _, cause := range events.Q850HangupCauses {
		code, _ := events.HangupCauseCodeOf(cause)
		if code < 0 || code > 127 {
			t.Errorf("Q.850 cause %q has code %d, outside 0-127", cause, code)
		}
	}
	for _, cause := range events.ExtendedHangupCauses {
		code, _ := events.HangupCauseCodeOf(cause)
		if code <= 127 {
			t.Errorf("extension %q has code %d, inside the Q.850 range", cause, code)
		}
	}
}

// An unknown name is absent rather than 0-with-no-signal, and an unnamed Q.850 point is absent
// rather than invented.
//
// Both directions matter to the CDR writer, which stores an unrecognised carrier cause as its raw
// code with NORMAL_UNSPECIFIED. A lookup that quietly answered NONE would turn "the carrier said
// something we do not name" into "no cause recorded", and those bill differently.
func TestHangupCauseLookupsReportAbsence(t *testing.T) {
	t.Parallel()

	if code, found := events.HangupCauseCodeOf("NOT_A_CAUSE"); found || code != 0 {
		t.Errorf("HangupCauseCodeOf(unknown) = %d, %t; want 0, false", code, found)
	}
	if events.IsHangupCause("NOT_A_CAUSE") {
		t.Error("IsHangupCause(unknown) = true; want false")
	}
	// 4 is a Q.850 point we deliberately do not name (design: only the ~65 a softswitch emits).
	if cause, found := events.HangupCauseFromCode(4); found {
		t.Errorf("HangupCauseFromCode(4) = %q, true; want absent", cause)
	}
}
