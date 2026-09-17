package control

import (
	"context"
	"time"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/keyed"
)

// The command runner's capacity. maxConcurrentCommands bounds the handlers executing at once;
// maxPendingCommands and maxPendingPerResource bound what is WAITING, which is the part a call
// storm grows. Past them an allocate is refused with `capacity` rather than queued behind work the
// engine has already timed out on.
const (
	maxConcurrentCommands = 256
	maxPendingCommands    = 4096
	maxPendingPerResource = 256
	// commandEnqueueTimeout is how long a command may wait for a slot. It is the engine's own RPC
	// budget: past it the requester is gone, so the handler answers `capacity` and does no work.
	commandEnqueueTimeout = 2 * time.Second
)

// keyedRunner runs a request off the NATS dispatcher goroutine while keeping requests that name the
// same resources in the order they arrived.
//
// A NATS subscription dispatches its subject on ONE goroutine, so answering inline serialised every
// allocate, create-offer and hold on that subject behind the KV round trips of the one in front.
// Submit hands the work over and returns, so the dispatcher goes straight back to reading the socket.
type keyedRunner struct{ exec *keyed.Executor }

func newKeyedRunner(maxConcurrent int) *keyedRunner {
	exec, err := keyed.New(keyed.Options{
		MaxConcurrent:    maxConcurrent,
		MaxPending:       maxPendingCommands,
		MaxPendingPerKey: maxPendingPerResource,
		EnqueueTimeout:   commandEnqueueTimeout,
	})
	if err != nil {
		// Only a non-positive limit reaches this, which would be a constant edited to zero.
		panic("control: " + err.Error())
	}
	return &keyedRunner{exec: exec}
}

// Submit queues task under key and never blocks. Tasks sharing a key run one at a time, oldest
// first; tasks under different keys run concurrently, bounded by the runner's slots.
//
// It returns keyed.ErrOverloaded or keyed.ErrClosed instead of queueing without limit; the caller
// must answer its requester in that case. A task that waited past commandEnqueueTimeout still runs,
// with an expired context, so it can refuse rather than act on a command nobody awaits.
func (r *keyedRunner) Submit(key string, task func()) error {
	return r.SubmitKeys([]string{key}, task)
}

// SubmitKeys is Submit for a command that touches SEVERAL resources. The task runs only once it is
// first in line for every one of them, so a bridge of {a,b} and a bridge of {b,c} cannot overlap
// even though neither set contains the other.
func (r *keyedRunner) SubmitKeys(keys []string, task func()) error {
	return r.exec.Submit(keys, func(ctx context.Context) {
		if ctx.Err() != nil {
			return
		}
		task()
	})
}

// SubmitContext is SubmitKeys for a caller that answers the expired case itself; ctx is already
// expired when the task waited too long for a slot.
func (r *keyedRunner) SubmitContext(keys []string, task func(ctx context.Context)) error {
	return r.exec.Submit(keys, task)
}

// Drain stops accepting commands and waits for the ones already accepted, reporting whether they
// all finished. Called after the subscriptions are gone and before the sessions are torn down.
func (r *keyedRunner) Drain(ctx context.Context) bool { return r.exec.Shutdown(ctx) }
