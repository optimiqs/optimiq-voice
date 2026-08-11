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
