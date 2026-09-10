package health

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestReadinessTracksDependencies(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var ready atomic.Bool
	server, err := Start(ctx, "127.0.0.1:0", ready.Load)
	if err != nil {
		t.Fatal(err)
	}
	if err := Probe(server.Addr); err == nil {
		t.Fatal("reported ready before dependencies")
	}
	response, err := http.Get("http://" + server.Addr + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal("dependency loss failed liveness")
	}
	ready.Store(true)
	if err := Probe(server.Addr); err != nil {
		t.Fatal(err)
	}
	ready.Store(false)
	if err := Probe(server.Addr); err == nil {
		t.Fatal("dependency loss left readiness healthy")
	}
}

func TestPprofIsOffUnlessAsked(t *testing.T) {
	addr := startProbeServer(t)
	if status := probeStatus(t, addr, "/debug/pprof/"); status != http.StatusNotFound {
		t.Errorf("pprof answered %d on a listener that did not enable it", status)
	}
}

func TestPprofServesWhenEnabled(t *testing.T) {
	addr := startProbeServer(t, WithPprof(true))
	if status := probeStatus(t, addr, "/debug/pprof/"); status != http.StatusOK {
		t.Errorf("pprof answered %d with WithPprof(true)", status)
	}
}

func startProbeServer(t *testing.T, opts ...Option) string {
	t.Helper()
	server, err := Start(t.Context(), "127.0.0.1:0", func() bool { return true }, opts...)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return server.Addr
}

func probeStatus(t *testing.T, addr, path string) int {
	t.Helper()
	response, err := http.Get("http://" + addr + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func TestMetricsIsOffUnlessAsked(t *testing.T) {
	addr := startProbeServer(t)
	if status := probeStatus(t, addr, "/metrics"); status != http.StatusNotFound {
		t.Errorf("/metrics answered %d on a listener that did not enable it", status)
	}
}

func TestMetricsServesWhenEnabled(t *testing.T) {
	addr := startProbeServer(t, WithMetrics(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("# HELP up\n"))
	})))
	if status := probeStatus(t, addr, "/metrics"); status != http.StatusOK {
		t.Errorf("/metrics answered %d with WithMetrics", status)
	}
}
