package siplog

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func newLog(t *testing.T, level slog.Level) (*slog.Logger, *bytes.Buffer) {
	t.Helper()
	var sink bytes.Buffer
	handler := slog.NewJSONHandler(&sink, &slog.HandlerOptions{Level: level})
	return slog.New(Wrap(handler)), &sink
}

func records(t *testing.T, sink *bytes.Buffer) []map[string]any {
	t.Helper()
	out := make([]map[string]any, 0, 8)
	for line := range strings.SplitSeq(strings.TrimSpace(sink.String()), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("unmarshalling %q: %v", line, err)
		}
		out = append(out, record)
	}
	return out
}

// The security half: an unauthenticated sender's bytes were logged verbatim at ERROR, so the peer
// chose both this process's log level and its content.
func TestAParseFailureIsDowngradedAndItsPayloadRedacted(t *testing.T) {
	log, sink := newLog(t, slog.LevelDebug)
	log.Error("failed to parse", "data", "REGISTER sip:local.test SIP/2.0\r\nsecret", "error", "EOF")

	got := records(t, sink)
	if len(got) != 1 {
		t.Fatalf("got %d records, want 1", len(got))
	}
	if got[0]["level"] != "DEBUG" {
		t.Errorf("level = %v, want DEBUG", got[0]["level"])
	}
	data, _ := got[0]["data"].(string)
	if !strings.HasPrefix(data, "bytes=39 head=") {
		t.Errorf("data = %q, want a length and a hex excerpt", data)
	}
	if strings.Contains(data, "secret") || strings.Contains(data, "REGISTER") {
		t.Errorf("data = %q, must not replay what the sender wrote", data)
	}
	if len(data) > len("bytes=39 head=")+2*payloadExcerptBytes {
		t.Errorf("data = %q, the excerpt is not bounded", data)
	}
	if got[0]["error"] != "EOF" {
		t.Errorf("the parser's own reason must survive, got %v", got[0]["error"])
	}
}

// The volume half: at the default level a healthy call must produce nothing.
func TestTheFilteredMessagesLeaveNothingAtInfo(t *testing.T) {
	log, sink := newLog(t, slog.LevelInfo)
	log.Error("failed to parse", "data", "junk")
	log.Warn("ACK missed", "callid", "abc")
	log.Warn("WS ref went negative", "ref", -1)
	log.Warn("TCP ref went negative", "ref", -1)

	if sink.Len() != 0 {
		t.Fatalf("a healthy call must be silent above debug, got:\n%s", sink.String())
	}
}

func TestAnUnknownMessagePassesThroughUntouched(t *testing.T) {
	log, sink := newLog(t, slog.LevelInfo)
	log.Warn("connection pool not clean cleanup", "error", "boom")

	got := records(t, sink)
	if len(got) != 1 || got[0]["level"] != "WARN" || got[0]["error"] != "boom" {
		t.Fatalf("a message with no rule must reach the handler unchanged: %v", got)
	}
}

func TestTheRateLimitBoundsARepeatedParseFailure(t *testing.T) {
	log, sink := newLog(t, slog.LevelDebug)
	for range 50 {
		log.Error("failed to parse", "data", "junk")
	}

	got := records(t, sink)
	if len(got) != rateLimitBurst {
		t.Fatalf("got %d records, want the burst of %d", len(got), rateLimitBurst)
	}
}

func TestTheNextRecordAfterTheWindowReportsWhatWasSuppressed(t *testing.T) {
	limiter := newLimiter(time.Millisecond, 2)
	for range 10 {
		limiter.allow("failed to parse")
	}
	time.Sleep(2 * time.Millisecond)
	allowed, suppressed := limiter.allow("failed to parse")
	if !allowed {
		t.Fatal("a new window must allow again")
	}
	if suppressed != 8 {
		t.Errorf("suppressed = %d, want the 8 dropped in the previous window", suppressed)
	}
}

func TestTheLimiterTableIsBounded(t *testing.T) {
	limiter := newLimiter(time.Minute, 1)
	for index := range limiterCapacity * 2 {
		limiter.allow(string(rune('a'+index%26)) + itoa(index))
	}
	if len(limiter.buckets) > limiterCapacity {
		t.Fatalf("the limiter holds %d keys, want at most %d", len(limiter.buckets), limiterCapacity)
	}
}

func TestWithAttrsAndWithGroupShareTheLimiter(t *testing.T) {
	var sink bytes.Buffer
	base := Wrap(slog.NewJSONHandler(&sink, &slog.HandlerOptions{Level: slog.LevelDebug}))
	derived := base.WithAttrs([]slog.Attr{slog.String("caller", "TransportLayer")}).(*Handler)
	if derived.limiter != base.limiter {
		t.Error("a derived handler must share the process-wide limit")
	}
	if base.WithGroup("g").(*Handler).limiter != base.limiter {
		t.Error("a grouped handler must share the process-wide limit")
	}
	if !base.Enabled(context.Background(), slog.LevelDebug) {
		t.Error("Enabled must report what the wrapped handler reports")
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
