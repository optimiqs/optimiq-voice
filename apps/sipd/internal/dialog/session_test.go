package dialog

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// Whichever of the two wins, the other must be refused by name — the answer with ErrCancelTooLate,
// the CANCEL with ErrDialogGone. Both succeeding is a call that was answered and cancelled.
func TestCancelAndAnswerRaceHasExactlyOneWinner(t *testing.T) {
	for attempt := range 200 {
		d := newTestDialog(t, RoleUAS)
		session := NewSession(d, SessionOptions{Handler: &RecordingHandler{}})

		var wait sync.WaitGroup
		var answerErr, cancelErr error
		wait.Go(func() {
			_, answerErr = session.Apply(t.Context(),
				Input{Trigger: TriggerLocalAnswer, Body: []byte("v=0\r\n")})
		})
		wait.Go(func() {
			_, cancelErr = session.Apply(t.Context(), Input{Trigger: TriggerRemoteCancel})
		})
		wait.Wait()
		session.Close()

		switch {
		case answerErr == nil && cancelErr == nil:
			t.Fatalf("attempt %d: the answer and the CANCEL both succeeded", attempt)
		case answerErr == nil:
			if !errors.Is(cancelErr, ErrCancelTooLate) {
				t.Fatalf("attempt %d: the answer won but the CANCEL was refused %v, want ErrCancelTooLate",
					attempt, cancelErr)
			}
		case cancelErr == nil:
			if !errors.Is(answerErr, ErrDialogGone) {
				t.Fatalf("attempt %d: the CANCEL won but the answer was refused %v, want ErrDialogGone",
					attempt, answerErr)
			}
		default:
			t.Fatalf("attempt %d: neither succeeded (answer=%v cancel=%v)", attempt, answerErr, cancelErr)
		}
	}
}

// Effects run on the owning goroutine, in order, BEFORE the caller is answered: the ordering that
// puts the 200 on the socket before `answer` replies.
func TestEffectsRunInOrderBeforeTheCallerIsAnswered(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	handler := &RecordingHandler{}
	session := NewSession(d, SessionOptions{Handler: handler})
	defer session.Close()

	if _, err := session.Apply(t.Context(), Input{Trigger: TriggerLocalAnswer}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// The caller has been answered, so every effect for that command has already run.
	kinds := handler.Kinds()
	if len(kinds) != 1 || kinds[0] != EffectRespond {
		t.Fatalf("effects = %v, want a single respond", kinds)
	}

	if _, err := session.Apply(t.Context(), Input{Trigger: TriggerRemoteBye}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	kinds = handler.Kinds()
	want := []EffectKind{EffectRespond, EffectRespondToRequest, EffectStopRetransmit, EffectPublish, EffectReleaseClaim}
	if len(kinds) != len(want) {
		t.Fatalf("effects = %v, want %v", kinds, want)
	}
	for index := range want {
		if kinds[index] != want[index] {
			t.Fatalf("effects = %v, want %v", kinds, want)
		}
	}
}

// A failing effect must not stop the ones behind it, or a teardown skips the terminal publish and
// the call gets no CDR.
func TestAFailingEffectDoesNotStopTheRest(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	handler := &RecordingHandler{Err: errors.New("the socket is gone")}
	session := NewSession(d, SessionOptions{Handler: handler})
	defer session.Close()

	apply := func(in Input) {
		if _, err := session.Apply(t.Context(), in); err != nil {
			t.Fatalf("Apply(%s): %v", in.Trigger, err)
		}
	}
	apply(Input{Trigger: TriggerLocalAnswer})
	apply(Input{Trigger: TriggerRemoteBye})

	saw := false
	for _, effect := range handler.Effects() {
		if effect.Kind == EffectPublish && effect.Event == EventTerminated {
			saw = true
		}
	}
	if !saw {
		t.Fatalf("effects = %v, want the terminal publish to have been attempted", handler.Kinds())
	}
}

// The refusal that a still-in-flight CANCEL must produce — the 481 — is an effect on the ERROR
// path, and dropping it would leave the far end retransmitting a CANCEL at a live call.
func TestEffectsRunEvenWhenTheTaskRefuses(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	handler := &RecordingHandler{}
	session := NewSession(d, SessionOptions{Handler: handler})
	defer session.Close()

	if _, err := session.Apply(t.Context(), Input{Trigger: TriggerLocalAnswer}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	handler.Reset()

	_, err := session.Apply(t.Context(), Input{Trigger: TriggerRemoteCancel})
	if !errors.Is(err, ErrCancelTooLate) {
		t.Fatalf("err = %v, want ErrCancelTooLate", err)
	}
	kinds := handler.Kinds()
	if len(kinds) != 1 || kinds[0] != EffectRespondToCancel {
		t.Fatalf("effects = %v, want the 481 to have gone out", kinds)
	}
}

// A closed session refuses commands by name rather than hanging, and Close is idempotent.
func TestClosedSessionRefusesAndCloseIsIdempotent(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	session := NewSession(d, SessionOptions{})
	session.Close()
	session.Close()

	if _, err := session.Apply(context.Background(), Input{Trigger: TriggerLocalRing}); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("err = %v, want ErrSessionClosed", err)
	}
	if session.LegID() != d.LegID {
		t.Error("LegID must be readable without a round trip through the mailbox")
	}
}

// A caller whose context expires learns its command got no answer in time, which is why commands
// are idempotent on legId.
func TestApplyRespectsTheCallersDeadline(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	release := make(chan struct{})
	session := NewSession(d, SessionOptions{
		Handler: EffectHandlerFunc(func(context.Context, *Dialog, Effect) error {
			<-release
			return nil
		}),
	})
	defer func() {
		close(release)
		session.Close()
	}()

	// Occupy the goroutine with a command whose effect blocks.
	go func() { _, _ = session.Apply(context.Background(), Input{Trigger: TriggerLocalRing}) }()
	time.Sleep(10 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := session.Apply(ctx, Input{Trigger: TriggerLocalAnswer}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want a deadline", err)
	}
}

// Inspect reads a dialog on its owner's goroutine, which is the only race-free way to read one.
func TestInspectReadsOnTheOwningGoroutine(t *testing.T) {
	d := newTestDialog(t, RoleUAS)
	session := NewSession(d, SessionOptions{})
	defer session.Close()

	var wait sync.WaitGroup
	for range 8 {
		wait.Go(func() {
			var state State
			if err := session.Inspect(t.Context(), func(d *Dialog) { state = d.State() }); err != nil {
				t.Errorf("Inspect: %v", err)
			}
			_ = state
		})
	}
	wait.Go(func() {
		_, _ = session.Apply(t.Context(), Input{Trigger: TriggerLocalRing})
	})
	wait.Wait()
}
