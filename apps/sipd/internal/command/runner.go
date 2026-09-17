package command

import (
	"context"
	"encoding/json"
	"time"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/keyed"
)

// The command runner's capacity. maxConcurrentCommands bounds the handlers executing at once;
// maxPendingCommands and maxPendingPerLeg bound what is WAITING, which is the part a call storm
// grows. Past them a command is refused with `capacity` rather than queued behind work the engine
// has already timed out on.
const (
	maxConcurrentCommands = 256
	maxPendingCommands    = 4096
	maxPendingPerLeg      = 256
	// commandEnqueueTimeout is how long a command may wait for a slot. It is the engine's own RPC
	// budget: past it the requester is gone, so the handler answers `capacity` and does no work.
	commandEnqueueTimeout = 2 * time.Second
)

// keyedRunner runs a handler off the NATS dispatcher goroutine while keeping the commands for one
// leg in the order they arrived.
//
// A NATS subscription dispatches its subject on ONE goroutine, so answering inline serialised every
// resolve-target and originate on that subject behind the location-service round trip of the one in
// front. Submit hands the work over and returns, so the dispatcher goes back to reading the socket.
type keyedRunner struct{ exec *keyed.Executor }

func newKeyedRunner(maxConcurrent int) *keyedRunner {
	exec, err := keyed.New(keyed.Options{
		MaxConcurrent:    maxConcurrent,
		MaxPending:       maxPendingCommands,
		MaxPendingPerKey: maxPendingPerLeg,
		EnqueueTimeout:   commandEnqueueTimeout,
	})
	if err != nil {
		// Only a non-positive limit reaches this, which would be a constant edited to zero.
		panic("command: " + err.Error())
	}
	return &keyedRunner{exec: exec}
}

// Submit queues task under key and never blocks. Tasks sharing a key run one at a time, oldest
// first; tasks under different keys run concurrently, bounded by the runner's slots.
//
// It returns keyed.ErrOverloaded or keyed.ErrClosed instead of queueing without limit; the caller
// must answer its requester in that case.
func (r *keyedRunner) Submit(key string, task func()) error {
	return r.exec.SubmitKey(key, func(ctx context.Context) {
		if ctx.Err() != nil {
			return
		}
		task()
	})
}

// SubmitContext is Submit for a caller that answers the expired case itself; ctx is already expired
// when the task waited past commandEnqueueTimeout for a slot.
func (r *keyedRunner) SubmitContext(key string, task func(ctx context.Context)) error {
	return r.exec.SubmitKey(key, task)
}

// Drain stops accepting commands and waits for the ones already accepted, reporting whether they
// all finished. Called after the subscriptions are gone and before the dialogs are torn down.
func (r *keyedRunner) Drain(ctx context.Context) bool { return r.exec.Shutdown(ctx) }

// orderingKey is the leg a request names. Every command subject carries `legId`, and a leg lives on
// one dialog, so ordering per leg is what the ordering on a single dispatcher goroutine gave —
// across subjects as well as within one. A payload that names no leg falls back to the empty key,
// which is one shared FIFO chain.
func orderingKey(data []byte) string {
	var identity struct {
		LegID string `json:"legId"`
	}
	if json.Unmarshal(data, &identity) != nil {
		return ""
	}
	return identity.LegID
}
