// Package siplog filters sipgo's own logging before it reaches the process handler.
//
// sipgo logs several routine facts at WARN and ERROR, which on a healthy call is 3.5 lines per call
// that no operator can act on, and one of them — the parse failure — carries the sender's RAW BYTES
// at ERROR, so an unauthenticated peer chooses this process's log volume and puts its own payload in
// the record. The levels are the library's and not configurable, so they are rewritten here.
package siplog

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// payloadExcerptBytes is how much of a rejected payload is kept, as hex. Enough to tell TLS from a
// truncated REGISTER from a port scan, short enough that no attacker-chosen text is ever rendered.
const payloadExcerptBytes = 32

// rateLimitWindow and rateLimitBurst bound how often one filtered message may reach the handler.
const (
	rateLimitWindow = time.Minute
	rateLimitBurst  = 5
)

// rate limiter keys tracked at once, after which the table is dropped whole.
const limiterCapacity = 1024

type rule struct {
	// level replaces the level sipgo chose.
	level slog.Level
	// sanitise replaces raw payload attributes with a length and a short hex excerpt.
	sanitise bool
	// limited caps how often the message reaches the handler.
	limited bool
}

// rules is keyed by sipgo's exact message text. Every entry is a fact about the peer or about the
// library's own bookkeeping, never about this process's health.
var rules = map[string]rule{
	// The sender's bytes are not a SIP message. That is the sender's business, and the rate is
	// chosen by whoever sends garbage.
	"failed to parse": {level: slog.LevelDebug, sanitise: true, limited: true},
	// The ACK for a 2xx is its own transaction (RFC 3261 §13.2.2.4) and this edge takes it on the
	// server's OnAck handler, so the INVITE transaction's ack channel is deliberately never drained.
	// One per answered call.
	"ACK missed": {level: slog.LevelDebug},
	// sipgo's connection reference counting, which this process does not drive.
	"TCP ref went negative": {level: slog.LevelDebug},
	"WS ref went negative":  {level: slog.LevelDebug},
}

// payloadKeys are the attributes that carry bytes the peer chose.
var payloadKeys = map[string]bool{"data": true, "body": true}

// Handler wraps another handler and applies the rules above. Handlers derived with WithAttrs or
// WithGroup share one rate limiter, so a limit is per process and not per logger.
type Handler struct {
	next    slog.Handler
	limiter *limiter
}

// Wrap returns next with sipgo's routine WARN and ERROR records downgraded, its rejected payloads
// reduced to a bounded excerpt, and the repeatable ones rate limited. Install it with
// sip.SetDefaultLogger: sipgo's transport and transaction layers both take their logger from there.
func Wrap(next slog.Handler) *Handler {
	return &Handler{next: next, limiter: newLimiter(rateLimitWindow, rateLimitBurst)}
}

// Enabled reports what the wrapped handler reports. The rules only lower levels, so a record this
// refuses would have been refused anyway.
func (h *Handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

// Handle applies the rule for this record's message, if there is one, and passes the rest through.
func (h *Handler) Handle(ctx context.Context, record slog.Record) error {
	applied, found := rules[record.Message]
	if !found {
		return h.next.Handle(ctx, record)
	}
	if !h.next.Enabled(ctx, applied.level) {
		return nil
	}
	suppressed := 0
	if applied.limited {
		allowed, held := h.limiter.allow(record.Message)
		if !allowed {
			return nil
		}
		suppressed = held
	}

	out := slog.NewRecord(record.Time, applied.level, record.Message, record.PC)
	record.Attrs(func(attr slog.Attr) bool {
		if applied.sanitise && payloadKeys[attr.Key] {
			out.AddAttrs(slog.String(attr.Key, excerpt(attr.Value)))
			return true
		}
		out.AddAttrs(attr)
		return true
	})
	if suppressed > 0 {
		out.AddAttrs(slog.Int("suppressedSinceLast", suppressed))
	}
	return h.next.Handle(ctx, out)
}

// WithAttrs implements slog.Handler.
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &Handler{next: h.next.WithAttrs(attrs), limiter: h.limiter}
}

// WithGroup implements slog.Handler.
func (h *Handler) WithGroup(name string) slog.Handler {
	return &Handler{next: h.next.WithGroup(name), limiter: h.limiter}
}

// excerpt renders a peer-chosen payload as its length and the hex of its first bytes. Hex and not
// text: a log line must never replay what an unauthenticated sender wrote.
func excerpt(value slog.Value) string {
	var raw []byte
	switch value.Kind() {
	case slog.KindString:
		raw = []byte(value.String())
	default:
		if bytes, ok := value.Any().([]byte); ok {
			raw = bytes
		} else {
			raw = []byte(value.String())
		}
	}
	head := raw[:min(payloadExcerptBytes, len(raw))]
	return fmt.Sprintf("bytes=%d head=%x", len(raw), head)
}

// limiter allows burst records per key per window and counts what it dropped, so the next record
// through can say how much is missing.
type limiter struct {
	window time.Duration
	burst  int

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	start      time.Time
	seen       int
	suppressed int
}

func newLimiter(window time.Duration, burst int) *limiter {
	return &limiter{window: window, burst: burst, buckets: make(map[string]*bucket)}
}

// allow reports whether this record may be logged, and how many were dropped since the last one
// that was.
func (l *limiter) allow(key string) (bool, int) {
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) >= limiterCapacity {
		clear(l.buckets)
	}
	held, found := l.buckets[key]
	if !found || now.Sub(held.start) >= l.window {
		suppressed := 0
		if found {
			suppressed = held.suppressed
		}
		l.buckets[key] = &bucket{start: now, seen: 1}
		return true, suppressed
	}
	if held.seen >= l.burst {
		held.suppressed++
		return false, 0
	}
	held.seen++
	suppressed := held.suppressed
	held.suppressed = 0
	return true, suppressed
}
