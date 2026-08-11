// Package events publishes mediad's session lifecycle onto the NATS backbone.
//
// Every envelope is built from packages/events-go, so the subject, the payload shape and the
// session-id-matches-subject invariant are the ones the TypeScript services enforce. This package
// adds only the transport: a JetStream publish with the envelope id as Nats-Msg-Id, which is what
// makes a retried publish idempotent inside the MEDIA stream's duplicate window. It is deliberately
// the same shape as apps/sipd/internal/events.
//
// # Why JetStream when the commands are core
//
// "Ask over core, tell over JetStream", the split the whole backbone uses. A command is a
// synchronous question inside a call setup whose answer is worthless a second later. A session
// ending is a fact about a call that outlives the moment it happened — it is the evidence for "why
// did that call go quiet", asked hours later by somebody holding a support ticket. Fire-and-forget
// would make that evidence the one thing a broker restart deletes.
//
// The engine still reads these with a CORE subscription, and that is not a contradiction: a
// JetStream publish IS a publish, so a core subscriber sees it live while the stream keeps it for
// whoever needs it later. The engine wants the former — a leg to tear down NOW — and must not pay
// for a durable consumer's ack round trip on the call path to get it.
package events

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Source is the `source` field every envelope from this process carries.
const Source = "mediad"

// Publisher emits media session events.
//
// One method per event rather than a generic one: the payloads are distinct types, and a caller
// that has to name the type it is publishing cannot publish the wrong one by accident.
type Publisher interface {
	SessionEnded(ctx context.Context, envelope contract.Envelope[contract.MediaSessionEndedData]) error
	SessionRTPTimeout(ctx context.Context, envelope contract.Envelope[contract.MediaSessionRTPTimeoutData]) error
	PlaybackFinished(ctx context.Context, envelope contract.Envelope[contract.MediaPlaybackFinishedData]) error
	RecordingFinished(ctx context.Context, envelope contract.Envelope[contract.MediaRecordingFinishedData]) error
}

// JetStreamPublisher publishes into the MEDIA stream.
type JetStreamPublisher struct {
	js jetstream.JetStream
}

var _ Publisher = (*JetStreamPublisher)(nil)

// NewJetStreamPublisher wraps an established JetStream context.
//
// It does NOT create the MEDIA stream. Stream provisioning is `ensureStreams` in packages/events,
// run once by the control plane; a data-plane process that created its own streams could silently
// bring one up with the wrong retention and lose events nobody notices.
func NewJetStreamPublisher(js jetstream.JetStream) *JetStreamPublisher {
	return &JetStreamPublisher{js: js}
}

// SessionEnded publishes a `session.ended` event.
func (p *JetStreamPublisher) SessionEnded(
	ctx context.Context,
	envelope contract.Envelope[contract.MediaSessionEndedData],
) error {
	return publish(ctx, p.js, envelope)
}

// SessionRTPTimeout publishes a `session.rtp-timeout` event.
func (p *JetStreamPublisher) SessionRTPTimeout(
	ctx context.Context,
	envelope contract.Envelope[contract.MediaSessionRTPTimeoutData],
) error {
	return publish(ctx, p.js, envelope)
}

// PlaybackFinished publishes a `playback.finished` event.
func (p *JetStreamPublisher) PlaybackFinished(
	ctx context.Context,
	envelope contract.Envelope[contract.MediaPlaybackFinishedData],
) error {
	return publish(ctx, p.js, envelope)
}

// RecordingFinished publishes a `recording.finished` event.
func (p *JetStreamPublisher) RecordingFinished(
	ctx context.Context,
	envelope contract.Envelope[contract.MediaRecordingFinishedData],
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
	// WithMsgID sets Nats-Msg-Id. The envelope id is generated once per transition, so a publish
	// retried after a timeout is collapsed by the stream rather than counted twice by whatever is
	// tallying media failures.
	if _, err := js.Publish(ctx, envelope.Subject, payload, jetstream.WithMsgID(envelope.ID)); err != nil {
		return fmt.Errorf("events: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return nil
}

// PublishTimeout bounds one publish.
//
// A session ending must not be able to block a drain: the whole point of announcing it is that
// somebody downstream learns about a call that has already lost audio, and waiting on a sick broker
// to say so would turn one failure into two.
const PublishTimeout = 2 * time.Second

// RecordingPublisher captures envelopes in memory instead of publishing them. It backs the unit
// tests, exactly as sipd's does.
type RecordingPublisher struct {
	mu         sync.Mutex
	ended      []contract.Envelope[contract.MediaSessionEndedData]
	timedOut   []contract.Envelope[contract.MediaSessionRTPTimeoutData]
	playbacks  []contract.Envelope[contract.MediaPlaybackFinishedData]
	recordings []contract.Envelope[contract.MediaRecordingFinishedData]
}

var _ Publisher = (*RecordingPublisher)(nil)

// NewRecordingPublisher returns an empty recorder.
func NewRecordingPublisher() *RecordingPublisher { return &RecordingPublisher{} }

// SessionEnded implements Publisher.
func (p *RecordingPublisher) SessionEnded(
	_ context.Context,
	envelope contract.Envelope[contract.MediaSessionEndedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ended = append(p.ended, envelope)
	return nil
}

// SessionRTPTimeout implements Publisher.
func (p *RecordingPublisher) SessionRTPTimeout(
	_ context.Context,
	envelope contract.Envelope[contract.MediaSessionRTPTimeoutData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.timedOut = append(p.timedOut, envelope)
	return nil
}

// PlaybackFinished implements Publisher.
func (p *RecordingPublisher) PlaybackFinished(
	_ context.Context,
	envelope contract.Envelope[contract.MediaPlaybackFinishedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.playbacks = append(p.playbacks, envelope)
	return nil
}

// RecordingFinished implements Publisher.
func (p *RecordingPublisher) RecordingFinished(
	_ context.Context,
	envelope contract.Envelope[contract.MediaRecordingFinishedData],
) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.recordings = append(p.recordings, envelope)
	return nil
}

// RecordingEvents returns a copy of the recorded `recording.finished` events.
func (p *RecordingPublisher) RecordingEvents() []contract.Envelope[contract.MediaRecordingFinishedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.MediaRecordingFinishedData](nil), p.recordings...)
}

// PlaybackEvents returns a copy of the recorded `playback.finished` events.
func (p *RecordingPublisher) PlaybackEvents() []contract.Envelope[contract.MediaPlaybackFinishedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.MediaPlaybackFinishedData](nil), p.playbacks...)
}

// EndedEvents returns a copy of the recorded `session.ended` events.
func (p *RecordingPublisher) EndedEvents() []contract.Envelope[contract.MediaSessionEndedData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.MediaSessionEndedData](nil), p.ended...)
}

// TimeoutEvents returns a copy of the recorded `session.rtp-timeout` events.
func (p *RecordingPublisher) TimeoutEvents() []contract.Envelope[contract.MediaSessionRTPTimeoutData] {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]contract.Envelope[contract.MediaSessionRTPTimeoutData](nil), p.timedOut...)
}
