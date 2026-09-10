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

// AckPublisher is a Publisher that can also report the stream's DURABLE acceptance of a
// `dialog.terminated`. It is optional so a test double need only implement Publisher; a publisher
// that does not implement it cannot release recovery evidence safely (see PublishTerminatedAck).
type AckPublisher interface {
	Publisher
	TerminatedAck(ctx context.Context, envelope contract.Envelope[contract.SIPDialogTerminatedData]) error
}

// PublishTerminatedAck publishes a termination and waits for the stream to accept it. A publisher
// with no acknowledgement path falls back to the unacknowledged publish and says so, because
// pretending it was durable is what makes a claim deletion lose a CDR.
func PublishTerminatedAck(
	ctx context.Context,
	publisher Publisher,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	if acked, ok := publisher.(AckPublisher); ok {
		return acked.TerminatedAck(ctx, envelope)
	}
	return publisher.Terminated(ctx, envelope)
}

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

var _ AckPublisher = (*JetStreamPublisher)(nil)

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
	_, err := publish(p.js, envelope)
	return err
}

// Answered publishes a `dialog.answered` event.
func (p *JetStreamPublisher) Answered(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogAnsweredData],
) error {
	_, err := publish(p.js, envelope)
	return err
}

// Held publishes a `dialog.held` event.
func (p *JetStreamPublisher) Held(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogHeldData],
) error {
	_, err := publish(p.js, envelope)
	return err
}

// Resumed publishes a `dialog.resumed` event.
func (p *JetStreamPublisher) Resumed(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogResumedData],
) error {
	_, err := publish(p.js, envelope)
	return err
}

// Terminated publishes a `dialog.terminated` event without waiting for the stream to accept it. It
// is called from the dialog's own goroutine, which must not sit on a broker round trip; the recovery
// claim that outlives the call is released by TerminatedAck instead (see Finalizer).
func (p *JetStreamPublisher) Terminated(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	_, err := publish(p.js, envelope)
	return err
}

// TerminatedAck implements AckPublisher: it publishes and waits for the stream's acknowledgement,
// so a caller can delete recovery evidence knowing the termination is durable.
func (p *JetStreamPublisher) TerminatedAck(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	future, err := publish(p.js, envelope)
	if err != nil {
		return err
	}
	select {
	case <-future.Ok():
		return nil
	case err := <-future.Err():
		return fmt.Errorf("sipevents: %s on %s was not acknowledged: %w",
			envelope.Type, envelope.Subject, err)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DTMF publishes a `dialog.dtmf` event.
func (p *JetStreamPublisher) DTMF(
	_ context.Context,
	envelope contract.Envelope[contract.SIPDialogDTMFData],
) error {
	_, err := publish(p.js, envelope)
	return err
}

// publish enqueues one envelope asynchronously.
//
// Asynchronous because the caller is the dialog's own goroutine, which serialises every task for
// that call: a synchronous PubAck put a broker round trip between the 180 and the 200 a caller is
// waiting on. A failed ack is reported by the JetStream context's WithPublishAsyncErrHandler, and
// shutdown waits for the outstanding acks (cmd/sipd). The one event whose durability something else
// depends on — `dialog.terminated`, which releases the leg's recovery claim — is published through
// Finalizer, which waits for the acknowledgement and retries.
//
// CheckSubject stays on this path: the subject carries the legId, and an event applied to the wrong
// leg tears down somebody else's call.
//
// The returned future is how TerminatedAck turns this into an acknowledged publish; every other
// caller drops it.
func publish[T any](js jetstream.JetStream, envelope contract.Envelope[T]) (jetstream.PubAckFuture, error) {
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		return nil, fmt.Errorf("sipevents: refusing to publish an inconsistent envelope: %w", err)
	}
	payload, err := contract.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("sipevents: encoding %s: %w", envelope.Type, err)
	}
	future, err := js.PublishAsync(envelope.Subject, payload, jetstream.WithMsgID(envelope.ID))
	if err != nil {
		return nil, fmt.Errorf("sipevents: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return future, nil
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

var _ AckPublisher = (*RecordingPublisher)(nil)

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

// TerminatedAck implements AckPublisher: a recorded event is durable by construction.
func (p *RecordingPublisher) TerminatedAck(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	return p.Terminated(ctx, envelope)
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
