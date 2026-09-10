package control

import (
	"context"
	"log/slog"
	"sync"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// LifecycleAnnouncer is the TELL half of the media contract: it turns the packet path's session
// transitions into `media.evt.v1.*` events and cleans the session directory behind them.
//
// It is separate from Server because the two run on different threads: a handler runs on a NATS
// callback with its caller waiting, while an announcement runs from the reaper or a drain with
// nobody waiting, so the announcement path can take a two-second publish deadline.
//
// Publishing is asynchronous because rtp.Manager calls this from the goroutine tearing a session
// down; an inline round trip would let a sick broker stall a drain. Ordering still holds:
// `session.rtp-timeout` is published before the `session.ended` that follows it, both carry the
// session id, and JetStream's per-subject ordering does the rest.
type LifecycleAnnouncer struct {
	publisher  mediaevents.Publisher
	dir        directory.Store
	log        *slog.Logger
	instanceID string

	// inflight counts the publishes that have been handed off and not yet finished, so a shutdown
	// can WAIT for them; otherwise the process exits under publishes that never reached the broker,
	// losing the `session.ended` for every drained call.
	inflight sync.WaitGroup
	// slots bounds how many are talking to the broker at once. A mass reap otherwise puts hundreds
	// of concurrent JetStream publishes on a broker that is quite possibly already unwell.
	slots chan struct{}
}

// lifecyclePublishConcurrency is how many lifecycle publishes may be in flight at once. See slots.
const lifecyclePublishConcurrency = 8

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
	return &LifecycleAnnouncer{
		publisher:  publisher,
		dir:        dir,
		log:        log,
		instanceID: instanceID,
		slots:      make(chan struct{}, lifecyclePublishConcurrency),
	}
}

// publishAsync hands a publish to a goroutine, bounded by slots and tracked by inflight.
//
// The hand-off itself never blocks the caller, which is the whole point: this runs on the goroutine
// tearing a session down, and a sick broker must not be able to stall a drain.
func (a *LifecycleAnnouncer) publishAsync(do func(context.Context) error, eventType, sessionID string) {
	a.inflight.Add(1)
	go func() {
		defer a.inflight.Done()
		a.slots <- struct{}{}
		defer func() { <-a.slots }()
		a.publish(do, eventType, sessionID)
	}()
}

// Wait blocks until every handed-off publish has finished or the context expires, and reports
// whether they all finished. Called on shutdown, after the manager has drained and before the NATS
// connection goes away.
func (a *LifecycleAnnouncer) Wait(ctx context.Context) bool {
	done := make(chan struct{})
	go func() {
		a.inflight.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
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
	}, "session.ended", session.SessionID)
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
	}, "session.rtp-timeout", session.SessionID)
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
	}, "playback.finished", session.SessionID)
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
	}, "recording.finished", session.SessionID)
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
	}, "dtmf.received", session.SessionID)
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
// No retry, deliberately: these events describe something that has already happened to a call that
// is already over, and a retry loop would keep a goroutine alive per failed publish exactly when the
// broker is struggling. JetStream's duplicate window covers a lost ack.
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
