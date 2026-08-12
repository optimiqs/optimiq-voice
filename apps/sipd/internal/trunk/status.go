package trunk

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Publisher emits `trunk.status.changed`.
//
// # What is here and what is not
//
// The EVENT exists: `TrunkStatusChangedData` is generated in packages/events-go, the subject
// builder is `TrunkSubject`, and the TRUNKS stream carries it to "the pbx writer" that owns the
// `trunk.status*` columns. What does NOT exist is a grant: the `sipd` user in config/nats.conf may
// publish `sip.reg.v1.>` and two RPC subjects and nothing else, so a publish onto `trunk.evt.v1.>`
// from this process is an authorization violation today.
//
// So the interface has two implementations. The JetStream one is correct and will work the moment
// the grant is added; the logging one is the default, and it prints exactly what would have been
// published. A deployment therefore either publishes or says loudly that it cannot — it never
// silently drops a carrier outage.
type Publisher interface {
	StatusChanged(ctx context.Context, trunk Config, status Status, reason string) error
}

// JetStreamPublisher publishes into the TRUNKS stream.
type JetStreamPublisher struct {
	js     jetstream.JetStream
	source string
}

var _ Publisher = (*JetStreamPublisher)(nil)

// NewJetStreamPublisher wraps an established JetStream context. It does NOT create the stream:
// provisioning is the control plane's job, for the reason internal/events already states.
func NewJetStreamPublisher(js jetstream.JetStream, source string) *JetStreamPublisher {
	if source == "" {
		source = "sipd"
	}
	return &JetStreamPublisher{js: js, source: source}
}

// StatusChanged implements Publisher.
func (p *JetStreamPublisher) StatusChanged(
	ctx context.Context,
	trunk Config,
	status Status,
	reason string,
) error {
	envelope, err := statusEnvelope(trunk, status, reason, p.source, time.Now())
	if err != nil {
		return err
	}
	if err := contract.CheckSubject(envelope.Subject, envelope); err != nil {
		return fmt.Errorf("trunk: refusing to publish an inconsistent envelope: %w", err)
	}
	payload, err := contract.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("trunk: encoding %s: %w", envelope.Type, err)
	}
	// The envelope id as Nats-Msg-Id, so a publish retried after a timeout is collapsed by the
	// stream's duplicate window rather than counted twice by the writer that owns the column.
	if _, err := p.js.Publish(ctx, envelope.Subject, payload,
		jetstream.WithMsgID(envelope.ID)); err != nil {
		return fmt.Errorf("trunk: publishing %s on %s: %w", envelope.Type, envelope.Subject, err)
	}
	return nil
}

// statusEnvelope builds the contract envelope. It is separate so a test can assert the exact
// subject and payload without a broker, which is the only way to prove the subject is right before
// the grant exists to try it.
func statusEnvelope(
	trunk Config,
	status Status,
	reason string,
	source string,
	at time.Time,
) (contract.Envelope[contract.TrunkStatusChangedData], error) {
	subject, err := contract.TrunkSubject(trunk.OrgID, trunk.TrunkID, contract.EventTypeTrunkStatusChanged)
	if err != nil {
		return contract.Envelope[contract.TrunkStatusChangedData]{}, err
	}
	value := contract.TrunkStatusChangedStatus(status)
	if !value.Valid() {
		return contract.Envelope[contract.TrunkStatusChangedData]{},
			fmt.Errorf("trunk: %q is not a status the contract knows", status)
	}
	data := contract.TrunkStatusChangedData{Status: value}
	if reason != "" {
		copied := reason
		data.Reason = &copied
	}
	if endpoint := trunk.Registrar; endpoint != "" {
		copied := endpoint
		data.Endpoint = &copied
	}
	return contract.NewEnvelope(contract.EventTypeTrunkStatusChanged,
		contract.EnvelopeInput[contract.TrunkStatusChangedData]{
			OrgID:   trunk.OrgID,
			Subject: subject,
			Source:  source,
			At:      at,
			Data:    data,
		}), nil
}

// LogPublisher prints what it would have published. It is the default until the NATS grant exists.
type LogPublisher struct{ Log *slog.Logger }

var _ Publisher = LogPublisher{}

// StatusChanged implements Publisher.
func (p LogPublisher) StatusChanged(_ context.Context, trunk Config, status Status, reason string) error {
	log := p.Log
	if log == nil {
		log = slog.Default()
	}
	subject, err := contract.TrunkSubject(trunk.OrgID, trunk.TrunkID, contract.EventTypeTrunkStatusChanged)
	if err != nil {
		subject = "trunk.evt.v1.<invalid>"
	}
	log.Info("trunk status changed",
		"trunkId", trunk.TrunkID,
		"orgId", trunk.OrgID,
		"trunk", trunk.Name,
		"status", string(status),
		"reason", reason,
		"subject", subject,
		"unpublished", "the sipd NATS user has no trunk.evt.v1 grant; see the wave report")
	return nil
}

// RecordingPublisher captures transitions in memory instead of publishing them. It backs the unit
// tests.
type RecordingPublisher struct {
	mu       sync.Mutex
	recorded []Transition
}

// Transition is one captured status change.
type Transition struct {
	TrunkID string
	Status  Status
	Reason  string
}

var _ Publisher = (*RecordingPublisher)(nil)

// NewRecordingPublisher returns an empty recorder.
func NewRecordingPublisher() *RecordingPublisher { return &RecordingPublisher{} }

// StatusChanged implements Publisher.
func (p *RecordingPublisher) StatusChanged(_ context.Context, trunk Config, status Status, reason string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.recorded = append(p.recorded, Transition{TrunkID: trunk.TrunkID, Status: status, Reason: reason})
	return nil
}

// Transitions returns a copy of everything recorded.
func (p *RecordingPublisher) Transitions() []Transition {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Transition(nil), p.recorded...)
}
