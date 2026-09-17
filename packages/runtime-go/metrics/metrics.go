// Package metrics builds a service's Prometheus registry and the handler that exposes it.
//
// The registry is private rather than prometheus.DefaultRegisterer: a default registry is a
// process-global into which any dependency can register anything, and a test that builds two
// services in one process panics on the duplicate. Every collector here is owned by the Registry
// that made it.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Registry is one service's metric namespace and the collectors registered under it.
//
// Not safe to build collectors on concurrently; do it once at boot, before the goroutines that
// touch the metrics exist. The collectors themselves are safe for concurrent use.
type Registry struct {
	namespace string
	registry  *prometheus.Registry
}

// New returns a registry carrying the standard process and Go runtime collectors.
//
// namespace prefixes every metric this service defines (`sipd_registrations_total`), and does NOT
// prefix the process/go collectors — those keep their conventional names so a dashboard written
// against any Go service works here unchanged.
func New(namespace string) *Registry {
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		collectors.NewGoCollector(),
	)
	return &Registry{namespace: namespace, registry: registry}
}

// Handler serves the registry in the Prometheus text exposition format.
//
// Errors during a scrape are reported to the scraper as a 500 rather than logged and swallowed:
// a metrics endpoint that answers 200 with half a payload is worse than one that fails, because
// only the second is alertable.
func (r *Registry) Handler() http.Handler {
	return promhttp.HandlerFor(r.registry, promhttp.HandlerOpts{
		ErrorHandling:       promhttp.HTTPErrorOnError,
		MaxRequestsInFlight: 4,
	})
}

// Gatherer exposes the underlying registry for tests that want to read metric families directly.
func (r *Registry) Gatherer() prometheus.Gatherer { return r.registry }

// Counter registers a monotonic counter.
func (r *Registry) Counter(name, help string) prometheus.Counter {
	counter := prometheus.NewCounter(prometheus.CounterOpts{Namespace: r.namespace, Name: name, Help: help})
	r.registry.MustRegister(counter)
	return counter
}

// CounterVec registers a labelled monotonic counter.
//
// Label VALUES must come from a closed set the service controls — a reason enum, a transport, a
// SIP method. Never a tenant id, a call id or a SIP URI: every distinct value is a permanent time
// series, and an unbounded label is how a metrics endpoint becomes the thing that kills the
// process.
func (r *Registry) CounterVec(name, help string, labels ...string) *prometheus.CounterVec {
	counter := prometheus.NewCounterVec(prometheus.CounterOpts{Namespace: r.namespace, Name: name, Help: help}, labels)
	r.registry.MustRegister(counter)
	return counter
}

// CounterFunc registers a monotonic counter the service already keeps, read at scrape time.
//
// The right shape for a total something else owns — a lockout's failure count, a handler's
// dropped-notification tally. Mirroring such a value into a Counter of our own drifts the moment
// either side is reset. The function must be monotonic; Prometheus reads a decrease as a counter
// reset and treats the whole preceding interval as one increase.
func (r *Registry) CounterFunc(name, help string, read func() float64) {
	r.registry.MustRegister(prometheus.NewCounterFunc(
		prometheus.CounterOpts{Namespace: r.namespace, Name: name, Help: help}, read))
}

// Gauge registers a gauge.
func (r *Registry) Gauge(name, help string) prometheus.Gauge {
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{Namespace: r.namespace, Name: name, Help: help})
	r.registry.MustRegister(gauge)
	return gauge
}

// GaugeFunc registers a gauge whose value is read from the service at scrape time.
//
// The function runs on the scrape goroutine, so it must not block on I/O or take a lock that a
// request path holds — read an atomic or a cheap in-memory count.
func (r *Registry) GaugeFunc(name, help string, read func() float64) {
	r.registry.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{Namespace: r.namespace, Name: name, Help: help}, read))
}

// Histogram registers a histogram with the given upper bounds, in the metric's own unit.
func (r *Registry) Histogram(name, help string, buckets []float64) prometheus.Histogram {
	histogram := prometheus.NewHistogram(prometheus.HistogramOpts{
		Namespace: r.namespace, Name: name, Help: help, Buckets: buckets,
	})
	r.registry.MustRegister(histogram)
	return histogram
}

// HistogramVec registers a labelled histogram. The label rule on CounterVec applies here too, and
// harder: a histogram costs one series per bucket per label combination.
func (r *Registry) HistogramVec(name, help string, buckets []float64, labels ...string) *prometheus.HistogramVec {
	histogram := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: r.namespace, Name: name, Help: help, Buckets: buckets,
	}, labels)
	r.registry.MustRegister(histogram)
	return histogram
}

// SecondsBuckets covers a telephony request from a sub-millisecond cache hit to a ten-second
// carrier timeout. Wider at the top than the client_golang default, which stops at 10 s only by
// accident of its 5 ms start.
var SecondsBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}
