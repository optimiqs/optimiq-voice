package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
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
