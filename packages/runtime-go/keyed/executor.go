// Package keyed runs submitted work off its caller's goroutine while keeping the tasks that name
// the same resource in the order they arrived, under explicit capacity limits.
//
// A NATS subscription dispatches one subject on ONE goroutine, so answering inline serialises every
// request behind the I/O of the one in front. An Executor takes the work over and returns — but
// unlike a bare `go func()` it holds a bounded queue, refuses admission once that queue is full, and
// hands an already-expired context to work whose requester has given up waiting.
//
// A task reserves a SET of keys and runs only once it is first in line for every one of them, so a
// command touching {a,b} and one touching {b,c} cannot overlap even though neither set is a subset
// of the other. Reservation follows arrival order on each key, which is why it cannot deadlock: the
// oldest admitted task is first in line everywhere.
package keyed

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"
)

// ErrOverloaded is returned by Submit when the total or per-key pending limit is reached. The
// caller still owns the request: it must answer its requester rather than retry in place.
var ErrOverloaded = errors.New("keyed: the executor is at its pending limit")

// ErrClosed is returned by Submit after Close. Distinct from ErrOverloaded, which means "retry
// later"; this one means "do not retry here".
var ErrClosed = errors.New("keyed: the executor is draining")

// Task is one unit of submitted work.
//
// ctx carries the enqueue deadline and is cancelled by a hard shutdown. A task that waited past its
// deadline in the queue is STILL invoked, with ctx already expired, so the caller can answer its
// requester — such a task must check ctx.Err() and perform no side effects when it is non-nil.
type Task func(ctx context.Context)

// Options configures an Executor. MaxConcurrent, MaxPending and MaxPendingPerKey must be positive.
type Options struct {
	// MaxConcurrent is how many tasks may execute at once, across all keys.
	MaxConcurrent int
	// MaxPending is the ceiling on admitted-but-not-started tasks. It bounds both the retained
	// closures and the goroutines waiting for a slot.
	MaxPending int
	// MaxPendingPerKey stops one busy resource from consuming the whole queue.
	MaxPendingPerKey int
	// EnqueueTimeout is how long a task may wait before starting. Zero means no deadline, which is
	// what a publisher of already-final facts wants; a request-reply surface should set it to the
	// requester's own timeout.
	EnqueueTimeout time.Duration
}

// Executor is a bounded, per-key-ordered task runner. The zero value is not usable; call New.
type Executor struct {
	opts    Options
	slots   chan struct{}
	baseCtx context.Context
	cancel  context.CancelFunc

	mu      sync.Mutex
	queues  map[string][]*job
	pending int
	closed  bool

	running sync.WaitGroup
}

type job struct {
	keys     []string
	task     Task
	deadline time.Time
	launched bool
}

// New builds an Executor. It returns an error rather than defaulting silently, because a limit left
// at zero is the bug this package exists to prevent.
func New(opts Options) (*Executor, error) {
	switch {
	case opts.MaxConcurrent <= 0:
		return nil, errors.New("keyed: MaxConcurrent must be positive")
	case opts.MaxPending <= 0:
		return nil, errors.New("keyed: MaxPending must be positive")
	case opts.MaxPendingPerKey <= 0:
		return nil, errors.New("keyed: MaxPendingPerKey must be positive")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Executor{
		opts:    opts,
		slots:   make(chan struct{}, opts.MaxConcurrent),
		baseCtx: ctx,
		cancel:  cancel,
		queues:  make(map[string][]*job),
	}, nil
}

// Submit queues task against every key in keys and never blocks. Tasks whose sets intersect run one
// at a time, oldest first; tasks over disjoint sets run concurrently, bounded by MaxConcurrent. An
// empty set is one shared chain — the fallback for a request that names no resource.
//
// It returns ErrOverloaded or ErrClosed instead of queueing without limit, and the task does not
// run in that case.
func (e *Executor) Submit(keys []string, task Task) error {
	if task == nil {
		return errors.New("keyed: a task is required")
	}
	reserved := normalise(keys)
	var deadline time.Time
	if e.opts.EnqueueTimeout > 0 {
		deadline = time.Now().Add(e.opts.EnqueueTimeout)
	}

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return ErrClosed
	}
	if e.pending >= e.opts.MaxPending {
		e.mu.Unlock()
		return ErrOverloaded
	}
	for _, key := range reserved {
		if e.waitingOnLocked(key) >= e.opts.MaxPendingPerKey {
			e.mu.Unlock()
			return ErrOverloaded
		}
	}
	next := &job{keys: reserved, task: task, deadline: deadline}
	for _, key := range reserved {
		e.queues[key] = append(e.queues[key], next)
	}
	e.pending++
	start := e.readyLocked(next)
	if start {
		e.launchLocked(next)
	}
	e.mu.Unlock()

	if start {
		go e.run(next)
	}
	return nil
}

// SubmitKey is Submit for the common case of a task reserving one resource.
func (e *Executor) SubmitKey(key string, task Task) error {
	return e.Submit([]string{key}, task)
}

// Pending reports the admitted-but-not-started task count. For tests and metrics.
func (e *Executor) Pending() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pending
}

// Close stops admission. Work already queued still runs; use Wait or Shutdown to see it out.
func (e *Executor) Close() {
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
}

// Wait blocks until every queued and running task has finished or ctx expires, and reports whether
// they all finished. It does NOT stop admission on its own — call Close first, or a caller still
// submitting keeps it waiting.
func (e *Executor) Wait(ctx context.Context) bool {
	done := make(chan struct{})
	go func() {
		e.running.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

// Shutdown stops admission and waits for the queue to drain, cancelling the contexts of tasks still
// running if ctx expires first. It reports whether the executor drained before that cancellation.
func (e *Executor) Shutdown(ctx context.Context) bool {
	e.Close()
	drained := e.Wait(ctx)
	e.cancel()
	return drained
}

// normalise sorts and de-duplicates a key set, so two requests naming the same resources hold the
// same reservations however the caller ordered them. An empty set becomes the shared chain.
func normalise(keys []string) []string {
	if len(keys) == 0 {
		return []string{""}
	}
	reserved := slices.Clone(keys)
	slices.Sort(reserved)
	reserved = slices.Compact(reserved)
	return reserved
}

// waitingOnLocked is how many tasks are queued behind whatever holds key. The head is excluded once
// it has been launched: the limit bounds waiting work, not the one command in progress.
func (e *Executor) waitingOnLocked(key string) int {
	queue := e.queues[key]
	if len(queue) > 0 && queue[0].launched {
		return len(queue) - 1
	}
	return len(queue)
}

// readyLocked reports whether next is first in line on every key it reserves.
func (e *Executor) readyLocked(next *job) bool {
	if next.launched {
		return false
	}
	for _, key := range next.keys {
		queue := e.queues[key]
		if len(queue) == 0 || queue[0] != next {
			return false
		}
	}
	return true
}

func (e *Executor) launchLocked(next *job) {
	next.launched = true
	e.running.Add(1)
}

func (e *Executor) run(next *job) {
	defer e.running.Done()
	// The slot is taken BEFORE the task stops counting as pending, so a task waiting for one still
	// counts against the pending limit. Otherwise a burst of unique keys would park an unaccounted
	// goroutine per key here, which is the unbounded waiting this executor exists to remove.
	e.slots <- struct{}{}
	e.mu.Lock()
	e.pending--
	e.mu.Unlock()

	// The reservations are released even if the task panics; leaving them held would wedge every
	// later command on those resources.
	defer e.finish(next)
	defer func() { <-e.slots }()

	if next.deadline.IsZero() {
		next.task(e.baseCtx)
		return
	}
	// An expired deadline still reaches the task, which is how the caller learns to answer its
	// requester with a refusal rather than doing work nobody is waiting for any more.
	ctx, cancel := context.WithDeadline(e.baseCtx, next.deadline)
	defer cancel()
	next.task(ctx)
}

// finish drops a finished task's reservations and starts whatever they were holding back.
func (e *Executor) finish(done *job) {
	e.mu.Lock()
	var ready []*job
	for _, key := range done.keys {
		queue := e.queues[key]
		if len(queue) == 0 || queue[0] != done {
			// Unreachable: a task only runs while it is first in line on every key it reserved.
			continue
		}
		queue[0] = nil
		queue = queue[1:]
		if len(queue) == 0 {
			delete(e.queues, key)
			continue
		}
		e.queues[key] = queue
		if head := queue[0]; e.readyLocked(head) {
			e.launchLocked(head)
			ready = append(ready, head)
		}
	}
	e.mu.Unlock()

	for _, next := range ready {
		go e.run(next)
	}
}
