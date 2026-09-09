package main

import (
	"context"
	"log/slog"
	"time"
)

// maxWatchBackoff caps the retry interval. A bucket the control plane never creates would otherwise
// be one JetStream lookup per second, per watched bucket, for the life of the process.
const maxWatchBackoff = 30 * time.Second

// The control plane owns directory buckets and may start after the SIP edge.
// Retry attachment without granting access or requiring an edge restart.
//
// The interval doubles up to maxWatchBackoff, and every failure is logged: silently retrying for
// ever leaves an operator with a trunk directory that never attached and nothing saying why.
func watchWhenAvailable(ctx context.Context, log *slog.Logger, bucket string, interval time.Duration, attach func() error) {
	if ctx.Err() != nil {
		return
	}
	if err := attach(); err == nil {
		return
	} else {
		log.Warn("directory unavailable; retrying watcher attachment", "bucket", bucket, "error", err)
	}
	go func() {
		delay := interval
		timer := time.NewTimer(delay)
		defer timer.Stop()
		attempts := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				if ctx.Err() != nil {
					return
				}
				err := attach()
				if err == nil {
					log.Info("directory watcher attached after startup",
						"bucket", bucket, "attempts", attempts+1)
					return
				}
				attempts++
				// Debug on every attempt, Warn every tenth, so a persistent failure is visible in
				// ordinary logs without one line per retry for ever.
				log.Debug("directory still unavailable", "bucket", bucket,
					"attempts", attempts, "retryIn", delay, "error", err)
				if attempts%10 == 0 {
					log.Warn("directory still unavailable after repeated attempts",
						"bucket", bucket, "attempts", attempts, "retryIn", delay, "error", err)
				}
				if delay < maxWatchBackoff {
					delay = min(delay*2, maxWatchBackoff)
				}
				timer.Reset(delay)
			}
		}
	}()
}
