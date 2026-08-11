// Command sipd is the Optimiq Voice SIP edge (plan §3.2, §3.4 option E).
//
// Today it is a REGISTRAR: it authenticates REGISTER with digest, writes AOR → contact bindings
// into the `registrations` NATS KV bucket, publishes sip.reg.v1 transitions onto the REGISTRATIONS
// stream, and answers OPTIONS. It also answers REFER — a desk phone's TRANSFER key — by asking the
// engine over `rpc.sip.v1.transfer` and reporting the outcome back per RFC 3515; see
// internal/transfer.
//
// And it is the fleet's NOTIFIER: SUBSCRIBE for RFC 4235 `dialog` (busy-lamp keys, read from the
// `presence` KV bucket apps/engine writes) and RFC 3842 `message-summary` (the voicemail lamp, from
// `voicemail.evt.v1.*.*.mwi.updated`); see internal/subscribe. The proxy/INVITE path — the half that
// lets it retire Routr — is the next PG wave; see the README.
//
// Configuration is entirely environmental; run with no arguments.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/subscribe"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/transfer"
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

	natsOpts := []nats.Option{
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
	}
	// Only when configured: an empty pair means a broker with no authentication, which is what the
	// SIPp rig and the integration tests run. config.Load has already refused a half-set pair, and
	// has already preferred NATS_SIPD_USER/PASS over the shared pair — so this is the `sipd` user,
	// whose permissions in config/nats.conf are sip.reg.v1.>, the two rpc.sip.v1 requests, the
	// registrations bucket, READ-ONLY access to the presence bucket and the MWI event family, and
	// nothing else.
	if cfg.NATSUser != "" {
		natsOpts = append(natsOpts, nats.UserInfo(cfg.NATSUser, cfg.NATSPass))
	}
	// Transport security, off unless configured. RootCAs both enables TLS and pins the bundle, so
	// it covers the private-CA case on its own; Secure is the system-trust-store case. Neither set
	// leaves the connection plaintext, which is what the broker in compose.yaml serves.
	switch {
	case cfg.NATSTLSCA != "":
		natsOpts = append(natsOpts, nats.RootCAs(cfg.NATSTLSCA))
	case cfg.NATSTLSEnabled:
		natsOpts = append(natsOpts, nats.Secure())
	}

	conn, err := nats.Connect(cfg.NATSURL, natsOpts...)
	if err != nil {
		// A rejected credential lands here as "nats: Authorization Violation" and takes the process
		// down with it. That is deliberate: a SIP edge that cannot reach the credential RPC cannot
		// authenticate a REGISTER, so a "degraded" sipd is one that answers every phone with 500.
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

	// The presence bucket: apps/engine writes it, this edge only ever reads and watches it. Opened
	// at boot rather than lazily so a broker that will not serve it fails the process here, with the
	// bucket named, instead of on the first BLF key a receptionist presses.
	presenceStore, err := presence.Open(ctx, js)
	if err != nil {
		return err
	}

	credentialStore, err := openCredentialStore(cfg, conn, log)
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
		AllowEvents:      subscribe.AllowEvents,
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

	// The client half. It exists to originate NOTIFY, and nothing else: the RFC 3515 report that
	// tells a phone how its transfer went, and the RFC 6665 notifications that move its lamps. A
	// registrar otherwise never originates a request, which is why sipd had no client at all until
	// REFER arrived.
	sipClient, err := sipgo.NewClient(userAgent, sipgo.WithClientLogger(log))
	if err != nil {
		return fmt.Errorf("creating the SIP client: %w", err)
	}
	defer sipClient.Close()

	transfers, err := newTransferHandler(cfg, conn, sipClient, authenticator, credentialStore, bindings, ctx, log)
	if err != nil {
		return err
	}

	subscriptions, err := newSubscribeHandler(
		cfg, conn, sipClient, authenticator, credentialStore, bindings, presenceStore, ctx, log)
	if err != nil {
		return err
	}

	server.OnRegister(reg.HandleRegister)
	server.OnOptions(reg.HandleOptions)
	server.OnRefer(transfers.HandleRefer)
	server.OnSubscribe(subscriptions.HandleSubscribe)
	// Everything else — INVITE, MESSAGE, PUBLISH, … — is honestly refused until the proxy wave.
	server.OnNoRoute(reg.HandleUnsupported)

	var group sync.WaitGroup
	errs := make(chan error, 4)

	group.Add(1)
	go func() {
		defer group.Done()
		if err := reg.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			errs <- err
		}
	}()

	group.Add(1)
	go func() {
		defer group.Done()
		if err := subscriptions.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
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

	// Outcome reports first: a phone left holding a 202 with no final NOTIFY keeps its transfer
	// indicator lit until the dialog dies, and these finish in well under a second.
	if !transfers.Wait(cfg.ShutdownTimeout) {
		log.Warn("some transfer outcomes were not reported before shutdown")
	}

	// Then the subscriptions. `terminated;reason=deactivated` is RFC 6665's "re-subscribe now", so
	// every lamp this instance was serving moves to a surviving one within a round trip instead of
	// freezing until its subscription lapses. The context is fresh and short: ctx is already
	// cancelled by this point, and a cancelled context would drop every one of these.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	if deactivated := subscriptions.Shutdown(shutdownCtx); deactivated > 0 {
		log.Info("told subscribers to re-subscribe", "count", deactivated)
	}
	cancelShutdown()
	if !subscriptions.Wait(cfg.ShutdownTimeout) {
		log.Warn("some subscription notifications were not delivered before shutdown")
	}
	if !waitFor(&group, cfg.ShutdownTimeout) {
		log.Warn("shutdown timed out; exiting anyway")
	}
	log.Info("stopped")
	return nil
}

// newTransferHandler wires REFER: digest against the same authenticator the registrar uses, the
// location service as the "is this phone actually here" check, `rpc.sip.v1.transfer` at the engine,
// and NOTIFY back to the phone.
//
// It is always wired. There is no toggle, because the failure mode without the engine responder is
// already correct and visible: the phone is accepted, the request times out, and the final NOTIFY
// carries `503`. A toggle would replace that with a `501` that looks like the feature was never
// built, which is the same message with less information in it.
func newTransferHandler(
	cfg config.Config,
	conn *nats.Conn,
	client *sipgo.Client,
	authenticator *registrar.Authenticator,
	credentialStore credentials.Store,
	bindings kv.Store,
	ctx context.Context,
	log *slog.Logger,
) (*transfer.Handler, error) {
	contact := contactURI(cfg)
	requester, err := transfer.NewNATSRequester(conn, transfer.NATSOptions{})
	if err != nil {
		return nil, err
	}
	notifier, err := transfer.NewClientNotifier(client)
	if err != nil {
		return nil, err
	}

	handler, err := transfer.New(transfer.Options{
		Realm:        cfg.Realm,
		Auth:         authenticator,
		Credentials:  credentialStore,
		Bindings:     bindings,
		Transfers:    requester,
		Notifier:     notifier,
		Contact:      contactURI(cfg),
		Logger:       log,
		ServerHeader: cfg.UserAgent,
		BaseContext:  ctx,
		AuthTimeout:  3 * time.Second,
	})
	if err != nil {
		return nil, err
	}

	log.Info("REFER handling ready",
		"subject", requester.Subject(),
		"timeout", contract.TimeoutSipTransferRPC,
		"contact", contact.String())
	return handler, nil
}

// newSubscribeHandler wires SUBSCRIBE/NOTIFY: digest against the same authenticator the registrar
// uses, the location service as the "is this phone actually here" check, the `presence` KV bucket
// for the busy-lamp state and `voicemail.evt.v1.*.*.mwi.updated` for the message-waiting one.
//
// Like REFER it is always wired, and for the same reason: there is no useful degraded mode. A
// deployment where apps/engine is not yet publishing presence gets subscriptions that are accepted
// and notified `down`, which is exactly what a fleet of idle phones looks like and exactly what the
// lamps should show.
func newSubscribeHandler(
	cfg config.Config,
	conn *nats.Conn,
	client *sipgo.Client,
	authenticator *registrar.Authenticator,
	credentialStore credentials.Store,
	bindings kv.Store,
	presenceStore presence.Store,
	ctx context.Context,
	log *slog.Logger,
) (*subscribe.Handler, error) {
	mwiSource, err := mwi.NewNATSSource(conn, log)
	if err != nil {
		return nil, err
	}
	notifier, err := subscribe.NewClientNotifier(client)
	if err != nil {
		return nil, err
	}

	handler, err := subscribe.New(subscribe.Options{
		Realm:       cfg.Realm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Bindings:    bindings,
		Presence:    presenceStore,
		MWI:         mwiSource,
		Notifier:    notifier,
		Contact:     contactURI(cfg),
		Expiry: subscribe.ExpiryPolicy{
			Min:     cfg.SubscribeMinExpires,
			Max:     cfg.SubscribeMaxExpires,
			Default: cfg.SubscribeDefaultExpires,
		},
		Logger:        log,
		ServerHeader:  cfg.UserAgent,
		BaseContext:   ctx,
		AuthTimeout:   3 * time.Second,
		SweepInterval: cfg.SweepInterval,
	})
	if err != nil {
		return nil, err
	}

	log.Info("SUBSCRIBE handling ready",
		"events", subscribe.AllowEvents,
		"presenceBucket", contract.PresenceKV.Name,
		"mwiSubject", mwi.Subject,
		"maxExpiresSeconds", int(cfg.SubscribeMaxExpires/time.Second))
	return handler, nil
}

// contactURI is what this edge puts in the Contact header of its 202 and its notifications.
//
// The host comes from the listen address, EXCEPT when that address is a wildcard — `0.0.0.0:5060` is
// the default and is not an address any phone can send to. In that case the realm is used, which is
// the name the handsets were provisioned with and therefore the one that resolves. Neither is
// clever; the alternative is a Contact the phone silently cannot reach, and a NOTIFY that never
// arrives is indistinguishable from a transfer that never happened.
func contactURI(cfg config.Config) sip.Uri {
	host, port := cfg.Realm, 0
	if listenHost, listenPort, err := net.SplitHostPort(cfg.ListenAddr); err == nil {
		switch listenHost {
		case "", "0.0.0.0", "::", "[::]":
		default:
			host = listenHost
		}
		if parsed, err := strconv.Atoi(listenPort); err == nil {
			port = parsed
		}
	}
	return sip.Uri{Scheme: "sip", User: cfg.UserAgent, Host: host, Port: port}
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

func openCredentialStore(cfg config.Config, conn *nats.Conn, log *slog.Logger) (credentials.Store, error) {
	switch cfg.CredentialSource {
	case config.CredentialSourceFile:
		store, err := credentials.NewFileStore(cfg.CredentialsFile, credentials.FileStoreOptions{
			ProvisionSecretKey: cfg.ProvisionSecretKey,
		})
		if err != nil {
			return nil, err
		}
		log.Info("credential store ready",
			"source", "file", "path", cfg.CredentialsFile, "accounts", store.Len())
		log.Warn("the file credential store is for development and the SIPp rig only; " +
			"production uses SIPD_CREDENTIAL_SOURCE=nats")
		return store, nil
	case config.CredentialSourceNATS:
		store, err := credentials.NewNATSStore(conn, credentials.NATSOptions{
			Timeout:     cfg.CredentialTimeout,
			PositiveTTL: cfg.CredentialCacheTTL,
			NegativeTTL: cfg.CredentialNegativeCacheTTL,
			MaxEntries:  cfg.CredentialCacheMaxEntries,
		})
		if err != nil {
			return nil, err
		}
		// No probe request at boot. A registrar that refused to start because the control plane
		// was briefly down would turn an API deploy into a SIP outage, and the failure mode
		// without a probe is already correct: every REGISTER is refused with a logged reason
		// until the responder answers, and recovers on its own the moment it does.
		log.Info("credential store ready",
			"source", "nats",
			"subject", contract.SubjectSipCredentialRPC,
			"timeout", cfg.CredentialTimeout,
			"cacheTtl", cfg.CredentialCacheTTL,
			"negativeCacheTtl", cfg.CredentialNegativeCacheTTL)
		if cfg.ProvisionSecretKey != "" {
			log.Warn("SIPD_PROVISION_SECRET_KEY is set but SIPD_CREDENTIAL_SOURCE=nats does not " +
				"use it: the API derives every password and ships an ha1. Unset it — the SIP edge " +
				"should not hold a key that derives every tenant's credential.")
		}
		return store, nil
	default:
		return nil, fmt.Errorf("unsupported credential source %q", cfg.CredentialSource)
	}
}
