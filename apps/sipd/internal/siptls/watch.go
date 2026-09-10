package siptls

import (
	"context"
	"path/filepath"
	"slices"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DefaultWatchInterval is how often the certificate files are stat'd when nothing else prompts a
// reload. Slow on purpose: renewals happen days apart, and the poll exists as a backstop for
// filesystems where the inotify/kqueue watch cannot see the change.
const DefaultWatchInterval = 30 * time.Second

// debounceWindow collapses the burst an atomic renewal produces — cert.pem renamed over, then
// key.pem, or a pair of symlinks re-pointed — into a single reload, so the pair is never read
// half-way through a replacement.
const debounceWindow = 250 * time.Millisecond

// Watch reloads the certificate whenever `signals` fires, the certificate directory changes, or
// the poll comes round, until ctx is done. It never returns an error: a failed reload leaves the
// previous certificate serving, which is the only safe outcome mid-renewal, and is logged.
//
// The filesystem watch is on the *directories* holding the PEM files, not the files themselves.
// ACME tooling never rewrites a certificate in place — certbot renames a new file over the old one
// or re-points a symlink — and a watch on an inode follows the file that was replaced, not the
// name. Watching the directory sees the rename, and the watch set is re-armed after every reload so
// a symlink whose target moved to another directory keeps being watched.
//
// Interval <= 0 disables the poll and leaves the signal and the filesystem watch as the triggers.
func (r *Reloader) Watch(ctx context.Context, signals <-chan struct{}, interval time.Duration) {
	var poll <-chan time.Time
	if interval > 0 {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		poll = ticker.C
	}

	var events chan fsnotify.Event
	var errs chan error
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		r.log.Error("watching the SIP TLS certificate directory failed; falling back to the poll",
			"cert", r.certFile, "error", err)
	} else {
		defer watcher.Close()
		events, errs = watcher.Events, watcher.Errors
		r.rearm(watcher)
	}

	// A nil channel blocks for ever, which is what an unarmed debounce should do.
	var debounce <-chan time.Time
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	arm := func() {
		if timer == nil {
			timer = time.NewTimer(debounceWindow)
		} else {
			timer.Stop()
			timer.Reset(debounceWindow)
		}
		debounce = timer.C
	}

	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-signals:
			if !ok {
				signals = nil
				continue
			}
			r.reloadOnce("signal", true)
		case _, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			// Any event in a watched directory arms the debounce, including the staging files a
			// renewal writes before renaming: backends differ on which name they report for a
			// rename-over, and re-reading is cheap and cannot install a half-written pair.
			arm()
		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			r.log.Warn("the SIP TLS certificate directory watch reported an error",
				"cert", r.certFile, "error", err)
		case <-debounce:
			debounce = nil
			r.reloadOnce("file change", true)
			if watcher != nil {
				r.rearm(watcher)
			}
		case <-poll:
			r.reloadOnce("poll", false)
		}
	}
}

// rearm points the watcher at the directories that currently hold the pair: the ones the configured
// paths live in, plus, when a path is a symlink, the directory its target lives in. Both are
// re-computed after every reload, because an ACME layout swaps the symlink to a file in a directory
// that may not have existed when the process started.
func (r *Reloader) rearm(watcher *fsnotify.Watcher) {
	wanted := make([]string, 0, 4)
	for _, path := range []string{r.certFile, r.keyFile} {
		wanted = appendDir(wanted, filepath.Dir(path))
		if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved != path {
			wanted = appendDir(wanted, filepath.Dir(resolved))
		}
	}
	for _, existing := range watcher.WatchList() {
		if !slices.Contains(wanted, existing) {
			_ = watcher.Remove(existing)
		}
	}
	for _, dir := range wanted {
		if err := watcher.Add(dir); err != nil {
			r.log.Warn("watching a SIP TLS certificate directory failed",
				"dir", dir, "cert", r.certFile, "error", err)
		}
	}
}

func appendDir(dirs []string, dir string) []string {
	dir = filepath.Clean(dir)
	if slices.Contains(dirs, dir) {
		return dirs
	}
	return append(dirs, dir)
}

// reloadOnce re-reads the pair and logs the outcome. `force` skips the stat fast path: a rename or
// a symlink swap can land a file whose size and mtime happen to match the one it replaced, and an
// event has already told us something moved.
func (r *Reloader) reloadOnce(trigger string, force bool) {
	changed, err := r.reload(force)
	switch {
	case err != nil:
		r.log.Error("reloading the SIP TLS certificate failed; the previous one stays in service",
			"trigger", trigger, "cert", r.certFile, "error", err)
	case changed:
		r.log.Info("SIP TLS certificate reloaded", "trigger", trigger, "cert", r.certFile)
	}
}
