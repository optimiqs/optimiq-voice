package main

import (
	"context"
	"log/slog"
	"time"
)

// The control plane owns directory buckets and may start after the SIP edge.
// Retry attachment without granting access or requiring an edge restart.
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
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ctx.Err() != nil {
					return
				}
				if err := attach(); err == nil {
					log.Info("directory watcher attached after startup", "bucket", bucket)
					return
				}
			}
		}
	}()
}
