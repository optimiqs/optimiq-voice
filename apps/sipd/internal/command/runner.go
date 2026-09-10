package command

import (
	"encoding/json"
	"sync"
)

// maxConcurrentCommands is the ceiling on command handlers executing at once. It bounds the
// goroutines a call storm can put in flight; past it a request waits its turn rather than being
// refused, because a command that arrives during a storm is one the engine is still waiting for.
const maxConcurrentCommands = 256

// keyedRunner runs a handler off the NATS dispatcher goroutine while keeping the commands for one
// leg in the order they arrived.
//
// A NATS subscription dispatches its subject on ONE goroutine, so answering inline serialised every
// resolve-target and originate on that subject behind the location-service round trip of the one in
// front. Submit hands the work over and returns, so the dispatcher goes back to reading the socket.
type keyedRunner struct {
	mu      sync.Mutex
	pending map[string][]func()
	slots   chan struct{}
}

func newKeyedRunner(maxConcurrent int) *keyedRunner {
	return &keyedRunner{
		pending: make(map[string][]func()),
		slots:   make(chan struct{}, maxConcurrent),
	}
}

// Submit queues task under key and never blocks. Tasks sharing a key run one at a time, oldest
// first; tasks under different keys run concurrently, bounded by the runner's slots.
func (r *keyedRunner) Submit(key string, task func()) {
	r.mu.Lock()
	queue, draining := r.pending[key]
	r.pending[key] = append(queue, task)
	r.mu.Unlock()
	if draining {
		return
	}
	go r.drain(key)
}

func (r *keyedRunner) drain(key string) {
	for {
		r.mu.Lock()
		queue := r.pending[key]
		if len(queue) == 0 {
			delete(r.pending, key)
			r.mu.Unlock()
			return
		}
		task := queue[0]
		queue[0] = nil
		r.pending[key] = queue[1:]
		r.mu.Unlock()

		r.run(task)
	}
}

func (r *keyedRunner) run(task func()) {
	r.slots <- struct{}{}
	defer func() { <-r.slots }()
	task()
}

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
