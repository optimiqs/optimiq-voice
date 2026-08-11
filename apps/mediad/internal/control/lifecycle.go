package control

import (
	"context"
	"log/slog"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// LifecycleAnnouncer is the TELL half of the media contract: it turns the packet path's session
// transitions into `media.evt.v1.*` events and cleans the session directory behind them.
//
// # Why it is a separate type from Server
//
// The Server answers questions; this announces facts, and they run on different threads for
// different reasons. A handler runs on a NATS callback and its caller is waiting; an announcement
// runs from the reaper or a drain and nobody is. Keeping them apart is what lets the announcement
// path take a two-second publish deadline without any chance of that deadline landing inside a call
// setup.
//
// # Why publishing is asynchronous
//
// `rtp.Manager` calls Lifecycle from the goroutine that is tearing a session down — the reaper's,
// or Drain's. A JetStream publish is a round trip to a broker that may be exactly the thing that has
// gone wrong, so doing it inline would let a sick broker stall a drain, which turns one failure into
// two. The publish is handed to a goroutine and the teardown continues.
//
// The ordering guarantee that matters is preserved anyway: `session.rtp-timeout` is published from
// the same sequence as, and before, the `session.ended` that follows it, and both carry the session
// id, so a consumer that receives them out of order can still make sense of them. JetStream's
// per-subject ordering does the rest, since both land on the same subject prefix.
type LifecycleAnnouncer struct {
	publisher  mediaevents.Publisher
	dir        directory.Store
	log        *slog.Logger
	instanceID string
}

var _ rtp.Lifecycle = (*LifecycleAnnouncer)(nil)

// NewLifecycleAnnouncer builds an announcer. A nil publisher makes it a no-op that still cleans the
// directory, which is what a deployment with events disabled would want.
func NewLifecycleAnnouncer(
	publisher mediaevents.Publisher,
	dir directory.Store,
	instanceID string,
	log *slog.Logger,
) *LifecycleAnnouncer {
	if log == nil {
		log = slog.Default()
	}
	return &LifecycleAnnouncer{publisher: publisher, dir: dir, log: log, instanceID: instanceID}
}

// SessionEnded publishes `session.ended` and removes the directory entry.
//
// The directory delete happens here as well as in the release handler, and that is not redundancy
// for its own sake: a session can end WITHOUT a release — an RTP timeout, the idle reaper, a drain —
// and every one of those paths would otherwise leave an entry pointing at a session that no longer
// exists. The release handler's delete stays because a release for a session this instance never
// had must still clear a stale entry, which this path never sees.
func (a *LifecycleAnnouncer) SessionEnded(session rtp.SessionSummary, reason rtp.EndReason) {
	a.forget(session.SessionID)

	if a.publisher == nil || session.OrgID == "" {
		// No org means no subject to publish on. It cannot happen through the control surface,
		// which refuses an allocate without one; it can happen in a test, and silently dropping is
		// better than building a subject with an empty token.
		return
	}

	envelope, err := a.envelope(session, contract.EventTypeMediaSessionEnded)
	if err != nil {
		a.log.Warn("cannot build a session.ended envelope",
			"sessionId", session.SessionID, "error", err)
		return
	}

	data := contract.MediaSessionEndedData{
		SessionID:       session.SessionID,
		InstanceID:      a.instanceID,
		CallID:          stringPtr(session.CallID),
		LegID:           stringPtr(session.LegID),
		RtpPort:         session.RTPPort,
		PacketsReceived: int(session.Stats.PacketsReceived),
		PacketsSent:     int(session.Stats.PacketsSent),
		Reason:          contract.MediaSessionEndedReason(reason),
		DurationMs:      int(session.Duration.Milliseconds()),
	}

	go a.publish(func(ctx context.Context) error {
		return a.publisher.SessionEnded(ctx, contract.Envelope[contract.MediaSessionEndedData]{
			ID:      envelope.id,
			At:      envelope.at,
			OrgID:   session.OrgID,
			Subject: envelope.subject,
			Type:    contract.EventTypeMediaSessionEnded,
			Source:  mediaevents.Source,
			Data:    data,
		})
	}, "session.ended", session.SessionID)
}

// RTPTimedOut publishes `session.rtp-timeout`.
//
// It does NOT touch the directory: the `session.ended` that immediately follows does, and deleting
// here would mean the entry disappeared before the event that explains why.
func (a *LifecycleAnnouncer) RTPTimedOut(session rtp.SessionSummary, silentFor time.Duration) {
	if a.publisher == nil || session.OrgID == "" {
		return
	}

	envelope, err := a.envelope(session, contract.EventTypeMediaSessionRTPTimeout)
	if err != nil {
		a.log.Warn("cannot build a session.rtp-timeout envelope",
			"sessionId", session.SessionID, "error", err)
		return
	}

	data := contract.MediaSessionRTPTimeoutData{
		SessionID:       session.SessionID,
		InstanceID:      a.instanceID,
		CallID:          stringPtr(session.CallID),
		LegID:           stringPtr(session.LegID),
		RtpPort:         session.RTPPort,
		PacketsReceived: int(session.Stats.PacketsReceived),
		PacketsSent:     int(session.Stats.PacketsSent),
		SilentForMs:     int(silentFor.Milliseconds()),
		RemoteAddress:   stringPtr(session.RemoteAddr),
	}

	go a.publish(func(ctx context.Context) error {
		return a.publisher.SessionRTPTimeout(ctx,
			contract.Envelope[contract.MediaSessionRTPTimeoutData]{
				ID:      envelope.id,
				At:      envelope.at,
				OrgID:   session.OrgID,
				Subject: envelope.subject,
				Type:    contract.EventTypeMediaSessionRTPTimeout,
				Source:  mediaevents.Source,
				Data:    data,
			})
	}, "session.rtp-timeout", session.SessionID)
}

// envelopeHeader is the three values every envelope needs that are derived rather than copied.
type envelopeHeader struct {
	id      string
	at      contract.EventTime
	subject string
}

func (a *LifecycleAnnouncer) envelope(
	session rtp.SessionSummary,
	eventType string,
) (envelopeHeader, error) {
	subject, err := contract.MediaSubject(session.OrgID, session.SessionID, eventType)
	if err != nil {
		return envelopeHeader{}, err
	}
	return envelopeHeader{
		id:      contract.NewEventID(),
		at:      contract.NewEventTime(time.Now()),
		subject: subject,
	}, nil
}

// publish runs one publish under a bounded deadline and logs a failure rather than retrying.
//
// No retry, deliberately. These events describe something that has ALREADY happened to a call that
// is already over; a retry loop would keep a goroutine alive per failed publish exactly when the
// broker is struggling, and JetStream's own duplicate window already handles the case where the
// publish succeeded and the ack was lost.
func (a *LifecycleAnnouncer) publish(do func(context.Context) error, eventType, sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), mediaevents.PublishTimeout)
	defer cancel()
	if err := do(ctx); err != nil {
		a.log.Warn("cannot publish a media lifecycle event",
			"type", eventType, "sessionId", sessionID, "error", err)
	}
}

// forget removes a session's directory entry, best effort.
func (a *LifecycleAnnouncer) forget(sessionID string) {
	if a.dir == nil {
		return
	}
	ctx, cancel := dirContext()
	defer cancel()
	if err := a.dir.Delete(ctx, sessionID); err != nil {
		a.log.Warn("could not remove a session directory entry on teardown",
			"sessionId", sessionID, "error", err)
	}
}
