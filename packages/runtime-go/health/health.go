// Package health provides private process and dependency probes for the data plane.
package health

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"strings"
	"time"
)

// Option configures the health listener.
type Option func(*options)

type options struct {
	pprof   bool
	metrics http.Handler
}

// WithPprof serves net/http/pprof under /debug/pprof/ on this listener.
//
// It belongs here and NOWHERE else, because this listener is the private one: a profiling endpoint
// reachable from outside is a denial of service and a memory disclosure.
func WithPprof(enabled bool) Option {
	return func(o *options) { o.pprof = enabled }
}

// WithMetrics serves a Prometheus exposition handler at /metrics on this listener.
//
// On the PRIVATE listener for the same reason as pprof, and it is a weaker reason but still a
// real one: a metrics payload names every tenant-visible thing the service counts — call volume,
// registration counts, authentication failures — and that is reconnaissance, not telemetry, in
// the hands of anyone who is not the scraper.
//
// A nil handler leaves the route unregistered, so a service can pass its option through
// unconditionally and decide with configuration.
func WithMetrics(handler http.Handler) Option {
	return func(o *options) { o.metrics = handler }
}

// Server is a started health listener; Errors reports a serve failure.
type Server struct {
	Addr   string
	Errors <-chan error
}

// Start binds synchronously. An empty address disables the optional HTTP listener.
func Start(ctx context.Context, addr string, ready func() bool, opts ...Option) (*Server, error) {
	var settings options
	for _, opt := range opts {
		opt(&settings)
	}
	errs := make(chan error, 1)
	result := &Server{Errors: errs}
	if addr == "" {
		return result, nil
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("binding health listener: %w", err)
	}
	result.Addr = listener.Addr().String()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"alive"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if ctx.Err() != nil || !ready() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"not_ready"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	if settings.metrics != nil {
		mux.Handle("GET /metrics", settings.metrics)
	}
	if settings.pprof {
		// Registered by hand rather than via the package init's http.DefaultServeMux, which would
		// put these handlers on every other listener in the process that uses that mux.
		mux.HandleFunc("GET /debug/pprof/", pprof.Index)
		mux.HandleFunc("GET /debug/pprof/cmdline", pprof.Cmdline)
		mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
		mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: writeTimeout(settings), IdleTimeout: 30 * time.Second, MaxHeaderBytes: 4096}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	return result, nil
}

// Probe lets a static binary act as its own container health check.
func Probe(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("health redirect refused") }}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + net.JoinHostPort(host, port) + "/readyz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("service is not ready: %s", strings.TrimSpace(response.Status))
	}
	return nil
}

// writeTimeout is generous when pprof is on: `go tool pprof -seconds=30` holds one response open
// for the whole sample, and the probe timeout would truncate it.
func writeTimeout(settings options) time.Duration {
	if settings.pprof {
		return 2 * time.Minute
	}
	return 3 * time.Second
}
