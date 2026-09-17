// Package metrics exposes mediad's Prometheus surface on the private health listener.
//
// Almost everything here is fed by decorating the rtp.Lifecycle the Manager already calls, rather
// than by instrumenting the packet path. That is a deliberate trade with one consequence worth
// stating: **per-session counters land when the SESSION ENDS, not as packets arrive.** A scrape
// during a long call sees that call's packets in the live gauges and nothing in the totals; the
// totals move when the leg hangs up. For a service whose calls last seconds to minutes that is a
// reporting delay, not a blind spot, and it buys an instrumented packet path that costs zero
// atomics per packet — mediad forwards tens of thousands of packets a second per instance, and a
// counter increment on that path is a measurable share of its budget.
package metrics

import (
	"net/http"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	runtimemetrics "github.com/optimiqs/optimiq-voice/packages/runtime-go/metrics"
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds mediad's collectors and the Lifecycle decorator that feeds them.
type Metrics struct {
	registry *runtimemetrics.Registry

	sessionsEnded   *prometheus.CounterVec
	sessionSeconds  prometheus.Histogram
	packetsReceived prometheus.Counter
	packetsSent     prometheus.Counter
	bytesReceived   prometheus.Counter
	packetsDropped  *prometheus.CounterVec
	framesSuppress  *prometheus.CounterVec
	transcoded      prometheus.Counter
	rtpTimeouts     prometheus.Counter
	playbacks       *prometheus.CounterVec
	recordings      *prometheus.CounterVec
	recordedSeconds prometheus.Histogram
	dtmfDigits      prometheus.Counter
}

// New registers mediad's collectors under the `mediad_` namespace.
func New() *Metrics {
	registry := runtimemetrics.New("mediad")
	return &Metrics{
		registry: registry,
		sessionsEnded: registry.CounterVec("sessions_ended_total",
			"Media sessions closed, by rtp.EndReason.", "reason"),
		sessionSeconds: registry.Histogram("session_duration_seconds",
			"How long a media session lived.",
			[]float64{1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600}),
		packetsReceived: registry.Counter("rtp_packets_received_total",
			"RTP packets accepted, summed over sessions that have ended."),
		packetsSent: registry.Counter("rtp_packets_sent_total",
			"RTP packets sent, summed over sessions that have ended."),
		bytesReceived: registry.Counter("rtp_bytes_received_total",
			"RTP payload bytes accepted, summed over sessions that have ended."),
		packetsDropped: registry.CounterVec("rtp_packets_dropped_total",
			"RTP packets discarded before they reached the relay, by reason.", "reason"),
		framesSuppress: registry.CounterVec("rtp_frames_suppressed_total",
			"Frames deliberately not forwarded, by the feature that suppressed them. Not loss.",
			"reason"),
		transcoded: registry.Counter("rtp_frames_transcoded_total",
			"Frames decoded and re-encoded rather than passed through. Its ratio against packets_sent is the diagnostic."),
		rtpTimeouts: registry.Counter("rtp_timeouts_total",
			"Sessions whose audio stopped while they were still allocated."),
		playbacks: registry.CounterVec("playbacks_finished_total",
			"Playbacks that finished, by how they ended.", "reason"),
		recordings: registry.CounterVec("recordings_finished_total",
			"Recordings finalised, by how they ended.", "reason"),
		recordedSeconds: registry.Histogram("recording_duration_seconds",
			"Length of a finalised recording.", []float64{1, 5, 15, 30, 60, 300, 900, 1800, 3600}),
		dtmfDigits: registry.Counter("dtmf_digits_received_total",
			"Detected DTMF keypresses. One per keypress, not per RFC 4733 packet."),
	}
}

// Handler serves the registry, for health.WithMetrics.
func (m *Metrics) Handler() http.Handler { return m.registry.Handler() }

// Gauge registers a value read from the service at scrape time. The function must not block.
func (m *Metrics) Gauge(name, help string, read func() int) {
	m.registry.GaugeFunc(name, help, func() float64 { return float64(read()) })
}

// Observe wraps a Lifecycle so every notification is counted on the way through.
//
// A nil inner Lifecycle is legitimate — a deployment with no event announcer still wants
// telemetry — and every method tolerates it.
func (m *Metrics) Observe(inner rtp.Lifecycle) rtp.Lifecycle {
	return &observer{metrics: m, inner: inner}
}

type observer struct {
	metrics *Metrics
	inner   rtp.Lifecycle
}

func (o *observer) SessionEnded(session rtp.SessionSummary, reason rtp.EndReason) {
	m := o.metrics
	stats := session.Stats
	m.sessionsEnded.WithLabelValues(string(reason)).Inc()
	m.sessionSeconds.Observe(session.Duration.Seconds())
	m.packetsReceived.Add(float64(stats.PacketsReceived))
	m.packetsSent.Add(float64(stats.PacketsSent))
	m.bytesReceived.Add(float64(stats.BytesReceived))
	m.transcoded.Add(float64(stats.Transcoded))
	for reason, count := range map[string]uint64{
		"malformed":      stats.Malformed,
		"unsupported_pt": stats.UnsupportedPT,
		"foreign_source": stats.ForeignSource,
		"transport_rtp":  stats.TransportDroppedRTP,
		"transport_rtcp": stats.TransportDroppedRTCP,
	} {
		m.packetsDropped.WithLabelValues(reason).Add(float64(count))
	}
	for reason, count := range map[string]uint64{
		"playback": stats.SuppressedByPlayback,
		"dtmf":     stats.SuppressedByDtmf,
		"hold":     stats.SuppressedByHold,
		"mute":     stats.SuppressedByMute,
	} {
		m.framesSuppress.WithLabelValues(reason).Add(float64(count))
	}
	if o.inner != nil {
		o.inner.SessionEnded(session, reason)
	}
}

func (o *observer) RTPTimedOut(session rtp.SessionSummary, silentFor time.Duration) {
	o.metrics.rtpTimeouts.Inc()
	if o.inner != nil {
		o.inner.RTPTimedOut(session, silentFor)
	}
}

func (o *observer) PlaybackFinished(session rtp.SessionSummary, playback rtp.PlaybackSummary) {
	o.metrics.playbacks.WithLabelValues(string(playback.Reason)).Inc()
	if o.inner != nil {
		o.inner.PlaybackFinished(session, playback)
	}
}

// Called from the session's read goroutine, so this must not block on anything slower than an
// atomic — which is exactly what a Prometheus counter increment is.
func (o *observer) DtmfReceived(session rtp.SessionSummary, digit rtp.DtmfDigit) {
	o.metrics.dtmfDigits.Inc()
	if o.inner != nil {
		o.inner.DtmfReceived(session, digit)
	}
}

func (o *observer) RecordingFinished(session rtp.SessionSummary, recording rtp.RecordingSummary) {
	o.metrics.recordings.WithLabelValues(string(recording.Reason)).Inc()
	o.metrics.recordedSeconds.Observe(float64(recording.DurationMs) / 1000)
	if o.inner != nil {
		o.inner.RecordingFinished(session, recording)
	}
}
