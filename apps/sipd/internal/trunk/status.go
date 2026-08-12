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
// # Both halves now exist
//
// The EVENT was always there: `TrunkStatusChangedData` is generated in packages/events-go, the
// subject builder is `TrunkSubject`, and the TRUNKS stream carries it to the pbx writer that owns
// the `trunk.status*` columns. What was missing was a GRANT — the `sipd` user could publish
// `sip.reg.v1.>` and two RPC subjects and nothing else, so a publish onto `trunk.evt.v1.>` from this
// process was an authorization violation. That grant is part of this wave, and JetStreamPublisher
// is now the DEFAULT wherever a broker is present (see cmd/sipd).
//
// LogPublisher stays, and not as a vestige. A deployment without a broker — the SIPp rig, an
// integration run, a laptop — still has a registration state machine that changes state, and the
// honest behaviour there is one line per transition carrying every field the event would have had.
// So a deployment either publishes or says loudly that it cannot; it never silently drops a carrier
// outage.
//
// # The subject is derived, not hand-composed
//
// Every family this edge publishes has a named constructor in packages/events-go that derives the
// subject from the payload — `NewRegistrationRegisteredEnvelope`, `NewSIPDialogTerminatedEnvelope` —
// and the trunk family now has `NewTrunkStatusChangedEnvelope` too. statusEnvelope below builds its
// payload and hands it to that constructor rather than composing `TrunkSubject` and `NewEnvelope` by
// hand, so the subject and the payload cannot name different trunks: the constructor is the single
// place that pairs them. The trunk id is a PARAMETER there rather than a payload field, because the
// facts that changed (status, reason, endpoint) are the payload and the identity is the subject's
// job — see the constructor's own note.
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
	// The constructor derives trunk.evt.v1.<orgId>.<trunkId>.status.changed from OrgID + trunkID and
	// pairs it with this payload, so a subject and a body about different trunks cannot be built.
	return contract.NewTrunkStatusChangedEnvelope(trunk.TrunkID,
		contract.EnvelopeInput[contract.TrunkStatusChangedData]{
			OrgID:  trunk.OrgID,
			Source: source,
			At:     at,
			Data:   data,
		})
}

// LogPublisher prints what it would have published.
//
// It is the fallback for a deployment with no broker, not the default any more. Everything the
// JetStream publisher would have put on the wire is in the log line, including the subject, so a
// developer running without NATS can still see that a trunk went down and can still check the
// subject is the one they expect.
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
		"unpublished", "no broker is configured; run with NATS to publish trunk.evt.v1")
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
