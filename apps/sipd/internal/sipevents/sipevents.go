// Package sipevents publishes sipd's dialog lifecycle onto the NATS backbone.
//
// It is the exact mirror of internal/events one family over: every envelope is built by
// packages/events-go, so the subject, the payload shape and the legId-derived-from-payload
// invariant are the same ones the TypeScript services enforce, and this package adds only the
// transport — a JetStream publish with the envelope id as Nats-Msg-Id.
//
// # Why a package of its own and not a second file in internal/events
//
// Two families, two streams, two grants. `sip.reg.v1` goes to REGISTRATIONS and describes a device;
// `sip.evt.v1` goes to SIP and describes a call, at two orders of magnitude more volume and with a
// retention need — a `dialog.terminated` is CDR evidence — that a registration transition does not
// have. A single Publisher interface carrying nine methods across two streams would be one type
// whose failure modes an operator has to disentangle at three in the morning.
//
// # Why six methods and not one generic
//
// The reason internal/events gives for its three, and it is stronger here: the six payloads are
// distinct generated structs with no common interface, a type-set constraint cannot reach their
// fields, and a caller that has to NAME the type it is publishing cannot publish a `dialog.held`
// under a `dialog.answered`'s subject by accident. Explicit beats clever, and the vocabulary is
// closed by the contract rather than by this package's opinion.
package sipevents

import (
	"context"
	"fmt"
	"sync"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Publisher emits the six `sip.evt.v1` dialog events.
//
// apps/sipd is the only producer of these and the engine is the only consumer, which is what makes
// a closed six-method interface reasonable: there is no third party who might want a seventh.
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

// NewJetStreamPublisher wraps an established JetStream context.
//
// It does NOT create the SIP stream. Stream provisioning is `ensureStreams` in packages/events, run
// once by the control plane; a data-plane edge that created its own streams could silently bring
// one up with the wrong retention and lose the terminations a CDR is built from — which is a class
// of loss nobody notices until a month-end invoice is short.
func NewJetStreamPublisher(js jetstream.JetStream) *JetStreamPublisher {
	return &JetStreamPublisher{js: js}
}

// Progressed publishes a `dialog.progressed` event.
func (p *JetStreamPublisher) Progressed(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogProgressedData],
) error {
	return publish(ctx, p.js, envelope)
}

// Answered publishes a `dialog.answered` event.
func (p *JetStreamPublisher) Answered(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogAnsweredData],
) error {
	return publish(ctx, p.js, envelope)
}

// Held publishes a `dialog.held` event.
func (p *JetStreamPublisher) Held(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogHeldData],
) error {
	return publish(ctx, p.js, envelope)
}

// Resumed publishes a `dialog.resumed` event.
func (p *JetStreamPublisher) Resumed(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogResumedData],
) error {
	return publish(ctx, p.js, envelope)
}

// Terminated publishes a `dialog.terminated` event.
func (p *JetStreamPublisher) Terminated(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	return publish(ctx, p.js, envelope)
}

// DTMF publishes a `dialog.dtmf` event.
func (p *JetStreamPublisher) DTMF(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogDTMFData],
) error {
	return publish(ctx, p.js, envelope)
}

func publish[T any](
	ctx context.Context,
	js jetstream.JetStream,
	envelope contract.Envelope[T],
) error {
	// CheckSubject refuses an envelope whose subject and payload disagree. It matters more on this
	// family than on any other: the subject carries the legId, and an event applied to the wrong leg
	// tears down somebody else's call.
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		return fmt.Errorf("sipevents: refusing to publish an inconsistent envelope: %w", err)
	}
	payload, err := contract.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("sipevents: encoding %s: %w", envelope.Type, err)
	}
	// WithMsgID sets Nats-Msg-Id. The envelope id is a UUID v7 generated once per transition, so a
	// publish retried after a timeout is collapsed by the stream's duplicate window rather than
	// counted twice — and on `dialog.terminated` "counted twice" is two CDR rows for one call.
	if _, err := js.Publish(ctx, envelope.Subject, payload, jetstream.WithMsgID(envelope.ID)); err != nil {
		return fmt.Errorf("sipevents: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return nil
}

// RecordingPublisher captures envelopes in memory instead of publishing them. It backs the unit
// tests, which is the only way to assert an exact subject and payload without a broker.
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
	return append([]contract.Envelope[contract.SIPDialogProgressedData](nil), p.progressed...)
}

// AnsweredEvents returns a copy of the recorded `dialog.answered` events.
func (p *RecordingPublisher) AnsweredEvents() []contract.Envelope[contract.SIPDialogAnsweredData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.SIPDialogAnsweredData](nil), p.answered...)
}

// HeldEvents returns a copy of the recorded `dialog.held` events.
func (p *RecordingPublisher) HeldEvents() []contract.Envelope[contract.SIPDialogHeldData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.SIPDialogHeldData](nil), p.held...)
}

// ResumedEvents returns a copy of the recorded `dialog.resumed` events.
func (p *RecordingPublisher) ResumedEvents() []contract.Envelope[contract.SIPDialogResumedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.SIPDialogResumedData](nil), p.resumed...)
}

// TerminatedEvents returns a copy of the recorded `dialog.terminated` events.
func (p *RecordingPublisher) TerminatedEvents() []contract.Envelope[contract.SIPDialogTerminatedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.SIPDialogTerminatedData](nil), p.terminated...)
}

// DTMFEvents returns a copy of the recorded `dialog.dtmf` events.
func (p *RecordingPublisher) DTMFEvents() []contract.Envelope[contract.SIPDialogDTMFData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.SIPDialogDTMFData](nil), p.dtmf...)
}

// Len reports how many events of every kind have been recorded, which is what a test asserting
// "exactly one terminal event" actually wants to compare.
func (p *RecordingPublisher) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.progressed) + len(p.answered) + len(p.held) +
		len(p.resumed) + len(p.terminated) + len(p.dtmf)
}
