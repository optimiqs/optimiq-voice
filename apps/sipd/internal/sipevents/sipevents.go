// Package sipevents publishes sipd's dialog lifecycle (`sip.evt.v1`) onto the SIP stream.
//
// Envelopes are built by packages/events-go; this package adds only the transport. Every publish
// carries the envelope id as Nats-Msg-Id, so a retried `dialog.terminated` becomes one CDR row
// rather than two.
package sipevents

import (
	"context"
	"fmt"
	"slices"
	"sync"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Publisher emits the six `sip.evt.v1` dialog events.
type Publisher interface {
	Progressed(ctx context.Context, envelope contract.Envelope[contract.SIPDialogProgressedData]) error
	Answered(ctx context.Context, envelope contract.Envelope[contract.SIPDialogAnsweredData]) error
	Held(ctx context.Context, envelope contract.Envelope[contract.SIPDialogHeldData]) error
	Resumed(ctx context.Context, envelope contract.Envelope[contract.SIPDialogResumedData]) error
	Terminated(ctx context.Context, envelope contract.Envelope[contract.SIPDialogTerminatedData]) error
	DTMF(ctx context.Context, envelope contract.Envelope[contract.SIPDialogDTMFData]) error
}

// JetStreamPublisher publishes into the SIP stream.
type JetStreamPublisher struct {
	js jetstream.JetStream
}

var _ Publisher = (*JetStreamPublisher)(nil)

// NewJetStreamPublisher wraps an established JetStream context. It does not create the SIP stream;
// provisioning is the control plane's `ensureStreams`.
func NewJetStreamPublisher(js jetstream.JetStream) *JetStreamPublisher {
	return &JetStreamPublisher{js: js}
}

// Progressed publishes a `dialog.progressed` event.
func (p *JetStreamPublisher) Progressed(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogProgressedData],
) error {
	return publish(p.js, envelope)
}

// Answered publishes a `dialog.answered` event.
func (p *JetStreamPublisher) Answered(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogAnsweredData],
) error {
	return publish(p.js, envelope)
}

// Held publishes a `dialog.held` event.
func (p *JetStreamPublisher) Held(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogHeldData],
) error {
	return publish(p.js, envelope)
}

// Resumed publishes a `dialog.resumed` event.
func (p *JetStreamPublisher) Resumed(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogResumedData],
) error {
	return publish(p.js, envelope)
}

// Terminated publishes a `dialog.terminated` event.
func (p *JetStreamPublisher) Terminated(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	return publish(p.js, envelope)
}

// DTMF publishes a `dialog.dtmf` event.
func (p *JetStreamPublisher) DTMF(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogDTMFData],
) error {
	return publish(p.js, envelope)
}

// publish enqueues one envelope asynchronously.
//
// Asynchronous because the caller is the dialog's own goroutine, which serialises every task for
// that call: a synchronous PubAck put a broker round trip between the 180 and the 200 a caller is
// waiting on. Delivery is unchanged — same connection, same Nats-Msg-Id, so the stream still
// de-duplicates — and the failed-ack report moves to the JetStream context's
// WithPublishAsyncErrHandler. sipd never retried a failed publish, so nothing that was durable
// before is less durable now; shutdown waits for the outstanding acks (cmd/sipd) so a drain does
// not drop the `dialog.terminated` a CDR is built from.
//
// CheckSubject stays on this path: the subject carries the legId, and an event applied to the wrong
// leg tears down somebody else's call.
func publish[T any](js jetstream.JetStream, envelope contract.Envelope[T]) error {
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		return fmt.Errorf("sipevents: refusing to publish an inconsistent envelope: %w", err)
	}
	payload, err := contract.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("sipevents: encoding %s: %w", envelope.Type, err)
	}
	if _, err := js.PublishAsync(envelope.Subject, payload, jetstream.WithMsgID(envelope.ID)); err != nil {
		return fmt.Errorf("sipevents: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return nil
}

// RecordingPublisher captures envelopes in memory instead of publishing them.
type RecordingPublisher struct {
	mu         sync.Mutex
	progressed []contract.Envelope[contract.SIPDialogProgressedData]
	answered   []contract.Envelope[contract.SIPDialogAnsweredData]
	held       []contract.Envelope[contract.SIPDialogHeldData]
	resumed    []contract.Envelope[contract.SIPDialogResumedData]
	terminated []contract.Envelope[contract.SIPDialogTerminatedData]
	dtmf       []contract.Envelope[contract.SIPDialogDTMFData]
}

var _ Publisher = (*RecordingPublisher)(nil)

// NewRecordingPublisher returns an empty recorder.
func NewRecordingPublisher() *RecordingPublisher { return &RecordingPublisher{} }

// Progressed implements Publisher.
func (p *RecordingPublisher) Progressed(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogProgressedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.progressed = append(p.progressed, envelope)
	return nil
}

// Answered implements Publisher.
func (p *RecordingPublisher) Answered(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogAnsweredData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.answered = append(p.answered, envelope)
	return nil
}

// Held implements Publisher.
func (p *RecordingPublisher) Held(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogHeldData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.held = append(p.held, envelope)
	return nil
}

// Resumed implements Publisher.
func (p *RecordingPublisher) Resumed(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogResumedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resumed = append(p.resumed, envelope)
	return nil
}

// Terminated implements Publisher.
func (p *RecordingPublisher) Terminated(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.terminated = append(p.terminated, envelope)
	return nil
}

// DTMF implements Publisher.
func (p *RecordingPublisher) DTMF(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogDTMFData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dtmf = append(p.dtmf, envelope)
	return nil
}

// ProgressedEvents returns a copy of the recorded `dialog.progressed` events.
func (p *RecordingPublisher) ProgressedEvents() []contract.Envelope[contract.SIPDialogProgressedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.progressed)
}

// AnsweredEvents returns a copy of the recorded `dialog.answered` events.
func (p *RecordingPublisher) AnsweredEvents() []contract.Envelope[contract.SIPDialogAnsweredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.answered)
}

// HeldEvents returns a copy of the recorded `dialog.held` events.
func (p *RecordingPublisher) HeldEvents() []contract.Envelope[contract.SIPDialogHeldData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.held)
}

// ResumedEvents returns a copy of the recorded `dialog.resumed` events.
func (p *RecordingPublisher) ResumedEvents() []contract.Envelope[contract.SIPDialogResumedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.resumed)
}

// TerminatedEvents returns a copy of the recorded `dialog.terminated` events.
func (p *RecordingPublisher) TerminatedEvents() []contract.Envelope[contract.SIPDialogTerminatedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.terminated)
}

// DTMFEvents returns a copy of the recorded `dialog.dtmf` events.
func (p *RecordingPublisher) DTMFEvents() []contract.Envelope[contract.SIPDialogDTMFData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.dtmf)
}

// Len reports how many events of every kind have been recorded.
func (p *RecordingPublisher) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.progressed) + len(p.answered) + len(p.held) +
		len(p.resumed) + len(p.terminated) + len(p.dtmf)
}
