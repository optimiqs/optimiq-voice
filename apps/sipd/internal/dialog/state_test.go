package dialog

import (
	"errors"
	"testing"
)

// The transition table, exhaustively, in the shape the rest of this service's tests use: one table,
// one name per row saying what the row PROVES rather than what it does.
func TestTransition(t *testing.T) {
	cases := []struct {
		name    string
		role    Role
		state   State
		trigger Trigger
		want    State
		wantErr error
	}{
		// -- UAS forward progress ---------------------------------------------------------------
		{"a 100 moves an untouched UAS dialog to proceeding", RoleUAS, StateInit, TriggerLocalTrying, StateProceeding, nil},
		{"a second 100 is absorbed rather than refused", RoleUAS, StateProceeding, TriggerLocalTrying, StateProceeding, nil},
		{"a 180 creates the early dialog", RoleUAS, StateProceeding, TriggerLocalRing, StateEarly, nil},
		{"a 180 with no 100 before it still creates the early dialog", RoleUAS, StateInit, TriggerLocalRing, StateEarly, nil},
		{"a second 180 is idempotent", RoleUAS, StateEarly, TriggerLocalRing, StateEarly, nil},
		{"a 183 with an answer is an early dialog too", RoleUAS, StateInit, TriggerLocalEarlyMedia, StateEarly, nil},
		{"a 200 establishes", RoleUAS, StateEarly, TriggerLocalAnswer, StateEstablished, nil},
		{"a 200 straight from init establishes", RoleUAS, StateInit, TriggerLocalAnswer, StateEstablished, nil},
		{"the ACK confirms", RoleUAS, StateEstablished, TriggerRemoteAck, StateConfirmed, nil},
		{"a retransmitted ACK is absorbed", RoleUAS, StateConfirmed, TriggerRemoteAck, StateConfirmed, nil},

		// -- the answer-twice defect ------------------------------------------------------------
		{"answering an established dialog again is refused", RoleUAS, StateEstablished, TriggerLocalAnswer, StateEstablished, ErrInvalidState},
		{"answering a confirmed dialog again is refused", RoleUAS, StateConfirmed, TriggerLocalAnswer, StateConfirmed, ErrInvalidState},
		{"ringing after the 200 is refused", RoleUAS, StateEstablished, TriggerLocalRing, StateEstablished, ErrInvalidState},

		// -- CANCEL, and the race that matters (RFC 3261 §9.2) -----------------------------------
		{"a CANCEL before any response ends the dialog", RoleUAS, StateInit, TriggerRemoteCancel, StateTerminated, nil},
		{"a CANCEL while ringing ends the dialog", RoleUAS, StateEarly, TriggerRemoteCancel, StateTerminated, nil},
		{"a CANCEL after the 200 has no effect and the dialog survives", RoleUAS, StateEstablished, TriggerRemoteCancel, StateEstablished, ErrCancelTooLate},
		{"a CANCEL after the ACK has no effect either", RoleUAS, StateConfirmed, TriggerRemoteCancel, StateConfirmed, ErrCancelTooLate},
		{"a CANCEL during teardown is moot", RoleUAS, StateTerminating, TriggerRemoteCancel, StateTerminating, ErrCancelTooLate},

		// -- BYE, including before the ACK (RFC 5407 §3.1.2) --------------------------------------
		{"a BYE before the ACK is honoured", RoleUAS, StateEstablished, TriggerRemoteBye, StateTerminated, nil},
		{"a BYE on a confirmed dialog ends it", RoleUAS, StateConfirmed, TriggerRemoteBye, StateTerminated, nil},
		{"a BYE crossing our own BYE ends it once", RoleUAS, StateTerminating, TriggerRemoteBye, StateTerminated, nil},
		{"a BYE before any 2xx is refused: there is no dialog to end", RoleUAS, StateEarly, TriggerRemoteBye, StateEarly, ErrInvalidState},
		{"a BYE on an untouched dialog is refused", RoleUAS, StateInit, TriggerRemoteBye, StateInit, ErrInvalidState},

		// -- hangup, per role and state ------------------------------------------------------------
		{"a UAS hangup before answering ends it outright", RoleUAS, StateEarly, TriggerLocalHangup, StateTerminated, nil},
		{"a UAS hangup after the 200 waits for the ACK", RoleUAS, StateEstablished, TriggerLocalHangup, StateTerminating, nil},
		{"a UAS hangup on a confirmed dialog starts teardown", RoleUAS, StateConfirmed, TriggerLocalHangup, StateTerminating, nil},
		{"a second hangup is idempotent", RoleUAS, StateTerminating, TriggerLocalHangup, StateTerminating, nil},
		{"a UAC hangup before any response waits for the provisional", RoleUAC, StateInit, TriggerLocalHangup, StateTerminating, nil},
		{"a UAC hangup while ringing cancels", RoleUAC, StateEarly, TriggerLocalHangup, StateTerminating, nil},

		// -- UAC forward progress -----------------------------------------------------------------
		{"a 100 moves a UAC dialog to proceeding", RoleUAC, StateInit, TriggerRemoteProvisional, StateProceeding, nil},
		{"a second 100 is absorbed", RoleUAC, StateProceeding, TriggerRemoteProvisional, StateProceeding, nil},
		{"an 18x with a tag creates the early dialog", RoleUAC, StateProceeding, TriggerRemoteEarly, StateEarly, nil},
		{"a 2xx establishes", RoleUAC, StateEarly, TriggerRemoteAnswer, StateEstablished, nil},
		{"our ACK confirms", RoleUAC, StateEstablished, TriggerLocalAck, StateConfirmed, nil},
		{"a second 2xx on an established dialog does not move it", RoleUAC, StateEstablished, TriggerRemoteAnswer, StateEstablished, nil},
		{"a second 2xx on a confirmed dialog does not move it", RoleUAC, StateConfirmed, TriggerRemoteAnswer, StateConfirmed, nil},
		{"a final failure ends it", RoleUAC, StateEarly, TriggerRemoteFailure, StateTerminated, nil},
		{"a failure after a 2xx is refused", RoleUAC, StateEstablished, TriggerRemoteFailure, StateEstablished, ErrInvalidState},

		// -- teardown completion -------------------------------------------------------------------
		{"the BYE's 200 terminates", RoleUAS, StateTerminating, TriggerTeardownComplete, StateTerminated, nil},
		{"a teardown completion outside teardown is refused", RoleUAS, StateConfirmed, TriggerTeardownComplete, StateConfirmed, ErrInvalidState},

		// -- timeouts end everything ----------------------------------------------------------------
		{"a timeout on an early UAC dialog ends it", RoleUAC, StateEarly, TriggerTimeout, StateTerminated, nil},
		{"a timeout on a confirmed dialog ends it", RoleUAS, StateConfirmed, TriggerTimeout, StateTerminated, nil},

		// -- terminal is terminal --------------------------------------------------------------------
		{"a command against an ended dialog is dialog_gone", RoleUAS, StateTerminated, TriggerLocalAnswer, StateTerminated, ErrDialogGone},
		{"a BYE against an ended dialog is dialog_gone", RoleUAS, StateTerminated, TriggerRemoteBye, StateTerminated, ErrDialogGone},
		{"a hangup against an ended dialog is dialog_gone", RoleUAS, StateTerminated, TriggerLocalHangup, StateTerminated, ErrDialogGone},

		// -- role separation ---------------------------------------------------------------------------
		{"a UAC cannot be told to ring", RoleUAC, StateInit, TriggerLocalRing, StateInit, ErrWrongRole},
		{"a UAC cannot be told to answer", RoleUAC, StateInit, TriggerLocalAnswer, StateInit, ErrWrongRole},
		{"a UAC does not receive a CANCEL for its own INVITE", RoleUAC, StateEarly, TriggerRemoteCancel, StateEarly, ErrWrongRole},
		{"a UAS does not receive a 2xx to an INVITE it never sent", RoleUAS, StateEarly, TriggerRemoteAnswer, StateEarly, ErrWrongRole},
		{"a UAS does not send an ACK for its own 2xx", RoleUAS, StateEstablished, TriggerLocalAck, StateEstablished, ErrWrongRole},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := transition(tc.role, tc.state, tc.trigger)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("state = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestStatePredicates(t *testing.T) {
	cases := []struct {
		state    State
		alive    bool
		answered bool
	}{
		{StateInit, true, false},
		{StateProceeding, true, false},
		{StateEarly, true, false},
		{StateEstablished, true, true},
		{StateConfirmed, true, true},
		{StateTerminating, true, false},
		{StateTerminated, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.state.String(), func(t *testing.T) {
			if got := tc.state.Alive(); got != tc.alive {
				t.Errorf("Alive() = %v, want %v", got, tc.alive)
			}
			if got := tc.state.Answered(); got != tc.answered {
				t.Errorf("Answered() = %v, want %v", got, tc.answered)
			}
		})
	}
}

// Every state and every trigger must render as something other than "unknown", because both
// spellings end up in a log line and in the `sip-dialogs` claim, and a claim carrying "unknown"
// would make a reaper's decision unreadable.
func TestVocabularyRenders(t *testing.T) {
	for state := StateInit; state <= StateTerminated; state++ {
		if state.String() == "unknown" {
			t.Errorf("state %d has no name", int(state))
		}
	}
	for trigger := TriggerLocalTrying; trigger <= TriggerTimeout; trigger++ {
		if trigger.String() == "unknown" {
			t.Errorf("trigger %d has no name", int(trigger))
		}
	}
	for kind := EffectRespond; kind <= EffectSendSessionRefresh; kind++ {
		if kind.String() == "unknown" {
			t.Errorf("effect kind %d has no name", int(kind))
		}
	}
	for kind := TimeoutInvite; kind <= TimeoutRing; kind++ {
		if kind.String() == "unknown" {
			t.Errorf("timeout kind %d has no name", int(kind))
		}
	}
	if RoleUAS.String() != "uas" || RoleUAC.String() != "uac" {
		t.Error("the role tokens must match the claim record's vocabulary")
	}
}
