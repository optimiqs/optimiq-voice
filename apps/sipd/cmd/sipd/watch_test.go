package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWatchAttachesWhenControlPlaneStartsLater(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var attempts atomic.Int32
	attached := make(chan struct{})
	watchWhenAvailable(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), "trunks", time.Millisecond, func() error {
		if attempts.Add(1) < 3 {
			return errors.New("bucket not found")
		}
		close(attached)
		return nil
	})
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("watcher never retried the missing bucket")
	}
	time.Sleep(5 * time.Millisecond)
	if attempts.Load() != 3 {
		t.Fatal("watcher attached more than once")
	}
}

func TestWatchStopsRetryingOnShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var attempts atomic.Int32
	watchWhenAvailable(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), "sip-acl", time.Millisecond, func() error {
		attempts.Add(1)
		cancel()
		return errors.New("bucket not found")
	})
	time.Sleep(5 * time.Millisecond)
	if attempts.Load() != 1 {
		t.Fatal("retried after shutdown")
	}
}

// No backoff meant one JetStream lookup per second, per watched bucket, for the life of a process
// whose control plane never creates the bucket — and every failure after the first was silent.
func TestWatchBacksOffBetweenAttempts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var gaps []time.Duration
	last := time.Now()
	done := make(chan struct{})
	watchWhenAvailable(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), "sip-acl", 10*time.Millisecond, func() error {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if len(gaps) > 0 || !last.IsZero() {
			gaps = append(gaps, now.Sub(last))
		}
		last = now
		if len(gaps) == 4 {
			close(done)
		}
		return errors.New("bucket not found")
	})

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watcher stopped retrying")
	}
	cancel()

	mu.Lock()
	defer mu.Unlock()
	// gaps[0] is the wait after the synchronous first attempt; each subsequent one must be longer.
	for index := 1; index < len(gaps); index++ {
		if gaps[index] <= gaps[index-1] {
			t.Fatalf("retry gaps did not grow: %v", gaps)
		}
	}
}
