package control

import "sync"

// maxConcurrentCommands is the ceiling on media commands executing at once. It bounds the goroutines
// a burst can put in flight; past it a request waits its turn instead of being refused, because a
// media command that arrives during a call storm is one the engine is still waiting for.
const maxConcurrentCommands = 256

// keyedRunner runs a request off the NATS dispatcher goroutine while keeping requests that name the
// same resources in the order they arrived.
//
// A NATS subscription dispatches its subject on ONE goroutine, so answering inline serialised every
// allocate, create-offer and hold on that subject behind the KV round trips of the one in front.
// Submit hands the work over and returns, so the dispatcher goes straight back to reading the socket.
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
