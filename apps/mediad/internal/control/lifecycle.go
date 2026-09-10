package control

import (
	"context"
	"log/slog"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/ackpub"
)

// LifecycleAnnouncer is the TELL half of the media contract: it turns the packet path's session
// transitions into `media.evt.v1.*` events and cleans the session directory behind them.
//
// It is separate from Server because the two run on different threads: a handler runs on a NATS
// callback with its caller waiting, while an announcement runs from the reaper or a drain with
// nobody waiting, so the announcement path can take a two-second publish deadline.
//
// Publishing is asynchronous because rtp.Manager calls this from the goroutine tearing a session
// down; an inline round trip would let a sick broker stall a drain. Order is preserved per SESSION
// rather than per goroutine (see ackpub): `recording.finished` reaches the broker before the
// `session.ended` that follows it, and two DTMF digits reach it in the order they were pressed.
type LifecycleAnnouncer struct {
	publisher  mediaevents.Publisher
	dir        directory.Store
	log        *slog.Logger
	instanceID string

	// events orders and retries the publishes. It is what a shutdown waits on: otherwise the process
	// exits under publishes that never reached the broker, losing the `session.ended` for every
	// drained call.
	events *ackpub.Publisher
}

// The publisher's capacity. Concurrency bounds how many publishes talk to the broker at once — a
// mass reap otherwise puts hundreds of concurrent JetStream publishes on a broker that is quite
// possibly already unwell — and the pending limits bound what waits behind them.
const (
	lifecyclePublishConcurrency = 8
	lifecyclePendingEvents      = 4096
	lifecyclePendingPerSession  = 64
	// lifecyclePublishAttempts and lifecyclePublishBackoff apply to CRITICAL events only: the ones a
	// consumer's workflow is blocked on. Telemetry is attempted once.
	lifecyclePublishAttempts = 3
	lifecyclePublishBackoff  = 200 * time.Millisecond
)

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
	events, err := ackpub.New(ackpub.Options{
		MaxConcurrent:    lifecyclePublishConcurrency,
		MaxPending:       lifecyclePendingEvents,
		MaxPendingPerKey: lifecyclePendingPerSession,
		Timeout:          mediaevents.PublishTimeout,
		Attempts:         lifecyclePublishAttempts,
		Backoff:          lifecyclePublishBackoff,
		Logger:           log,
	})
	if err != nil {
		// Only a non-positive limit reaches this, which would be a constant edited to zero.
		panic("control: " + err.Error())
	}
	return &LifecycleAnnouncer{
		publisher:  publisher,
		dir:        dir,
		log:        log,
		instanceID: instanceID,
		events:     events,
	}
}

// publishAsync hands a publish over, ordered behind this session's earlier events and bounded by
// the publisher's capacity.
//
// The hand-off itself never blocks the caller, which is the whole point: this runs on the goroutine
// tearing a session down, and a sick broker must not be able to stall a drain. eventID is the
// envelope's own id and stays the same across a retry, so a re-delivered critical event lands in
// JetStream's duplicate window rather than twice in the call's history.
func (a *LifecycleAnnouncer) publishAsync(
	do func(context.Context) error,
	eventType, sessionID, eventID string,
	critical bool,
) {
	err := a.events.Publish(ackpub.Event{
		ID:       eventID,
		Key:      sessionID,
		Type:     eventType,
		Critical: critical,
		Publish:  do,
	})
	if err != nil {
		a.log.Error("dropping a media lifecycle event at admission",
			"type", eventType, "sessionId", sessionID, "eventId", eventID, "error", err)
	}
}

// Wait closes admission and blocks until every handed-off publish has finished or the context
// expires, reporting whether they all finished. Called on shutdown, after the manager has drained
// and before the NATS connection goes away — closing admission here is what stops a late announcer
// from outrunning the drain.
func (a *LifecycleAnnouncer) Wait(ctx context.Context) bool {
	a.events.Close()
	return a.events.Wait(ctx)
}

// SessionEnded publishes `session.ended` and removes the directory entry.
//
// The directory delete happens here as well as in the release handler: a session can end WITHOUT a
// release — an RTP timeout, the idle reaper, a drain — and each of those would otherwise leave an
// entry pointing at a session that no longer exists. The release handler's delete stays because a
// release for a session this instance never had must still clear a stale entry.
func (a *LifecycleAnnouncer) SessionEnded(session rtp.SessionSummary, reason rtp.EndReason) {
	a.forget(session.SessionID)

	if a.publisher == nil || session.OrgID == "" {
		// No org means no subject to publish on. Unreachable through the control surface, which refuses
		// an allocate without one; dropping silently beats building a subject with an empty token.
		return
	}

	envelope, err := a.envelope(session, contract.EventTypeMediaSessionEnded)
	if err != nil {
		a.log.Warn("cannot build a session.ended envelope",
			"sessionId", session.SessionID, "error", err)
		return
	}

	quality := qualityOf(session.Quality)
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
		Quality:         &quality,
	}

	a.publishAsync(func(ctx context.Context) error {
		return a.publisher.SessionEnded(ctx, contract.Envelope[contract.MediaSessionEndedData]{
			ID:      envelope.id,
			At:      envelope.at,
			OrgID:   session.OrgID,
			Subject: envelope.subject,
			Type:    contract.EventTypeMediaSessionEnded,
			Source:  mediaevents.Source,
			Data:    data,
		})
	}, "session.ended", session.SessionID, envelope.id, true)
}

// qualityOf carries the RTCP view of a leg onto the wire.
//
// The struct is ALWAYS sent, never elided on all-zeroes: `reportsReceived: 0` is a fact about the
// ENDPOINT — it sends no RTCP — and differs from the field being absent, which is what a media plane
// with no RTCP at all produces.
func qualityOf(quality rtp.QualityStats) contract.MediaSessionEndedQuality {
	return contract.MediaSessionEndedQuality{
		InboundJitterMs:      quality.InboundJitterMs,
		ReportedLossFraction: quality.ReportedLossFraction,
		ReportedLossTotal:    int(quality.ReportedLossTotal),
		ReportedJitterMs:     quality.ReportedJitterMs,
		RoundTripMs:          quality.RoundTripMs,
		ReportsReceived:      int(quality.ReportsReceived),
		ReportsSent:          int(quality.ReportsSent),
		Malformed:            int(quality.Malformed),
		LastReportUnixMs:     int(quality.LastReportUnixMs),
	}
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

	a.publishAsync(func(ctx context.Context) error {
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
	}, "session.rtp-timeout", session.SessionID, envelope.id, false)
}

// PlaybackFinished publishes `playback.finished`.
//
// Nothing branches on it: `MediaPort.play` returns the moment audio starts and the engine's
// `MediaEvent` union has no playback member. It is published for the `error` reason — a failed
// playback is a caller sitting in silence on an otherwise healthy call, and nothing else on this
// backbone records that.
//
// It does NOT touch the session directory: a prompt ending is not a session ending.
func (a *LifecycleAnnouncer) PlaybackFinished(
	session rtp.SessionSummary,
	playback rtp.PlaybackSummary,
) {
	if a.publisher == nil || session.OrgID == "" {
		return
	}

	envelope, err := a.envelope(session, contract.EventTypeMediaPlaybackFinished)
	if err != nil {
		a.log.Warn("cannot build a playback.finished envelope",
			"sessionId", session.SessionID, "playbackRef", playback.Ref, "error", err)
		return
	}

	data := contract.MediaPlaybackFinishedData{
		SessionID:   session.SessionID,
		InstanceID:  a.instanceID,
		CallID:      stringPtr(session.CallID),
		LegID:       stringPtr(session.LegID),
		PlaybackRef: playback.Ref,
		Reason:      contract.MediaPlaybackFinishedReason(playback.Reason),
		PlayedMs:    playback.PlayedMs,
		Detail:      stringPtr(playback.Detail),
	}

	a.publishAsync(func(ctx context.Context) error {
		return a.publisher.PlaybackFinished(ctx,
			contract.Envelope[contract.MediaPlaybackFinishedData]{
				ID:      envelope.id,
				At:      envelope.at,
				OrgID:   session.OrgID,
				Subject: envelope.subject,
				Type:    contract.EventTypeMediaPlaybackFinished,
				Source:  mediaevents.Source,
				Data:    data,
			})
	}, "playback.finished", session.SessionID, envelope.id, false)
}

// RecordingFinished publishes `recording.finished`.
//
// Unlike the other lifecycle events, the engine BLOCKS on this one: `plan-walker`'s voicemail node
// and `call-control`'s on-demand recording wait for the file before publishing
// `channel.record.stopped`, and `apps/api`'s archiver copies the object once that lands.
//
// So the packet path calls this only AFTER the WAV header has been patched with the real lengths,
// the bytes fsynced and the file renamed from its `.partial` name into the object key. A moment
// earlier archives a file that is still being written.
//
// It does NOT touch the session directory: a recording ending is not a session ending.
func (a *LifecycleAnnouncer) RecordingFinished(
	session rtp.SessionSummary,
	recording rtp.RecordingSummary,
) {
	if a.publisher == nil || session.OrgID == "" {
		return
	}

	envelope, err := a.envelope(session, contract.EventTypeMediaRecordingFinished)
	if err != nil {
		a.log.Warn("cannot build a recording.finished envelope",
			"sessionId", session.SessionID, "recordingRef", recording.Ref, "error", err)
		return
	}

	data := contract.MediaRecordingFinishedData{
		SessionID:    session.SessionID,
		InstanceID:   a.instanceID,
		CallID:       stringPtr(session.CallID),
		LegID:        stringPtr(session.LegID),
		RecordingRef: recording.Ref,
		Reason:       contract.MediaRecordingFinishedReason(recording.Reason),
		DurationMs:   recording.DurationMs,
		Bytes:        int(recording.Bytes),
		ObjectKey:    recording.ObjectKey,
		Direction:    contract.MediaRecordingFinishedDirection(recording.Direction),
		Pauses:       recordingPauses(recording.Pauses),
		Detail:       stringPtr(recording.Detail),
	}

	a.publishAsync(func(ctx context.Context) error {
		return a.publisher.RecordingFinished(ctx,
			contract.Envelope[contract.MediaRecordingFinishedData]{
				ID:      envelope.id,
				At:      envelope.at,
				OrgID:   session.OrgID,
				Subject: envelope.subject,
				Type:    contract.EventTypeMediaRecordingFinished,
				Source:  mediaevents.Source,
				Data:    data,
			})
	}, "recording.finished", session.SessionID, envelope.id, true)
}

// recordingPauses is the PCI half of the payload: every stretch `pause-recording` silenced, against
// the file's own timeline. Nil when nothing was paused, so the field is absent on the wire rather
// than an empty array — the two mean the same thing and one of them is smaller.
func recordingPauses(pauses []rtp.RecordingPause) []contract.MediaRecordingFinishedPauses {
	if len(pauses) == 0 {
		return nil
	}
	out := make([]contract.MediaRecordingFinishedPauses, 0, len(pauses))
	for _, pause := range pauses {
		out = append(out, contract.MediaRecordingFinishedPauses{
			StartMs: pause.StartMs,
			EndMs:   pause.EndMs,
		})
	}
	return out
}

// DtmfReceived publishes `dtmf.received`, one event per KEYPRESS.
//
// RFC 4733 sends a digit as an update packet every 20 ms plus three copies of the END packet, so the
// packet path collapses them (see `rtp.dtmfDetector`) before this is called. Publishing per packet
// would put the de-duplication in every consumer, and the first to get it wrong is a `gather` that
// fills a four-digit PIN from one press.
//
// A relayed telephone-event packet is heard by the peer LEG; this event is what tells the
// ORCHESTRATOR a key was pressed, which is how a confirmation IVR and feature codes work. The two
// are independent: the relay continues untouched while this fires.
//
// It does NOT touch the session directory. A keypress is not a session ending.
func (a *LifecycleAnnouncer) DtmfReceived(session rtp.SessionSummary, digit rtp.DtmfDigit) {
	if a.publisher == nil || session.OrgID == "" {
		return
	}

	envelope, err := a.envelope(session, contract.EventTypeMediaDtmfReceived)
	if err != nil {
		a.log.Warn("cannot build a dtmf.received envelope",
			"sessionId", session.SessionID, "error", err)
		return
	}

	data := contract.MediaDtmfReceivedData{
		SessionID:  session.SessionID,
		InstanceID: a.instanceID,
		CallID:     stringPtr(session.CallID),
		LegID:      stringPtr(session.LegID),
		Digit:      digit.Digit,
		DurationMs: digit.DurationMs,
	}

	a.publishAsync(func(ctx context.Context) error {
		return a.publisher.DtmfReceived(ctx, contract.Envelope[contract.MediaDtmfReceivedData]{
			ID:      envelope.id,
			At:      envelope.at,
			OrgID:   session.OrgID,
			Subject: envelope.subject,
			Type:    contract.EventTypeMediaDtmfReceived,
			Source:  mediaevents.Source,
			Data:    data,
		})
	}, "dtmf.received", session.SessionID, envelope.id, true)
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
