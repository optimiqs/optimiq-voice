// Package health provides private process and dependency probes for the data plane.
package health

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

type Server struct {
	Addr   string
	Errors <-chan error
}

// Start binds synchronously. An empty address disables the optional HTTP listener.
func Start(ctx context.Context, addr string, ready func() bool) (*Server, error) {
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
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 4096}
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
