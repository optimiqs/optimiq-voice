package events

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// The subject carries the major version: a breaking payload change ships as a new subject version
// and v1 is never broken in place. Within a major version change is ADDITIVE ONLY, so consumers
// tolerate unknown keys; cdr.leg.write goes further and passes them THROUGH (see the Extra field on
// CDRLegWriteData).

// EnvelopeMajor mirrors the v1 token in every subject.
const EnvelopeMajor = 1

// EventTime is an ISO-8601 UTC instant with millisecond precision.
//
// It marshals to exactly the shape JavaScript's Date.prototype.toISOString() produces, so a Go and
// a TypeScript producer emit byte-identical timestamps for the same instant; plain time.Time would
// marshal with variable fractional digits.
type EventTime struct {
	time.Time
}

const eventTimeLayout = "2006-01-02T15:04:05.000Z07:00"

// NewEventTime truncates t to millisecond precision in UTC.
func NewEventTime(t time.Time) EventTime {
	return EventTime{Time: t.UTC().Truncate(time.Millisecond)}
}

// MarshalJSON writes the instant as an ISO-8601 UTC string with millisecond precision.
func (t EventTime) MarshalJSON() ([]byte, error) {
	return json.Marshal(t.Time.UTC().Format(eventTimeLayout))
}

// UnmarshalJSON accepts any RFC 3339 instant, including the offsets and precisions other producers
// may use; it is only this package's OUTPUT that is pinned.
func (t *EventTime) UnmarshalJSON(data []byte) error {
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return fmt.Errorf("envelope `at` is not an RFC 3339 instant: %w", err)
	}
	t.Time = parsed.UTC()
	return nil
}

// Envelope is one event on the backbone, parameterised by its payload type.
//
// Use Envelope[json.RawMessage] to decode a message before its type is known, then NewDataFor plus
// json.Unmarshal to reach the concrete payload.
type Envelope[T any] struct {
	// ID is a UUID v7 — time-ordered, and the idempotency key consumers dedupe on. Publish it as
	// the Nats-Msg-Id header so JetStream suppresses a retried duplicate inside the stream's
	// duplicate window.
	ID string `json:"id"`
	// At is when the thing HAPPENED, never when it was ingested.
	At EventTime `json:"at"`
	// OrgID is the tenant; it always equals the subject's org token.
	OrgID string `json:"orgId"`
	// Subject is the subject the event is published on, carried so a replayed file is
	// self-describing.
	Subject string `json:"subject"`
	// Type is the discriminator, unique within the family the subject selects.
	Type string `json:"type"`
	// Source is the publishing service: engine, api, sipd, mediad, autopilot, …
	Source string `json:"source"`
	// TraceID is the W3C trace id when the event was produced inside a traced request.
	TraceID string `json:"traceId,omitempty"`
	// CorrelationID correlates a command with the events it caused.
	CorrelationID string `json:"correlationId,omitempty"`
	Data          T      `json:"data"`
}

// EnvelopeInput is everything a caller supplies. ID and At are filled in when omitted.
type EnvelopeInput[T any] struct {
	OrgID   string
	Subject string
	Source  string
	Data    T
	// ID defaults to a fresh UUID v7. Supply it to make a retry idempotent.
	ID string
	// At defaults to now. Supply the instant the thing HAPPENED whenever it is known.
	At time.Time
	// TraceID and CorrelationID are optional.
	TraceID       string
	CorrelationID string
}

// NewEventID returns a fresh UUID v7: time-ordered, so ids sort by creation, and unique enough to
// be the broker's dedupe key.
func NewEventID() string {
	id, err := uuid.NewV7()
	if err != nil {
		// NewV7 only fails if crypto/rand fails, which is not a recoverable condition.
		panic(fmt.Sprintf("events: cannot generate a UUID v7: %v", err))
	}
	return id.String()
}

// eventIDNamespace names the derived-id space. A fixed UUID, so the same facts produce the same id
// in every process and across restarts.
var eventIDNamespace = uuid.MustParse("6f9d6f6f-2f1f-4b8a-9d5f-2f0a6a1c7b21")

// DerivedEventID returns the id an event carries when a retry must reuse it: a UUID v5 over the
// facts that identify the OCCURRENCE, not the attempt. It is what makes the broker's Nats-Msg-Id
// dedupe window collapse two publications of the same event — two reapers acting on one orphan, or
// a republish after a failed claim deletion — into one message.
func DerivedEventID(parts ...string) string {
	return uuid.NewSHA1(eventIDNamespace, []byte(strings.Join(parts, "\x00"))).String()
}

// NewEnvelope assembles an envelope, defaulting ID to a fresh UUID v7 and At to now.
func NewEnvelope[T any](eventType string, in EnvelopeInput[T]) Envelope[T] {
	id := in.ID
	if id == "" {
		id = NewEventID()
	}
	at := in.At
	if at.IsZero() {
		at = time.Now()
	}
	return Envelope[T]{
		ID:            id,
		At:            NewEventTime(at),
		OrgID:         in.OrgID,
		Subject:       in.Subject,
		Type:          eventType,
		Source:        in.Source,
		TraceID:       in.TraceID,
		CorrelationID: in.CorrelationID,
		Data:          in.Data,
	}
}

// Marshal encodes an envelope for the wire.
func Marshal[T any](envelope Envelope[T]) ([]byte, error) {
	return json.Marshal(envelope)
}

// Unmarshal decodes a wire message into an envelope with a known payload type.
func Unmarshal[T any](data []byte) (Envelope[T], error) {
	var envelope Envelope[T]
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Envelope[T]{}, err
	}
	return envelope, nil
}

// UnmarshalRaw decodes a wire message far enough to route it, leaving the payload untouched.
func UnmarshalRaw(data []byte) (Envelope[json.RawMessage], error) {
	return Unmarshal[json.RawMessage](data)
}

// CheckSubject asserts that an envelope agrees with the subject it was delivered on.
//
// It catches the two mistakes that survive schema validation: an event published on the wrong
// subject, and an envelope whose orgId is not the org in its subject — which would let a consumer
// scope a write to the wrong tenant.
func CheckSubject[T any](subject string, envelope Envelope[T]) error {
	if envelope.Subject != subject {
		return fmt.Errorf(
			"envelope subject %q does not match the delivery subject %q",
			envelope.Subject, subject,
		)
	}
	parsed, ok := ParseSubject(subject)
	if ok && parsed.Kind != KindRPC && parsed.OrgID != envelope.OrgID {
		return fmt.Errorf(
			"envelope orgId %q does not match the subject's org token %q",
			envelope.OrgID, parsed.OrgID,
		)
	}
	return nil
}
