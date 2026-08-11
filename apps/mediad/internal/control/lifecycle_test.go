package control_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The announcer publishes from a goroutine — a JetStream round trip must never stall a drain — so
// every assertion here polls rather than reading straight after the call.
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func newAnnouncer(t *testing.T) (*control.LifecycleAnnouncer, *mediaevents.RecordingPublisher, *directory.FakeStore) {
	t.Helper()
	publisher := mediaevents.NewRecordingPublisher()
	dir := directory.NewFakeStore()
	return control.NewLifecycleAnnouncer(publisher, dir, thisNode,
		slog.New(slog.NewTextHandler(io.Discard, nil))), publisher, dir
}

func summary() rtp.SessionSummary {
	return rtp.SessionSummary{
		SessionID:  testSession,
		OrgID:      testOrg,
		CallID:     testCall,
		LegID:      "leg-1",
		RTPPort:    30002,
		Stats:      rtp.Stats{PacketsReceived: 1500, PacketsSent: 1490},
		Duration:   42 * time.Second,
		RemoteAddr: "203.0.113.9:41000",
	}
}

func TestSessionEndedPublishesTheFactAndClearsTheDirectory(t *testing.T) {
	announcer, publisher, dir := newAnnouncer(t)
	if err := dir.Put(context.Background(), directory.Entry{
		SessionID:  testSession,
		InstanceID: thisNode,
		OrgID:      testOrg,
		CallID:     testCall,
		Address:    "203.0.113.10",
		RTPPort:    30002,
		RTCPPort:   30003,
	}); err != nil {
		t.Fatalf("seeding the directory: %v", err)
	}

	announcer.SessionEnded(summary(), rtp.EndReasonReleased)

	// A session can end WITHOUT a release — a timeout, the reaper, a drain — so the cleanup lives
	// here as well as in the release handler.
	if dir.Len() != 0 {
		t.Error("the directory entry outlived its session")
	}

	waitFor(t, "the session.ended event", func() bool {
		return len(publisher.EndedEvents()) == 1
	})
	envelope := publisher.EndedEvents()[0]

	if envelope.Subject != "media.evt.v1."+testOrg+"."+testSession+".session.ended" {
		t.Errorf("subject = %q", envelope.Subject)
	}
	if envelope.OrgID != testOrg {
		t.Errorf("orgId = %q, want %q", envelope.OrgID, testOrg)
	}
	if envelope.Source != "mediad" {
		t.Errorf("source = %q, want mediad", envelope.Source)
	}
	if envelope.ID == "" {
		// The id is the Nats-Msg-Id, which is what collapses a retried publish inside the stream's
		// duplicate window instead of double-counting a media failure.
		t.Error("the envelope has no id")
	}
	if envelope.Data.Reason != "released" {
		t.Errorf("reason = %q, want released", envelope.Data.Reason)
	}
	if envelope.Data.InstanceID != thisNode {
		t.Errorf("instanceId = %q, want %q", envelope.Data.InstanceID, thisNode)
	}
	if envelope.Data.PacketsReceived != 1500 || envelope.Data.PacketsSent != 1490 {
		t.Errorf("counters = %d/%d, want 1500/1490",
			envelope.Data.PacketsReceived, envelope.Data.PacketsSent)
	}
	if envelope.Data.DurationMs != 42_000 {
		t.Errorf("durationMs = %d, want 42000", envelope.Data.DurationMs)
	}
	if envelope.Data.CallID == nil || *envelope.Data.CallID != testCall {
		t.Errorf("callId = %v, want %q", envelope.Data.CallID, testCall)
	}
}

// Each reason travels verbatim, because the branch a consumer cares about is `released` (the engine
// asked, so the call ended normally) against everything else (the media plane decided, so the
// engine's picture of the call is now stale).
func TestSessionEndedCarriesEveryReason(t *testing.T) {
	for _, reason := range []rtp.EndReason{
		rtp.EndReasonReleased,
		rtp.EndReasonRTPTimeout,
		rtp.EndReasonIdleReaped,
		rtp.EndReasonDrained,
	} {
		t.Run(string(reason), func(t *testing.T) {
			announcer, publisher, _ := newAnnouncer(t)
			announcer.SessionEnded(summary(), reason)
			waitFor(t, "the session.ended event", func() bool {
				return len(publisher.EndedEvents()) == 1
			})
			if got := publisher.EndedEvents()[0].Data.Reason; string(got) != string(reason) {
				t.Errorf("reason = %q, want %q", got, reason)
			}
		})
	}
}

// The timeout is the DIAGNOSIS; the ended that follows is the fact. Deleting the directory entry
// here would make it disappear before the event that explains why.
func TestRTPTimedOutPublishesAndLeavesTheDirectoryAlone(t *testing.T) {
	announcer, publisher, dir := newAnnouncer(t)
	if err := dir.Put(context.Background(), directory.Entry{
		SessionID:  testSession,
		InstanceID: thisNode,
		OrgID:      testOrg,
		CallID:     testCall,
		Address:    "203.0.113.10",
		RTPPort:    30002,
		RTCPPort:   30003,
	}); err != nil {
		t.Fatalf("seeding the directory: %v", err)
	}

	announcer.RTPTimedOut(summary(), 30*time.Second)

	waitFor(t, "the session.rtp-timeout event", func() bool {
		return len(publisher.TimeoutEvents()) == 1
	})
	envelope := publisher.TimeoutEvents()[0]

	if envelope.Subject != "media.evt.v1."+testOrg+"."+testSession+".session.rtp-timeout" {
		t.Errorf("subject = %q", envelope.Subject)
	}
	if envelope.Data.SilentForMs != 30_000 {
		t.Errorf("silentForMs = %d, want 30000", envelope.Data.SilentForMs)
	}
	if envelope.Data.RemoteAddress == nil || *envelope.Data.RemoteAddress != "203.0.113.9:41000" {
		// Absent means the far end NEVER sent — a different failure from one that had audio and
		// lost it — so the field has to survive.
		t.Errorf("remoteAddress = %v", envelope.Data.RemoteAddress)
	}
	if dir.Len() != 1 {
		t.Error("the timeout removed the directory entry before the ended event explained it")
	}
	if len(publisher.EndedEvents()) != 0 {
		t.Error("RTPTimedOut also published an ended event; the manager emits that separately")
	}
}

// A session with no tenant has no subject to publish on. It cannot happen through the control
// surface, which refuses an allocate without an org, but building a subject with an empty token
// would be worse than saying nothing.
func TestAnnouncerSkipsASessionWithNoOrg(t *testing.T) {
	announcer, publisher, _ := newAnnouncer(t)
	orphan := summary()
	orphan.OrgID = ""

	announcer.SessionEnded(orphan, rtp.EndReasonDrained)
	announcer.RTPTimedOut(orphan, time.Second)

	time.Sleep(20 * time.Millisecond)
	if len(publisher.EndedEvents()) != 0 || len(publisher.TimeoutEvents()) != 0 {
		t.Error("an event was published on a subject with no org token")
	}
}

// A nil publisher is a deployment with events turned off. It must still clean the directory,
// because a stale entry is a routing problem rather than an observability one.
func TestAnnouncerWithoutAPublisherStillCleansUp(t *testing.T) {
	dir := directory.NewFakeStore()
	if err := dir.Put(context.Background(), directory.Entry{
		SessionID:  testSession,
		InstanceID: thisNode,
		OrgID:      testOrg,
		CallID:     testCall,
		Address:    "203.0.113.10",
		RTPPort:    30002,
		RTCPPort:   30003,
	}); err != nil {
		t.Fatalf("seeding the directory: %v", err)
	}
	announcer := control.NewLifecycleAnnouncer(nil, dir, thisNode,
		slog.New(slog.NewTextHandler(io.Discard, nil)))

	announcer.SessionEnded(summary(), rtp.EndReasonReleased)
	if dir.Len() != 0 {
		t.Error("the directory entry survived a teardown with no publisher")
	}
}

// `playback.finished` is published even though nothing branches on it, for the same reason
// `session.rtp-timeout` is: `reason: error` is a caller sitting in silence where a menu should be,
// on a call that is otherwise healthy, and nothing else on this backbone records it.
func TestPlaybackFinishedPublishesEveryReason(t *testing.T) {
	for _, reason := range []rtp.PlaybackEndReason{
		rtp.PlaybackCompleted,
		rtp.PlaybackStopped,
		rtp.PlaybackError,
	} {
		t.Run(string(reason), func(t *testing.T) {
			announcer, publisher, _ := newAnnouncer(t)

			announcer.PlaybackFinished(summary(), rtp.PlaybackSummary{
				Ref:      "pb-1",
				Reason:   reason,
				PlayedMs: 1_240,
				Detail:   "detail",
			})

			waitFor(t, "the playback.finished event", func() bool {
				return len(publisher.PlaybackEvents()) == 1
			})
			envelope := publisher.PlaybackEvents()[0]

			if envelope.Subject != "media.evt.v1."+testOrg+"."+testSession+".playback.finished" {
				t.Errorf("subject = %q", envelope.Subject)
			}
			if envelope.Source != "mediad" {
				t.Errorf("source = %q, want mediad", envelope.Source)
			}
			if envelope.ID == "" {
				t.Error("the envelope has no id; nothing collapses a retried publish")
			}
			if string(envelope.Data.Reason) != string(reason) {
				t.Errorf("reason = %q, want %q", envelope.Data.Reason, reason)
			}
			if envelope.Data.PlaybackRef != "pb-1" {
				t.Errorf("playbackRef = %q, want pb-1", envelope.Data.PlaybackRef)
			}
			// playedMs is what actually reached the far end, which on a barge-in is nothing like
			// the length of the clip.
			if envelope.Data.PlayedMs != 1_240 {
				t.Errorf("playedMs = %d, want 1240", envelope.Data.PlayedMs)
			}
			if envelope.Data.InstanceID != thisNode {
				t.Errorf("instanceId = %q, want %q", envelope.Data.InstanceID, thisNode)
			}
		})
	}
}

// A prompt ending is not a session ending. Deleting the entry here would make the leg
// uncommandable from a neighbouring instance the moment its greeting finished.
func TestPlaybackFinishedLeavesTheDirectoryAlone(t *testing.T) {
	announcer, _, dir := newAnnouncer(t)
	if err := dir.Put(context.Background(), directory.Entry{
		SessionID:  testSession,
		InstanceID: thisNode,
		OrgID:      testOrg,
		CallID:     testCall,
		Address:    "203.0.113.10",
		RTPPort:    30002,
		RTCPPort:   30003,
	}); err != nil {
		t.Fatalf("seeding the directory: %v", err)
	}

	announcer.PlaybackFinished(summary(), rtp.PlaybackSummary{
		Ref: "pb-1", Reason: rtp.PlaybackCompleted, PlayedMs: 400,
	})

	if dir.Len() != 1 {
		t.Error("a finished prompt removed the session's directory entry")
	}
}

func TestPlaybackFinishedSkipsASessionWithNoOrg(t *testing.T) {
	announcer, publisher, _ := newAnnouncer(t)
	orphan := summary()
	orphan.OrgID = ""

	announcer.PlaybackFinished(orphan, rtp.PlaybackSummary{
		Ref: "pb-1", Reason: rtp.PlaybackCompleted,
	})

	time.Sleep(20 * time.Millisecond)
	if len(publisher.PlaybackEvents()) != 0 {
		t.Error("an event was published on a subject with no org token")
	}
}

// One keypress, one event, on the session's own subject.
//
// The de-duplication itself lives in the packet path (`rtp.dtmfDetector`); what this asserts is the
// half the announcer owns — that a detected digit becomes a `dtmf.received` envelope whose subject,
// org and instance are the ones a consumer keys on, and that the payload carries the digit as a
// CHARACTER rather than the RFC 4733 event code, because that is what a dialplan compares against.
func TestDtmfReceivedPublishesOneEventPerKeypress(t *testing.T) {
	announcer, publisher, _ := newAnnouncer(t)

	announcer.DtmfReceived(summary(), rtp.DtmfDigit{
		Digit: "#", DurationMs: 120, EndedBy: rtp.DtmfEndedByEndBit,
	})

	waitFor(t, "the dtmf.received event", func() bool {
		return len(publisher.DtmfEvents()) == 1
	})
	envelope := publisher.DtmfEvents()[0]

	if envelope.Subject != "media.evt.v1."+testOrg+"."+testSession+".dtmf.received" {
		t.Errorf("subject = %q", envelope.Subject)
	}
	if envelope.Source != "mediad" {
		t.Errorf("source = %q, want mediad", envelope.Source)
	}
	if envelope.ID == "" {
		t.Error("the envelope has no id")
	}
	if envelope.Data.Digit != "#" {
		t.Errorf("digit = %q, want #", envelope.Data.Digit)
	}
	if envelope.Data.DurationMs != 120 {
		t.Errorf("durationMs = %d, want 120", envelope.Data.DurationMs)
	}
	if envelope.Data.InstanceID != thisNode {
		t.Errorf("instanceId = %q, want %q", envelope.Data.InstanceID, thisNode)
	}
	if envelope.Data.SessionID != testSession {
		t.Errorf("sessionId = %q, want %q", envelope.Data.SessionID, testSession)
	}
}

// A keypress is not a session ending. Removing the entry here would make the leg uncommandable from
// a neighbouring instance the moment the caller touched the keypad.
func TestDtmfReceivedLeavesTheDirectoryAlone(t *testing.T) {
	announcer, _, dir := newAnnouncer(t)
	if err := dir.Put(context.Background(), directory.Entry{
		SessionID:  testSession,
		InstanceID: thisNode,
		OrgID:      testOrg,
		CallID:     testCall,
		Address:    "203.0.113.10",
		RTPPort:    30002,
		RTCPPort:   30003,
	}); err != nil {
		t.Fatalf("seeding the directory: %v", err)
	}

	announcer.DtmfReceived(summary(), rtp.DtmfDigit{Digit: "1", DurationMs: 100})

	if dir.Len() != 1 {
		t.Error("a keypress removed the session's directory entry")
	}
}

func TestDtmfReceivedSkipsASessionWithNoOrg(t *testing.T) {
	announcer, publisher, _ := newAnnouncer(t)
	orphan := summary()
	orphan.OrgID = ""

	announcer.DtmfReceived(orphan, rtp.DtmfDigit{Digit: "1", DurationMs: 100})

	time.Sleep(20 * time.Millisecond)
	if len(publisher.DtmfEvents()) != 0 {
		t.Error("an event was published on a subject with no org token")
	}
}
