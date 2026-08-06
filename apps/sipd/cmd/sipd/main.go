// Command sipd is the Optimiq Voice SIP edge (plan §3.2, §3.4 option E).
//
// Today it is a REGISTRAR: it authenticates REGISTER with digest, writes AOR → contact bindings
// into the `registrations` NATS KV bucket, publishes sip.reg.v1 transitions onto the REGISTRATIONS
// stream, and answers OPTIONS. The proxy/INVITE path — the half that lets it retire Routr — is the
// next PG wave; see the README.
//
// Configuration is entirely environmental; run with no arguments.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/emiago/sipgo"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
)

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		// The logger may not exist yet when configuration fails, so this one line goes to stderr
		// directly. Everything after boot is structured JSON.
		fmt.Fprintf(os.Stderr, "sipd: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)
	log = log.With("service", config.EventSource)

	// SIGINT/SIGTERM cancel this context; every listener, the sweeper and every in-flight KV write
	// hang off it, so shutdown is one cancel rather than a chain of Close calls that race.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, err := nats.Connect(cfg.NATSURL,
		nats.Name(config.EventSource),
		// A SIP edge must survive a broker restart without dropping registrations: it keeps
		// answering REGISTER from the credential store and catches up on events afterwards.
		nats.MaxReconnects(-1),
		nats.ReconnectWait(time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Warn("nats disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			log.Info("nats reconnected", "url", c.ConnectedUrl())
		}),
	)
	if err != nil {
		return fmt.Errorf("connecting to NATS at %s: %w", cfg.NATSURL, err)
	}
	defer func() {
		if err := conn.Drain(); err != nil {
			log.Warn("draining the NATS connection", "error", err)
		}
	}()

	js, err := jetstream.New(conn)
	if err != nil {
		return fmt.Errorf("opening JetStream: %w", err)
	}

	bindings, err := kv.Open(ctx, js)
	if err != nil {
		return err
	}

	credentialStore, err := openCredentialStore(cfg, log)
	if err != nil {
		return err
	}

	authenticator, err := registrar.NewAuthenticator(cfg.Realm, []byte(cfg.NonceSecret), cfg.NonceTTL)
	if err != nil {
		return err
	}
	if cfg.NonceSecret == "" {
		log.Warn("SIPD_NONCE_SECRET is unset; a random per-process secret was generated. " +
			"Set it fleet-wide before running more than one replica, or a device challenged by " +
			"one instance will be rejected by another.")
	}

	reg, err := registrar.New(registrar.Options{
		Realm:            cfg.Realm,
		Auth:             authenticator,
		Expiry:           registrar.ExpiryPolicy{Min: cfg.MinExpires, Max: cfg.MaxExpires, Default: cfg.DefaultExpires},
		Credentials:      credentialStore,
		Bindings:         bindings,
		Publisher:        events.NewJetStreamPublisher(js),
		Logger:           log,
		Source:           config.EventSource,
		ServerHeader:     cfg.UserAgent,
		SweepInterval:    cfg.SweepInterval,
		BaseContext:      ctx,
		OperationTimeout: 3 * time.Second,
	})
	if err != nil {
		return err
	}

	// Adopt whatever a previous instance left behind before accepting traffic, so a restart does
	// not leave devices expiring on the bucket's one-hour backstop.
	adopted, err := reg.Rehydrate(ctx)
	if err != nil {
		log.Warn("cannot rehydrate existing bindings; they will expire on the bucket TTL", "error", err)
	} else if adopted > 0 {
		log.Info("adopted existing bindings", "count", adopted)
	}

	userAgent, err := sipgo.NewUA(sipgo.WithUserAgent(cfg.UserAgent))
	if err != nil {
		return fmt.Errorf("creating the SIP user agent: %w", err)
	}
	defer userAgent.Close()

	server, err := sipgo.NewServer(userAgent, sipgo.WithServerLogger(log))
	if err != nil {
		return fmt.Errorf("creating the SIP server: %w", err)
	}
	defer server.Close()

	server.OnRegister(reg.HandleRegister)
	server.OnOptions(reg.HandleOptions)
	// Everything else — INVITE, SUBSCRIBE, MESSAGE, … — is honestly refused until the proxy wave.
	server.OnNoRoute(reg.HandleUnsupported)

	var group sync.WaitGroup
	errs := make(chan error, 3)

	group.Add(1)
	go func() {
		defer group.Done()
		if err := reg.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			errs <- err
		}
	}()

	listen := func(network string) {
		group.Add(1)
		go func() {
			defer group.Done()
			log.Info("listening", "network", network, "addr", cfg.ListenAddr, "realm", cfg.Realm)
			// ListenAndServe closes its listener when ctx is done and returns; a post-shutdown
			// error is the close itself, not a failure.
			if err := server.ListenAndServe(ctx, network, cfg.ListenAddr); err != nil && ctx.Err() == nil {
				errs <- fmt.Errorf("%s listener: %w", network, err)
			}
		}()
	}
	if cfg.EnableUDP {
		listen("udp")
	}
	if cfg.EnableTCP {
		listen("tcp")
	}

	select {
	case <-ctx.Done():
		log.Info("shutting down", "timeoutSeconds", int(cfg.ShutdownTimeout/time.Second))
	case err := <-errs:
		log.Error("stopping after a fatal error", "error", err)
		stop()
		waitFor(&group, cfg.ShutdownTimeout)
		return err
	}

	if !waitFor(&group, cfg.ShutdownTimeout) {
		log.Warn("shutdown timed out; exiting anyway")
	}
	log.Info("stopped")
	return nil
}

// waitFor blocks until the group finishes or the timeout elapses. It reports whether the group
// finished, so shutdown is bounded and a stuck listener cannot hold a pod in Terminating forever.
func waitFor(group *sync.WaitGroup, timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		group.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func openCredentialStore(cfg config.Config, log *slog.Logger) (credentials.Store, error) {
	switch cfg.CredentialSource {
	case config.CredentialSourceFile:
		store, err := credentials.NewFileStore(cfg.CredentialsFile)
		if err != nil {
			return nil, err
		}
		log.Info("credential store ready",
			"source", "file", "path", cfg.CredentialsFile, "accounts", store.Len())
		log.Warn("the file credential store is for development and the SIPp rig only; " +
			"production uses SIPD_CREDENTIAL_SOURCE=nats once rpc.sip.v1.credential exists")
		return store, nil
	case config.CredentialSourceNATS:
		// Constructing it succeeds and Lookup fails, so a misconfiguration surfaces as a 403 with a
		// loud log rather than a silent boot into an edge that authenticates nobody.
		log.Error("SIPD_CREDENTIAL_SOURCE=nats is not implemented yet; every REGISTER will be refused",
			"error", credentials.ErrNotImplemented)
		return credentials.NewNATSStore(500 * time.Millisecond), nil
	default:
		return nil, fmt.Errorf("unsupported credential source %q", cfg.CredentialSource)
	}
}
