// Package metrics exposes sipd's Prometheus surface on the private health listener.
//
// It observes the SIP layer from OUTSIDE the handlers: every counter here comes from wrapping a
// sip.RequestHandler and reading the final response the handler sent, not from instrumentation
// scattered through the registrar, the INVITE path and the subscription table. That keeps the
// telemetry in one file whose cardinality can be reasoned about, and it means a handler cannot
// forget to count itself.
package metrics

import (
	"strconv"
	"sync/atomic"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	runtimemetrics "github.com/optimiqs/optimiq-voice/packages/runtime-go/metrics"
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds sipd's collectors. Build one at boot with New; nil is not usable.
type Metrics struct {
	registry *runtimemetrics.Registry

	requests      *prometheus.CounterVec
	responses     *prometheus.CounterVec
	registrations *prometheus.CounterVec
	authFailures  *prometheus.CounterVec
	duration      *prometheus.HistogramVec
}

// New registers sipd's collectors under the `sipd_` namespace.
func New() *Metrics {
	registry := runtimemetrics.New("sipd")
	return &Metrics{
		registry: registry,
		requests: registry.CounterVec("sip_requests_total",
			"SIP requests received, by method.", "method"),
		responses: registry.CounterVec("sip_responses_total",
			"Final SIP responses sent, by method and status code.", "method", "status"),
		registrations: registry.CounterVec("registrations_total",
			"REGISTER transactions by outcome: accepted, challenged or refused.", "outcome"),
		authFailures: registry.CounterVec("auth_failures_total",
			"Requests refused for a credential reason (403), by method. A 401/407 challenge is NOT a failure — it is the first half of every digest exchange — and is counted as `challenged` on registrations_total instead.",
			"method"),
		duration: registry.HistogramVec("sip_handler_duration_seconds",
			"Time spent inside the request handler, by method. NOT time-to-final-response: the INVITE and REFER handlers answer asynchronously and return long before the transaction is finished.",
			runtimemetrics.SecondsBuckets, "method"),
	}
}

// Registry is the runtime registry, for health.WithMetrics.
func (m *Metrics) Registry() *runtimemetrics.Registry { return m.registry }

// Gauge registers a value read from the service at scrape time. The function must not block.
func (m *Metrics) Gauge(name, help string, read func() int) {
	m.registry.GaugeFunc(name, help, func() float64 { return float64(read()) })
}

// Counter registers a counter whose value the service already keeps, read at scrape time.
//
// For a total the service maintains itself (a lockout's failure count, a subscription handler's
// dropped notifications) this is the honest shape: mirroring it into a second counter would drift
// the moment either side is reset.
func (m *Metrics) Counter(name, help string, read func() uint64) {
	m.registry.CounterFunc(name, help, func() float64 { return float64(read()) })
}

// Wrap decorates a request handler so the transaction it answers is counted and timed.
//
// The method label is the one passed in rather than `req.Method`, because a handler is registered
// per method and a request that reached it with another method is a routing bug worth seeing as
// the method it was ROUTED as. `OnNoRoute` passes "unsupported" for the same reason: the actual
// method there is unbounded-ish (any token a caller invents) and has no place in a label.
func (m *Metrics) Wrap(method string, next sipgo.RequestHandler) sipgo.RequestHandler {
	return func(req *sip.Request, tx sip.ServerTransaction) {
		m.requests.WithLabelValues(method).Inc()
		started := time.Now()
		observer := &responseObserver{ServerTransaction: tx}
		next(req, observer)
		m.duration.WithLabelValues(method).Observe(time.Since(started).Seconds())

		status := observer.status()
		if status == 0 {
			// A handler that answered nothing: the transaction was absorbed (an ACK, a CANCEL race)
			// or it will be answered later out of band. Counted as a distinct status so it is
			// visible rather than silently missing from the response total.
			m.responses.WithLabelValues(method, "none").Inc()
			return
		}
		m.responses.WithLabelValues(method, strconv.Itoa(status)).Inc()
		if status == 403 {
			m.authFailures.WithLabelValues(method).Inc()
		}
		if method == "REGISTER" {
			switch {
			case status < 300:
				m.registrations.WithLabelValues("accepted").Inc()
			case status == 401 || status == 407:
				m.registrations.WithLabelValues("challenged").Inc()
			default:
				m.registrations.WithLabelValues("refused").Inc()
			}
		}
	}
}

// responseObserver records the FIRST final response a handler sends.
//
// First rather than last: a provisional 100/180 is not the outcome, and a handler that sends a
// second final response on the same transaction has already been answered by the first as far as
// the caller is concerned.
//
// It embeds the interface rather than reimplementing it, so a sipgo release that grows the
// ServerTransaction contract keeps compiling here and keeps whatever the real transaction does.
// An atomic because the handlers that answer asynchronously (INVITE, REFER) respond from another
// goroutine, and the wrapper reads the status the moment the handler returns.
type responseObserver struct {
	sip.ServerTransaction
	final atomic.Int32
}

func (o *responseObserver) Respond(res *sip.Response) error {
	err := o.ServerTransaction.Respond(res)
	if res != nil && res.StatusCode >= 200 {
		o.final.CompareAndSwap(0, int32(res.StatusCode))
	}
	return err
}

func (o *responseObserver) status() int { return int(o.final.Load()) }
