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

// qualityOf carries the RTCP view of a leg onto the wire.
//
// It exists at all because `SessionSummary.Quality` recorded a CONTRACT GAP rather than a decision:
// the numbers have been measured, tested and available since rung 7, and `session.ended` had no
// field for any of them, so a mediad that knew exactly why a call sounded bad had nowhere to say so.
//
// The struct is ALWAYS sent, never elided on all-zeroes, and that is the point of the optional field
// on the other side of the wire. `reportsReceived: 0` is a fact about the ENDPOINT — it sends no
// RTCP — and is different from the field being absent, which is what a media plane with no RTCP at
// all produces. Dropping the object when every number is zero would collapse those two into one.
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

// PlaybackFinished publishes `playback.finished`.
//
// # Why this is announced at all, when nothing branches on it
//
// The engine does not act on it: `MediaPort.play` returns the moment audio STARTS, the twelve-member
// `MediaEvent` union has no playback member, and `mediad-event-mapping.ts` answers `undefined` for
// this type — exactly as the ARI path drops `PlaybackFinished`. Adding a union member nobody
// branches on would be making two media planes agree on a shape for no reason.
//
// It is published because of the `error` reason. A playback that fails is a caller sitting in
// silence where a menu should be, on a call that is otherwise perfectly healthy: the command already
// answered `ok`, the session is still up, and nothing else on this backbone records it. This is the
// same argument that makes `session.rtp-timeout` worth publishing while mapping to nothing.
//
// It does NOT touch the session directory. A prompt ending is not a session ending, and deleting
// the entry here would make the leg uncommandable from a neighbouring instance the moment its
// greeting finished.
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

	go a.publish(func(ctx context.Context) error {
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
// # The one media event above this seam that is actually branched on
//
// `session.rtp-timeout` and `playback.finished` map to nothing in the engine's `MediaEvent` union.
// This one maps to two members — `recording-finished` and, for `reason: error`, `recording-failed` —
// because the engine BLOCKS on it: `plan-walker`'s voicemail node and `call-control`'s on-demand
// recording both wait for the file before they publish `channel.record.stopped`, and `apps/api`'s
// archiver copies the object the moment that lands.
//
// Which is why the packet path calls this only AFTER the WAV header has been patched with the real
// lengths, the bytes fsynced and the file renamed from its `.partial` name into the object key. An
// event published a moment earlier archives a file that is still being written — a truncated
// recording nobody discovers until somebody plays it back weeks later.
//
// It does NOT touch the session directory. A recording ending is not a session ending, and deleting
// the entry here would make the leg uncommandable from a neighbouring instance the moment it
// stopped being recorded.
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
		Detail:       stringPtr(recording.Detail),
	}

	go a.publish(func(ctx context.Context) error {
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

// DtmfReceived publishes `dtmf.received`.
//
// # One event per KEYPRESS, and the de-duplication is below this line
//
// RFC 4733 sends a digit as an update packet every 20 ms plus three copies of the END packet, so
// the packet path decodes and collapses them (see `rtp.dtmfDetector`) and this method is handed the
// digit. Publishing per packet would put the de-duplication in every consumer, and the first one to
// get it wrong is a `gather` that fills a four-digit PIN from one press.
//
// # Why it is announced at all, when a bridged digit already reaches the far end
//
// Because the engine is not the far end. A relayed telephone-event packet is heard by the peer LEG;
// this event is what tells the ORCHESTRATOR a key was pressed, which is how the confirmation IVR
// answers "press 1 to accept", how feature codes are collected, and how a `gather` terminates. The
// two are independent by design: the relay continues untouched while this fires, exactly as ARI
// raises `ChannelDtmfReceived` on a channel that is happily bridged.
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

	go a.publish(func(ctx context.Context) error {
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
