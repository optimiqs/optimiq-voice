// Package events publishes sipd's registration transitions onto the NATS backbone.
//
// Envelopes are built by packages/events-go; this package adds only the transport. Every publish
// carries the envelope id as Nats-Msg-Id, so a retry is collapsed by the REGISTRATIONS stream's
// duplicate window instead of being counted twice.
package events

import (
	"context"
	"fmt"
	"slices"
	"sync"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Publisher emits registration events.
type Publisher interface {
	Registered(ctx context.Context, envelope contract.Envelope[contract.RegistrationRegisteredData]) error
	Unregistered(ctx context.Context, envelope contract.Envelope[contract.RegistrationUnregisteredData]) error
	Expired(ctx context.Context, envelope contract.Envelope[contract.RegistrationExpiredData]) error
	AuthFailed(ctx context.Context, envelope contract.Envelope[contract.RegistrationAuthFailedData]) error
}

// JetStreamPublisher publishes into the REGISTRATIONS stream.
type JetStreamPublisher struct {
	js jetstream.JetStream
}

var _ Publisher = (*JetStreamPublisher)(nil)

// NewJetStreamPublisher wraps an established JetStream context. It does not create the
// REGISTRATIONS stream; provisioning is the control plane's `ensureStreams`.
func NewJetStreamPublisher(js jetstream.JetStream) *JetStreamPublisher {
	return &JetStreamPublisher{js: js}
}

// Registered publishes a `registered` event.
func (p *JetStreamPublisher) Registered(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationRegisteredData],
) error {
	return publish(p.js, envelope)
}

// Unregistered publishes an `unregistered` event.
func (p *JetStreamPublisher) Unregistered(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationUnregisteredData],
) error {
	return publish(p.js, envelope)
}

// Expired publishes an `expired` event.
func (p *JetStreamPublisher) Expired(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationExpiredData],
) error {
	return publish(p.js, envelope)
}

// AuthFailed publishes an `auth-failed` event.
func (p *JetStreamPublisher) AuthFailed(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationAuthFailedData],
) error {
	return publish(p.js, envelope)
}

// publish enqueues one envelope asynchronously.
//
// Asynchronous because the caller is a SIP handler that has not yet answered the device, and the
// caller has never acted on a publish error beyond logging it. Waiting for the PubAck therefore put
// a broker round trip inside every REGISTER for information nobody used. Delivery is unchanged: the
// message is written on the same connection with the same Nats-Msg-Id, so the stream still
// de-duplicates a retry, and a failed ack is reported through the JetStream context's
// WithPublishAsyncErrHandler rather than through this return. Shutdown waits for the outstanding
// acks (cmd/sipd), so a drain does not drop what a synchronous publish would have delivered.
func publish[T any](js jetstream.JetStream, envelope contract.Envelope[T]) error {
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		return fmt.Errorf("events: refusing to publish an inconsistent envelope: %w", err)
	}
	payload, err := contract.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("events: encoding %s: %w", envelope.Type, err)
	}
	if _, err := js.PublishAsync(envelope.Subject, payload, jetstream.WithMsgID(envelope.ID)); err != nil {
		return fmt.Errorf("events: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return nil
}

// RecordingPublisher captures envelopes in memory instead of publishing them.
type RecordingPublisher struct {
	mu           sync.Mutex
	registered   []contract.Envelope[contract.RegistrationRegisteredData]
	unregistered []contract.Envelope[contract.RegistrationUnregisteredData]
	expired      []contract.Envelope[contract.RegistrationExpiredData]
	authFailed   []contract.Envelope[contract.RegistrationAuthFailedData]
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

// AuthFailed implements Publisher.
func (p *RecordingPublisher) AuthFailed(
	_ context.Context,
	envelope contract.Envelope[contract.RegistrationAuthFailedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.authFailed = append(p.authFailed, envelope)
	return nil
}

// RegisteredEvents returns a copy of the recorded `registered` events.
func (p *RecordingPublisher) RegisteredEvents() []contract.Envelope[contract.RegistrationRegisteredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.registered)
}

// UnregisteredEvents returns a copy of the recorded `unregistered` events.
func (p *RecordingPublisher) UnregisteredEvents() []contract.Envelope[contract.RegistrationUnregisteredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.unregistered)
}

// ExpiredEvents returns a copy of the recorded `expired` events.
func (p *RecordingPublisher) ExpiredEvents() []contract.Envelope[contract.RegistrationExpiredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.expired)
}

// AuthFailedEvents returns a copy of the recorded `auth-failed` events.
func (p *RecordingPublisher) AuthFailedEvents() []contract.Envelope[contract.RegistrationAuthFailedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.authFailed)
}
