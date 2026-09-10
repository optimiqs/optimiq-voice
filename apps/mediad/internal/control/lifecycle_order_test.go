package control_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// scriptedPublisher records the order events reach the broker and can hold one back or reject it,
// which is what the ordering and retry guarantees have to be observed through.
type scriptedPublisher struct {
	mu       sync.Mutex
	arrived  []string
	ids      []string
	attempts map[string]int

	holdRecording chan struct{}
	failDigits    int
}

var _ mediaevents.Publisher = (*scriptedPublisher)(nil)

func newScriptedPublisher() *scriptedPublisher {
	return &scriptedPublisher{attempts: map[string]int{}}
}

func (p *scriptedPublisher) note(kind, id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.arrived = append(p.arrived, kind)
	p.ids = append(p.ids, id)
	p.attempts[kind]++
}

func (p *scriptedPublisher) order() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.arrived...)
}

func (p *scriptedPublisher) eventIDs() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.ids...)
}

func (p *scriptedPublisher) SessionEnded(
	_ context.Context,
	envelope contract.Envelope[contract.MediaSessionEndedData],
) error {
	p.note("session.ended", envelope.ID)
	return nil
}

func (p *scriptedPublisher) SessionRTPTimeout(
	_ context.Context,
	envelope contract.Envelope[contract.MediaSessionRTPTimeoutData],
) error {
	p.note("session.rtp-timeout", envelope.ID)
	return nil
}

func (p *scriptedPublisher) PlaybackFinished(
	_ context.Context,
	envelope contract.Envelope[contract.MediaPlaybackFinishedData],
) error {
	p.note("playback.finished", envelope.ID)
	return nil
}

func (p *scriptedPublisher) RecordingFinished(
	_ context.Context,
	envelope contract.Envelope[contract.MediaRecordingFinishedData],
) error {
	if p.holdRecording != nil {
		<-p.holdRecording
	}
	p.note("recording.finished", envelope.ID)
	return nil
}

func (p *scriptedPublisher) DtmfReceived(
	_ context.Context,
	envelope contract.Envelope[contract.MediaDtmfReceivedData],
) error {
	p.note("dtmf.received", envelope.ID)
	p.mu.Lock()
	fail := p.failDigits > 0
	if fail {
		p.failDigits--
	}
	p.mu.Unlock()
	if fail {
		return errors.New("stream unavailable")
	}
	return nil
}

func newScriptedAnnouncer(t *testing.T, publisher mediaevents.Publisher) *control.LifecycleAnnouncer {
	t.Helper()
	return control.NewLifecycleAnnouncer(publisher, directory.NewFakeStore(), thisNode,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func drainAnnouncer(t *testing.T, announcer *control.LifecycleAnnouncer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !announcer.Wait(ctx) {
		t.Fatal("the announcer did not drain")
	}
}

// The engine tears a leg down on `recording.finished`, so a slow publish of it must not let the
// `session.ended` that follows overtake it.
func TestLifecycleEventsAboutOneSessionKeepTheirOrder(t *testing.T) {
	publisher := newScriptedPublisher()
	publisher.holdRecording = make(chan struct{})
	announcer := newScriptedAnnouncer(t, publisher)

	announcer.RecordingFinished(summary(), rtp.RecordingSummary{
		Ref:       "rec-1",
		Reason:    "stopped",
		ObjectKey: "org/call/rec-1.wav",
		Direction: "both",
	})
	// Give the held publish time to be picked up before the second event is announced.
	time.Sleep(20 * time.Millisecond)
	announcer.SessionEnded(summary(), rtp.EndReasonReleased)
	close(publisher.holdRecording)
	drainAnnouncer(t, announcer)

	got := publisher.order()
	if len(got) != 2 || got[0] != "recording.finished" || got[1] != "session.ended" {
		t.Fatalf("events about one session reached the broker as %v", got)
	}
}

// A digit is a critical event: the gather waiting on it does not care that the broker was briefly
// unwell, and the retry must carry the same event id so the stream can collapse a duplicate.
func TestACriticalEventIsRetriedWithTheSameEventID(t *testing.T) {
	publisher := newScriptedPublisher()
	publisher.failDigits = 1
	announcer := newScriptedAnnouncer(t, publisher)

	announcer.DtmfReceived(summary(), rtp.DtmfDigit{Digit: "5", DurationMs: 120})
	drainAnnouncer(t, announcer)

	got := publisher.order()
	if len(got) != 2 {
		t.Fatalf("a rejected digit was attempted %d times, want 2", len(got))
	}
	ids := publisher.eventIDs()
	if ids[0] != ids[1] {
		t.Fatalf("the retry changed the event id: %v", ids)
	}
}

// Telemetry is not worth a retry loop on a broker that is already struggling.
func TestATelemetryEventIsPublishedOnce(t *testing.T) {
	publisher := newScriptedPublisher()
	announcer := newScriptedAnnouncer(t, publisher)

	announcer.RTPTimedOut(summary(), 30*time.Second)
	drainAnnouncer(t, announcer)

	if got := publisher.order(); len(got) != 1 || got[0] != "session.rtp-timeout" {
		t.Fatalf("telemetry publishes: %v", got)
	}
}

// Wait closes admission: an announcement racing the drain must not extend it indefinitely.
func TestWaitClosesAdmission(t *testing.T) {
	publisher := newScriptedPublisher()
	announcer := newScriptedAnnouncer(t, publisher)
	drainAnnouncer(t, announcer)

	announcer.SessionEnded(summary(), rtp.EndReasonDrained)
	drainAnnouncer(t, announcer)
	if got := publisher.order(); len(got) != 0 {
		t.Fatalf("an event was published after the announcer drained: %v", got)
	}
}
