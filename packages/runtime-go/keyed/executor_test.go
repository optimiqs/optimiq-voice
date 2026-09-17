package keyed_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/keyed"
)

func newExecutor(t *testing.T, opts keyed.Options) *keyed.Executor {
	t.Helper()
	exec, err := keyed.New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { exec.Shutdown(context.Background()) })
	return exec
}

func TestNewRejectsUnboundedOptions(t *testing.T) {
	for name, opts := range map[string]keyed.Options{
		"no concurrency": {MaxPending: 1, MaxPendingPerKey: 1},
		"no queue":       {MaxConcurrent: 1, MaxPendingPerKey: 1},
		"no per-key":     {MaxConcurrent: 1, MaxPending: 1},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := keyed.New(opts); err == nil {
				t.Fatal("expected a refusal")
			}
		})
	}
}

func TestTasksSharingAKeyRunInOrder(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 8, MaxPending: 64, MaxPendingPerKey: 64})

	var mu sync.Mutex
	var order []int
	done := make(chan struct{})
	release := make(chan struct{})

	if err := exec.SubmitKey("a", func(context.Context) {
		<-release
		mu.Lock()
		order = append(order, 1)
		mu.Unlock()
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	for i := 2; i <= 4; i++ {
		n := i
		if err := exec.SubmitKey("a", func(context.Context) {
			mu.Lock()
			order = append(order, n)
			last := len(order) == 4
			mu.Unlock()
			if last {
				close(done)
			}
		}); err != nil {
			t.Fatalf("submit: %v", err)
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("tasks did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	for i, got := range order {
		if got != i+1 {
			t.Fatalf("tasks under one key ran out of order: %v", order)
		}
	}
}

func TestDifferentKeysRunConcurrently(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 2, MaxPending: 8, MaxPendingPerKey: 8})
	both := make(chan struct{}, 2)
	release := make(chan struct{})
	for _, key := range []string{"a", "b"} {
		if err := exec.SubmitKey(key, func(context.Context) {
			both <- struct{}{}
			<-release
		}); err != nil {
			t.Fatalf("submit: %v", err)
		}
	}
	defer close(release)
	for range 2 {
		select {
		case <-both:
		case <-time.After(2 * time.Second):
			t.Fatal("keys did not run concurrently")
		}
	}
}

func TestAdmissionFailsAtTheTotalLimit(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 1, MaxPending: 2, MaxPendingPerKey: 2})
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	if err := exec.SubmitKey("busy", func(context.Context) {
		close(started)
		<-release
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started

	if err := exec.SubmitKey("a", func(context.Context) {}); err != nil {
		t.Fatalf("first queued task: %v", err)
	}
	if err := exec.SubmitKey("b", func(context.Context) {}); err != nil {
		t.Fatalf("second queued task: %v", err)
	}
	if err := exec.SubmitKey("c", func(context.Context) {}); !errors.Is(err, keyed.ErrOverloaded) {
		t.Fatalf("expected ErrOverloaded past the pending limit, got %v", err)
	}
}

func TestAdmissionFailsAtThePerKeyLimit(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 4, MaxPending: 64, MaxPendingPerKey: 1})
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	if err := exec.SubmitKey("a", func(context.Context) {
		close(started)
		<-release
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started
	if err := exec.SubmitKey("a", func(context.Context) {}); err != nil {
		t.Fatalf("the one allowed queued task: %v", err)
	}
	if err := exec.SubmitKey("a", func(context.Context) {}); !errors.Is(err, keyed.ErrOverloaded) {
		t.Fatalf("expected ErrOverloaded past the per-key limit, got %v", err)
	}
	// Another key is unaffected: one busy leg must not deny the rest of the switch.
	if err := exec.SubmitKey("b", func(context.Context) {}); err != nil {
		t.Fatalf("a different key was refused: %v", err)
	}
}

func TestQueuedTaskSeesAnExpiredDeadline(t *testing.T) {
	exec := newExecutor(t, keyed.Options{
		MaxConcurrent:    1,
		MaxPending:       4,
		MaxPendingPerKey: 4,
		EnqueueTimeout:   20 * time.Millisecond,
	})
	release := make(chan struct{})
	started := make(chan struct{})
	if err := exec.SubmitKey("a", func(context.Context) {
		close(started)
		<-release
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started

	expired := make(chan error, 1)
	if err := exec.SubmitKey("b", func(ctx context.Context) { expired <- ctx.Err() }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)

	select {
	case err := <-expired:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("a task that waited past its deadline ran with %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the queued task never ran")
	}
}

func TestCloseRefusesAdmissionAndDrainsQueuedWork(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 1, MaxPending: 8, MaxPendingPerKey: 8})
	var ran atomic.Int64
	release := make(chan struct{})
	started := make(chan struct{})
	if err := exec.SubmitKey("a", func(context.Context) {
		close(started)
		<-release
		ran.Add(1)
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started
	if err := exec.SubmitKey("a", func(context.Context) { ran.Add(1) }); err != nil {
		t.Fatalf("submit: %v", err)
	}

	exec.Close()
	if err := exec.SubmitKey("a", func(context.Context) { ran.Add(1) }); !errors.Is(err, keyed.ErrClosed) {
		t.Fatalf("expected ErrClosed after Close, got %v", err)
	}
	close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !exec.Wait(ctx) {
		t.Fatal("the executor did not drain")
	}
	if got := ran.Load(); got != 2 {
		t.Fatalf("drain ran %d of the 2 admitted tasks", got)
	}
}

func TestShutdownCancelsRunningTasks(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 1, MaxPending: 4, MaxPendingPerKey: 4})
	cancelled := make(chan struct{})
	started := make(chan struct{})
	if err := exec.SubmitKey("a", func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(cancelled)
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if exec.Shutdown(ctx) {
		t.Fatal("Shutdown reported a clean drain while a task was still blocked")
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not cancel the running task")
	}
}

// A command touching sessions {a,b} and one touching {b,c} overlap in one leg, so they must not run
// at once even though neither set contains the other. Disjoint sets still run concurrently.
func TestIntersectingKeySetsSerialiseAndDisjointOnesDoNot(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 8, MaxPending: 32, MaxPendingPerKey: 32})
	firstStarted := make(chan struct{})
	release := make(chan struct{})
	overlapping := make(chan struct{})
	if err := exec.Submit([]string{"a", "b"}, func(context.Context) {
		close(firstStarted)
		<-release
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-firstStarted
	if err := exec.Submit([]string{"b", "c"}, func(context.Context) { close(overlapping) }); err != nil {
		t.Fatalf("submit: %v", err)
	}

	disjoint := make(chan struct{})
	if err := exec.Submit([]string{"d"}, func(context.Context) { close(disjoint) }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case <-disjoint:
	case <-time.After(2 * time.Second):
		t.Fatal("a task over a disjoint key set was blocked behind an unrelated one")
	}

	select {
	case <-overlapping:
		t.Fatal("{b,c} ran while {a,b} was still executing")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-overlapping:
	case <-time.After(2 * time.Second):
		t.Fatal("{b,c} never ran after {a,b} finished")
	}
}

// A member of a set is enough to serialise: release(a) must wait for bridge(a,b).
func TestASingleKeyWaitsForTheSetThatContainsIt(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 4, MaxPending: 16, MaxPendingPerKey: 16})
	started := make(chan struct{})
	release := make(chan struct{})
	ran := make(chan struct{})
	if err := exec.Submit([]string{"a", "b"}, func(context.Context) {
		close(started)
		<-release
	}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	<-started
	if err := exec.SubmitKey("a", func(context.Context) { close(ran) }); err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case <-ran:
		t.Fatal("release(a) ran while bridge(a,b) was still executing")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("release(a) never ran")
	}
}

func TestBurstOfUniqueKeysStaysBounded(t *testing.T) {
	exec := newExecutor(t, keyed.Options{MaxConcurrent: 2, MaxPending: 16, MaxPendingPerKey: 4})
	release := make(chan struct{})
	defer close(release)
	var admitted, refused int
	for i := range 1000 {
		key := string(rune('a'+i%26)) + string(rune('a'+i/26%26)) + string(rune('0'+i/676))
		if err := exec.SubmitKey(key, func(context.Context) { <-release }); err != nil {
			refused++
			continue
		}
		admitted++
	}
	if refused == 0 {
		t.Fatal("a burst of 1000 unique keys was admitted without limit")
	}
	if pending := exec.Pending(); pending > 16 {
		t.Fatalf("pending queue grew past MaxPending: %d", pending)
	}
}
