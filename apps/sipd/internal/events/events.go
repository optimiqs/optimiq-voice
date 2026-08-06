// Package events publishes sipd's registration transitions onto the NATS backbone.
//
// Every envelope is built by packages/events-go, so the subject, the payload shape and the
// aorHash-derived-from-aor invariant are the same ones the TypeScript services enforce. This
// package adds only the transport: a JetStream publish with the envelope id as Nats-Msg-Id, which
// is what makes a retried publish idempotent inside the REGISTRATIONS stream's duplicate window.
package events

import (
	"context"
	"fmt"
	"sync"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Publisher emits registration events.
//
// One method per event rather than a generic one: the three payloads are distinct types, and a
// caller that has to name the type it is publishing cannot publish the wrong one by accident.
type Publisher interface {
	Registered(ctx context.Context, envelope contract.Envelope[contract.RegistrationRegisteredData]) error
	Unregistered(ctx context.Context, envelope contract.Envelope[contract.RegistrationUnregisteredData]) error
	Expired(ctx context.Context, envelope contract.Envelope[contract.RegistrationExpiredData]) error
}

// JetStreamPublisher publishes into the REGISTRATIONS stream.
type JetStreamPublisher struct {
	js jetstream.JetStream
}

var _ Publisher = (*JetStreamPublisher)(nil)

// NewJetStreamPublisher wraps an established JetStream context.
//
// It does NOT create the REGISTRATIONS stream. Stream provisioning is `ensureStreams` in
// packages/events, run once by the control plane; a data-plane edge that created its own streams
// could silently bring one up with the wrong retention and lose events nobody notices.
func NewJetStreamPublisher(js jetstream.JetStream) *JetStreamPublisher {
	return &JetStreamPublisher{js: js}
}

// Registered publishes a `registered` event.
func (p *JetStreamPublisher) Registered(
	ctx context.Context,
	envelope contract.Envelope[contract.RegistrationRegisteredData],
) error {
	return publish(ctx, p.js, envelope)
}

// Unregistered publishes an `unregistered` event.
func (p *JetStreamPublisher) Unregistered(
	ctx context.Context,
	envelope contract.Envelope[contract.RegistrationUnregisteredData],
) error {
	return publish(ctx, p.js, envelope)
}

// Expired publishes an `expired` event.
func (p *JetStreamPublisher) Expired(
	ctx context.Context,
	envelope contract.Envelope[contract.RegistrationExpiredData],
) error {
	return publish(ctx, p.js, envelope)
}

func publish[T any](
	ctx context.Context,
	js jetstream.JetStream,
	envelope contract.Envelope[T],
) error {
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		return fmt.Errorf("events: refusing to publish an inconsistent envelope: %w", err)
	}
	payload, err := contract.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("events: encoding %s: %w", envelope.Type, err)
	}
	// WithMsgID sets Nats-Msg-Id. The envelope id is a UUID v7 generated once per transition, so a
	// publish retried after a timeout is collapsed by the stream rather than double-counted by the
	// anti-fraud consumer.
	if _, err := js.Publish(ctx, envelope.Subject, payload, jetstream.WithMsgID(envelope.ID)); err != nil {
		return fmt.Errorf("events: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return nil
}

// RecordingPublisher captures envelopes in memory instead of publishing them. It backs the unit
// tests and the `--dry-run` style local mode.
type RecordingPublisher struct {
	mu           sync.Mutex
	registered   []contract.Envelope[contract.RegistrationRegisteredData]
	unregistered []contract.Envelope[contract.RegistrationUnregisteredData]
	expired      []contract.Envelope[contract.RegistrationExpiredData]
}

var _ Publisher = (*RecordingPublisher)(nil)

// NewRecordingPublisher returns an empty recorder.
func NewRecordingPublisher() *RecordingPublisher { return &RecordingPublisher{} }

// Registered implements Publisher.
func (p *RecordingPublisher) Registered(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationRegisteredData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.registered = append(p.registered, envelope)
	return nil
}

// Unregistered implements Publisher.
func (p *RecordingPublisher) Unregistered(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationUnregisteredData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.unregistered = append(p.unregistered, envelope)
	return nil
}

// Expired implements Publisher.
func (p *RecordingPublisher) Expired(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationExpiredData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.expired = append(p.expired, envelope)
	return nil
}

// Registered returns a copy of the recorded `registered` events.
func (p *RecordingPublisher) RegisteredEvents() []contract.Envelope[contract.RegistrationRegisteredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.RegistrationRegisteredData](nil), p.registered...)
}

// UnregisteredEvents returns a copy of the recorded `unregistered` events.
func (p *RecordingPublisher) UnregisteredEvents() []contract.Envelope[contract.RegistrationUnregisteredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.RegistrationUnregisteredData](nil), p.unregistered...)
}

// ExpiredEvents returns a copy of the recorded `expired` events.
func (p *RecordingPublisher) ExpiredEvents() []contract.Envelope[contract.RegistrationExpiredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.RegistrationExpiredData](nil), p.expired...)
}
