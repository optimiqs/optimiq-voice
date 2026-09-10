// Package ackpub publishes events off the goroutine that produced them while preserving the order
// they were produced in per key, and retrying the ones a consumer depends on until the broker
// acknowledges them.
//
// A bare `go publish(...)` loses two things a call flow needs: the order two events about the same
// session were produced in, and the difference between "the broker took it" and "the goroutine
// exited". This publisher keeps both, bounded by a keyed.Executor rather than by a scheduler of its
// own.
package ackpub

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/keyed"
)

// ErrOverloaded is returned by Publish when the bounded queue is full, and ErrClosed after Close.
// Both mean the event was NOT published and the caller still owns it.
var (
	ErrOverloaded = keyed.ErrOverloaded
	ErrClosed     = keyed.ErrClosed
)

// Event is one publication attempt's worth of work.
type Event struct {
	// ID is the event's identity on the wire. It MUST be stable across retries: the broker's
	// duplicate window is what makes a retried critical event safe to deliver twice.
	ID string
	// Key orders the event. Events sharing a key are published in submission order; events with
	// different keys may overtake one another. A session or dialog id is the usual choice.
	Key string
	// Type names the event for logs and the Failed hook.
	Type string
	// Critical marks an event a consumer's workflow waits for. Critical events are retried until
	// acknowledged or the attempt budget runs out; anything else is telemetry, tried once.
	Critical bool
	// Publish performs one attempt. It must be idempotent and must honour ctx.
	Publish func(ctx context.Context) error
}

// Options configures a Publisher.
type Options struct {
	// MaxConcurrent is how many publishes may be talking to the broker at once. A mass reap
	// otherwise puts hundreds of concurrent publishes on a broker that is quite possibly unwell.
	MaxConcurrent int
	// MaxPending and MaxPendingPerKey bound the queue; past them Publish reports ErrOverloaded.
	MaxPending       int
	MaxPendingPerKey int
	// Timeout is the deadline on ONE attempt.
	Timeout time.Duration
	// Attempts is the total attempt budget for a critical event, retries included. Values below 1
	// are read as 1.
	Attempts int
	// Backoff is the pause before the first retry; it doubles per attempt. A retrying event holds
	// its concurrency slot for that pause, so keep the product of Attempts and Backoff small.
	Backoff time.Duration
	// Failed is called once per event that never got an acknowledgement, on the publishing
	// goroutine. It is the hook a durable outbox hangs off. Optional.
	Failed func(event Event, err error)
	Logger *slog.Logger
}

// Publisher is a bounded, per-key-ordered, acknowledged event publisher.
type Publisher struct {
	exec *keyed.Executor
	opts Options
	log  *slog.Logger
}

// New builds a Publisher. Timeout and the queue limits are required; see Options.
func New(opts Options) (*Publisher, error) {
	if opts.Timeout <= 0 {
		return nil, errors.New("ackpub: a publish timeout is required")
	}
	if opts.Attempts < 1 {
		opts.Attempts = 1
	}
	// No enqueue deadline: these events describe facts that have already happened, so a late
	// publish is still worth more than a dropped one.
	exec, err := keyed.New(keyed.Options{
		MaxConcurrent:    opts.MaxConcurrent,
		MaxPending:       opts.MaxPending,
		MaxPendingPerKey: opts.MaxPendingPerKey,
	})
	if err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Publisher{exec: exec, opts: opts, log: log}, nil
}

// Publish hands an event over and returns without waiting for the broker. Events sharing a Key
// reach the broker in the order Publish was called in.
func (p *Publisher) Publish(event Event) error {
	if event.Publish == nil {
		return errors.New("ackpub: an event needs a publish function")
	}
	return p.exec.SubmitKey(event.Key, func(ctx context.Context) {
		p.deliver(ctx, event)
	})
}

// Pending reports how many events are queued but not yet handed to the broker.
func (p *Publisher) Pending() int { return p.exec.Pending() }

// Close stops admission so a drain cannot be outrun by new events. Queued events still publish.
func (p *Publisher) Close() { p.exec.Close() }

// Wait blocks until every queued event has been published or abandoned, or ctx expires, and reports
// whether the queue drained. Close first, or a producer still running keeps it waiting.
func (p *Publisher) Wait(ctx context.Context) bool { return p.exec.Wait(ctx) }

// Shutdown closes admission, drains, and cancels in-flight attempts if ctx expires first.
func (p *Publisher) Shutdown(ctx context.Context) bool { return p.exec.Shutdown(ctx) }

func (p *Publisher) deliver(ctx context.Context, event Event) {
	attempts := p.opts.Attempts
	if !event.Critical {
		attempts = 1
	}
	backoff := p.opts.Backoff
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, p.opts.Timeout)
		err = event.Publish(attemptCtx)
		cancel()
		if err == nil {
			return
		}
		if attempt == attempts {
			break
		}
		select {
		case <-time.After(backoff):
			backoff *= 2
		case <-ctx.Done():
			// A hard shutdown: stop spending the budget and report the event as unacknowledged.
			attempt = attempts
		}
	}

	level := slog.LevelWarn
	if event.Critical {
		level = slog.LevelError
	}
	p.log.Log(context.Background(), level, "cannot publish an event",
		"type", event.Type, "eventId", event.ID, "key", event.Key,
		"critical", event.Critical, "error", err)
	if p.opts.Failed != nil {
		p.opts.Failed(event, err)
	}
}
