package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

func TestSessionEndFeedsEveryCounter(t *testing.T) {
	m := New()
	lifecycle := m.Observe(nil)
	lifecycle.SessionEnded(rtp.SessionSummary{
		Duration: 42 * time.Second,
		Stats: rtp.Stats{
			PacketsReceived:      1000,
			PacketsSent:          990,
			BytesReceived:        160000,
			Malformed:            3,
			UnsupportedPT:        2,
			ForeignSource:        1,
			TransportDroppedRTP:  4,
			TransportDroppedRTCP: 5,
			SuppressedByPlayback: 10,
			SuppressedByDtmf:     6,
			SuppressedByHold:     7,
			SuppressedByMute:     8,
			Transcoded:           9,
		},
	}, rtp.EndReasonReleased)

	body := scrape(t, m)
	for _, want := range []string{
		`mediad_sessions_ended_total{reason="released"} 1`,
		"mediad_rtp_packets_received_total 1000",
		"mediad_rtp_packets_sent_total 990",
		"mediad_rtp_bytes_received_total 160000",
		`mediad_rtp_packets_dropped_total{reason="malformed"} 3`,
		`mediad_rtp_packets_dropped_total{reason="transport_rtcp"} 5`,
		`mediad_rtp_frames_suppressed_total{reason="hold"} 7`,
		"mediad_rtp_frames_transcoded_total 9",
		"mediad_session_duration_seconds_sum 42",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("scrape is missing %q", want)
		}
	}
}

// The decorator must be transparent: an announcer that stops being called stops producing the
// media events the engine bills from, which is a far worse failure than losing a metric.
func TestObserverForwardsToTheInnerLifecycle(t *testing.T) {
	inner := &recorder{}
	lifecycle := New().Observe(inner)
	lifecycle.SessionEnded(rtp.SessionSummary{}, rtp.EndReasonDrained)
	lifecycle.RTPTimedOut(rtp.SessionSummary{}, time.Second)
	lifecycle.PlaybackFinished(rtp.SessionSummary{}, rtp.PlaybackSummary{})
	lifecycle.DtmfReceived(rtp.SessionSummary{}, rtp.DtmfDigit{})
	lifecycle.RecordingFinished(rtp.SessionSummary{}, rtp.RecordingSummary{})
	if got := *inner; got != (recorder{1, 1, 1, 1, 1}) {
		t.Errorf("the inner lifecycle saw %+v", got)
	}
}

func TestObserverToleratesNoInnerLifecycle(t *testing.T) {
	lifecycle := New().Observe(nil)
	lifecycle.RTPTimedOut(rtp.SessionSummary{}, time.Second)
	lifecycle.DtmfReceived(rtp.SessionSummary{}, rtp.DtmfDigit{})
}

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	response := httptest.NewRecorder()
	m.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	if response.Code != 200 {
		t.Fatalf("scrape answered %d", response.Code)
	}
	return response.Body.String()
}

type recorder struct{ ended, timedOut, playbacks, digits, recordings int }

func (r *recorder) SessionEnded(rtp.SessionSummary, rtp.EndReason) { r.ended++ }
func (r *recorder) RTPTimedOut(rtp.SessionSummary, time.Duration)  { r.timedOut++ }
func (r *recorder) PlaybackFinished(rtp.SessionSummary, rtp.PlaybackSummary) {
	r.playbacks++
}
func (r *recorder) DtmfReceived(rtp.SessionSummary, rtp.DtmfDigit) { r.digits++ }
func (r *recorder) RecordingFinished(rtp.SessionSummary, rtp.RecordingSummary) {
	r.recordings++
}
