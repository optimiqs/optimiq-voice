package sipevents

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/ackpub"
)

// ClaimReleaser deletes a dialog's `sip-dialogs` record. dialog.ClaimStore satisfies it; the
// interface is restated here so this package does not depend on the dialog package.
type ClaimReleaser interface {
	Delete(ctx context.Context, legID string) error
}

// FinalizerOptions configures a Finalizer.
type FinalizerOptions struct {
	// Publisher emits the terminations. Required.
	Publisher Publisher
	// Claims is the recovery record this finalisation releases. Required.
	Claims ClaimReleaser
	// Attempts and Backoff bound the retry of an unacknowledged termination. Zero takes the
	// defaults below.
	Attempts int
	Backoff  time.Duration
	// Timeout bounds one publish-and-delete attempt.
	Timeout time.Duration
	// MaxPending bounds the queue of finalisations awaiting acknowledgement.
	MaxPending int
	Logger     *slog.Logger
}

// Finalizer releases a dialog's recovery claim only after its `dialog.terminated` has been
// acknowledged by the stream.
//
// Deleting the claim on an unacknowledged publish is how a call ends with neither a termination
// event nor any record a reaper could act on: the claim is the only evidence left that the leg
// existed. So the two are one unit of work here — publish, wait for the ack, then delete — retried
// off the dialog's goroutine with the envelope's stable id making a redelivery a duplicate the
// stream collapses rather than a second CDR row.
//
// It is safe for concurrent use; Release and Terminated may be called from any goroutine.
type Finalizer struct {
	publisher Publisher
	claims    ClaimReleaser
	events    *ackpub.Publisher
	log       *slog.Logger

	mu      sync.Mutex
	pending map[string]struct{}
}

// NewFinalizer builds a Finalizer.
func NewFinalizer(opts FinalizerOptions) (*Finalizer, error) {
	if opts.Publisher == nil {
		return nil, errors.New("sipevents: a publisher is required to finalise a dialog")
	}
	if opts.Claims == nil {
		return nil, errors.New("sipevents: a claim store is required to finalise a dialog")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 5 * time.Second
	}
	if opts.Attempts <= 0 {
		opts.Attempts = 5
	}
	if opts.Backoff <= 0 {
		opts.Backoff = 200 * time.Millisecond
	}
	if opts.MaxPending <= 0 {
		opts.MaxPending = 4096
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	events, err := ackpub.New(ackpub.Options{
		MaxConcurrent: 16,
		MaxPending:    opts.MaxPending,
		// One in flight and one queued per leg: a dialog terminates once, and a second
		// finalisation for the same leg is a retry of the first.
		MaxPendingPerKey: 2,
		Timeout:          opts.Timeout,
		Attempts:         opts.Attempts,
		Backoff:          opts.Backoff,
		Logger:           log,
	})
	if err != nil {
		return nil, err
	}
	return &Finalizer{
		publisher: opts.Publisher,
		claims:    opts.Claims,
		events:    events,
		log:       log,
		pending:   make(map[string]struct{}),
	}, nil
}

// Terminated hands a leg's termination over and returns without waiting for the broker. The claim
// is released once the stream acknowledges it.
//
// A leg whose finalisation cannot even be queued keeps its claim: a reaper on another instance then
// publishes the termination off the claim's lease, which is late but not lost.
func (f *Finalizer) Terminated(envelope contract.Envelope[contract.SIPDialogTerminatedData]) error {
	legID := envelope.Data.LegID
	f.mu.Lock()
	f.pending[legID] = struct{}{}
	f.mu.Unlock()

	err := f.events.Publish(ackpub.Event{
		ID:       envelope.ID,
		Key:      legID,
		Type:     envelope.Type,
		Critical: true,
		Publish: func(ctx context.Context) error {
			if err := PublishTerminatedAck(ctx, f.publisher, envelope); err != nil {
				return err
			}
			return f.release(ctx, legID)
		},
	})
	if err != nil {
		f.forget(legID)
		return err
	}
	return nil
}

// Release drops a leg's claim when nothing is waiting to be acknowledged for it. A leg whose
// termination is in flight keeps its claim until that publish is acknowledged, which is the whole
// point of this type.
func (f *Finalizer) Release(ctx context.Context, legID string) error {
	f.mu.Lock()
	_, waiting := f.pending[legID]
	f.mu.Unlock()
	if waiting {
		return nil
	}
	return f.claims.Delete(ctx, legID)
}

func (f *Finalizer) release(ctx context.Context, legID string) error {
	if err := f.claims.Delete(ctx, legID); err != nil {
		return err
	}
	f.forget(legID)
	return nil
}

func (f *Finalizer) forget(legID string) {
	f.mu.Lock()
	delete(f.pending, legID)
	f.mu.Unlock()
}

// Pending reports how many finalisations are queued or in flight, which is what a drain waits on.
func (f *Finalizer) Pending() int { return f.events.Pending() }

// Shutdown stops admission and drains, so a terminating process does not leave a termination
// unpublished that it could still have delivered. It reports whether the queue drained.
func (f *Finalizer) Shutdown(ctx context.Context) bool { return f.events.Shutdown(ctx) }
