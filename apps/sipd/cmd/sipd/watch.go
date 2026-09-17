package main

import (
	"context"
	"log/slog"
	"time"
)

// maxWatchBackoff caps the retry interval. A bucket the control plane never creates would otherwise
// be one JetStream lookup per second, per watched bucket, for the life of the process.
const maxWatchBackoff = 30 * time.Second

// watchWhenAvailable attaches a directory watcher, retrying in the background if the bucket is not
// there yet: the control plane owns directory buckets and may start after the SIP edge.
//
// The interval doubles up to maxWatchBackoff, and every failure is logged, so an operator can see a
// directory that never attached.
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
				// Warn every tenth attempt, so a persistent failure is visible in ordinary logs
				// without one line per retry.
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
