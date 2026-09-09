package health

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestReadinessTracksDependencies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
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
