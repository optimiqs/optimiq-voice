package ackpub_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/packages/runtime-go/ackpub"
)

func newPublisher(t *testing.T, opts ackpub.Options) *ackpub.Publisher {
	t.Helper()
	if opts.MaxConcurrent == 0 {
		opts.MaxConcurrent = 4
	}
	if opts.MaxPending == 0 {
		opts.MaxPending = 32
	}
	if opts.MaxPendingPerKey == 0 {
		opts.MaxPendingPerKey = 32
	}
	if opts.Timeout == 0 {
		opts.Timeout = time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	publisher, err := ackpub.New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { publisher.Shutdown(context.Background()) })
	return publisher
}

func drain(t *testing.T, publisher *ackpub.Publisher) {
	t.Helper()
	publisher.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !publisher.Wait(ctx) {
		t.Fatal("the publisher did not drain")
	}
}

// A slow first publish must not let the second event about the same session overtake it: the engine
// tears a leg down on `recording.finished` and would archive a file that is still being written.
func TestEventsSharingAKeyPublishInOrder(t *testing.T) {
	var mu sync.Mutex
	var got []string
	release := make(chan struct{})

	publisher := newPublisher(t, ackpub.Options{MaxConcurrent: 4})
	if err := publisher.Publish(ackpub.Event{ID: "1", Key: "session-1", Type: "first",
		Publish: func(context.Context) error {
			<-release
			mu.Lock()
			got = append(got, "first")
			mu.Unlock()
			return nil
		}}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if err := publisher.Publish(ackpub.Event{ID: "2", Key: "session-1", Type: "second",
		Publish: func(context.Context) error {
			mu.Lock()
			got = append(got, "second")
			mu.Unlock()
			return nil
		}}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	close(release)
	drain(t, publisher)

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || got[0] != "first" || got[1] != "second" {
		t.Fatalf("events about one session reached the broker out of order: %v", got)
	}
}

func TestCriticalEventRetriesWithAStableID(t *testing.T) {
	var mu sync.Mutex
	var ids []string
	publisher := newPublisher(t, ackpub.Options{Attempts: 3, Backoff: time.Millisecond})
	err := publisher.Publish(ackpub.Event{ID: "evt-1", Key: "session-1", Type: "session.ended",
		Critical: true,
		Publish: func(context.Context) error {
			mu.Lock()
			ids = append(ids, "evt-1")
			attempt := len(ids)
			mu.Unlock()
			if attempt < 3 {
				return errors.New("broker unwell")
			}
			return nil
		}})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	drain(t, publisher)

	mu.Lock()
	defer mu.Unlock()
	if len(ids) != 3 {
		t.Fatalf("a critical event was attempted %d times, want 3", len(ids))
	}
	for _, id := range ids {
		if id != "evt-1" {
			t.Fatalf("retry changed the event id: %v", ids)
		}
	}
}

func TestTelemetryEventIsNotRetried(t *testing.T) {
	var attempts int
	var mu sync.Mutex
	failures := make(chan error, 1)
	publisher := newPublisher(t, ackpub.Options{
		Attempts: 5, Backoff: time.Millisecond,
		Failed: func(_ ackpub.Event, err error) { failures <- err },
	})
	if err := publisher.Publish(ackpub.Event{ID: "evt-2", Key: "session-1", Type: "playback.finished",
		Publish: func(context.Context) error {
			mu.Lock()
			attempts++
			mu.Unlock()
			return errors.New("broker unwell")
		}}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	drain(t, publisher)

	mu.Lock()
	defer mu.Unlock()
	if attempts != 1 {
		t.Fatalf("telemetry was attempted %d times, want 1", attempts)
	}
	select {
	case <-failures:
	default:
		t.Fatal("a dropped event was not reported to Failed")
	}
}

func TestExhaustedCriticalEventReportsTerminalFailure(t *testing.T) {
	reported := make(chan ackpub.Event, 1)
	publisher := newPublisher(t, ackpub.Options{
		Attempts: 2, Backoff: time.Millisecond,
		Failed: func(event ackpub.Event, _ error) { reported <- event },
	})
	if err := publisher.Publish(ackpub.Event{ID: "evt-3", Key: "session-1", Type: "session.ended",
		Critical: true,
		Publish:  func(context.Context) error { return errors.New("rejected") }}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	drain(t, publisher)

	select {
	case event := <-reported:
		if event.ID != "evt-3" {
			t.Fatalf("reported the wrong event: %s", event.ID)
		}
	default:
		t.Fatal("an unacknowledged critical event failed silently")
	}
}

func TestPublishIsRefusedAfterClose(t *testing.T) {
	publisher := newPublisher(t, ackpub.Options{})
	publisher.Close()
	err := publisher.Publish(ackpub.Event{ID: "evt-4", Key: "k",
		Publish: func(context.Context) error { return nil }})
	if !errors.Is(err, ackpub.ErrClosed) {
		t.Fatalf("expected ErrClosed after Close, got %v", err)
	}
}

func TestPublishIsRefusedWhenTheQueueIsFull(t *testing.T) {
	publisher := newPublisher(t, ackpub.Options{MaxConcurrent: 1, MaxPending: 1, MaxPendingPerKey: 1})
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	if err := publisher.Publish(ackpub.Event{ID: "a", Key: "k", Publish: func(context.Context) error {
		close(started)
		<-release
		return nil
	}}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	<-started
	if err := publisher.Publish(ackpub.Event{ID: "b", Key: "k",
		Publish: func(context.Context) error { return nil }}); err != nil {
		t.Fatalf("the one allowed queued event: %v", err)
	}
	if err := publisher.Publish(ackpub.Event{ID: "c", Key: "k",
		Publish: func(context.Context) error { return nil }}); !errors.Is(err, ackpub.ErrOverloaded) {
		t.Fatalf("expected ErrOverloaded past the queue limit, got %v", err)
	}
}
