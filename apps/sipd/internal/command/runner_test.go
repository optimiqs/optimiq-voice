package command

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Requests naming different resources must not queue behind each other: that serialisation was the
// whole of the create-offer and resolve-target latency under a call storm.
func TestTheRunnerRunsDifferentKeysConcurrently(t *testing.T) {
	const keys = 32
	runner := newKeyedRunner(maxConcurrentCommands)
	release := make(chan struct{})
	var started sync.WaitGroup
	var done sync.WaitGroup
	started.Add(keys)
	done.Add(keys)
	for i := range keys {
		runner.Submit(string(rune('a'+i)), func() {
			started.Done()
			<-release
			done.Done()
		})
	}

	entered := make(chan struct{})
	go func() { started.Wait(); close(entered) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("tasks under distinct keys did not all start; they are still serialised")
	}
	close(release)
	done.Wait()
}

// A session's own commands stay in the order they arrived. Concurrency is across resources, not
// within one: two allocates for the same session must not race to bind its ports.
func TestTheRunnerKeepsOneKeyInOrder(t *testing.T) {
	runner := newKeyedRunner(maxConcurrentCommands)
	const tasks = 200
	var order []int
	var mu sync.Mutex
	var overlap atomic.Int32
	var inside atomic.Int32
	var wg sync.WaitGroup
	wg.Add(tasks)
	for i := range tasks {
		runner.Submit("one-session", func() {
			defer wg.Done()
			if inside.Add(1) != 1 {
				overlap.Add(1)
			}
			mu.Lock()
			order = append(order, i)
			mu.Unlock()
			inside.Add(-1)
		})
	}
	wg.Wait()
	if overlap.Load() != 0 {
		t.Fatalf("%d tasks under one key overlapped", overlap.Load())
	}
	for i, got := range order {
		if got != i {
			t.Fatalf("task %d ran at position %d: arrival order was not preserved", got, i)
		}
	}
}

// The slot count is a ceiling, not a drop policy: everything submitted must still run.
func TestTheRunnerBoundsConcurrencyWithoutLosingWork(t *testing.T) {
	const slots = 4
	runner := newKeyedRunner(slots)
	var peak, inside atomic.Int32
	var ran atomic.Int32
	var wg sync.WaitGroup
	wg.Add(64)
	for i := range 64 {
		runner.Submit(string(rune('a'+i)), func() {
			defer wg.Done()
			now := inside.Add(1)
			for {
				high := peak.Load()
				if now <= high || peak.CompareAndSwap(high, now) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			inside.Add(-1)
			ran.Add(1)
		})
	}
	wg.Wait()
	if got := ran.Load(); got != 64 {
		t.Fatalf("ran %d of 64 tasks", got)
	}
	if got := peak.Load(); got > slots {
		t.Fatalf("peak concurrency %d, past the %d-slot ceiling", got, slots)
	}
}

// Ordering is per leg, so the key must survive every command payload shape and a malformed one.
func TestTheOrderingKeyIsTheLeg(t *testing.T) {
	for _, row := range []struct{ name, payload, want string }{
		{"ring", `{"legId":"leg-1","status":180}`, "leg-1"},
		{"originate", `{"legId":"leg-2","orgId":"org","target":{"kind":"aor"}}`, "leg-2"},
		{"no leg", `{"orgId":"org"}`, ""},
		{"malformed", `not json`, ""},
	} {
		t.Run(row.name, func(t *testing.T) {
			if got := orderingKey([]byte(row.payload)); got != row.want {
				t.Fatalf("orderingKey() = %q, want %q", got, row.want)
			}
		})
	}
}
