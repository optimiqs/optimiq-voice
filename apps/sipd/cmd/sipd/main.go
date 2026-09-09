// Command sipd is the Optimiq Voice SIP edge.
//
// It is the registrar: it authenticates REGISTER with digest, writes AOR to contact bindings into
// the `registrations` NATS KV bucket, publishes sip.reg.v1 transitions onto the REGISTRATIONS
// stream, and answers OPTIONS. It answers REFER by asking the engine over `rpc.sip.v1.transfer` and
// reporting the outcome per RFC 3515 (internal/transfer), and it is the fleet's notifier for
// RFC 4235 `dialog` and RFC 3842 `message-summary` subscriptions (internal/subscribe).
//
// Configuration is entirely environmental; run with no arguments.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/health"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/netbuf"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/proclimit"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/acl"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/command"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/invite"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/reaper"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/subscribe"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/transfer"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/trunk"
)

func main() {
	var err error
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		err = health.Probe(os.Getenv("SIPD_HEALTH_ADDR"))
	} else {
		err = run()
	}
	if err != nil && !errors.Is(err, context.Canceled) {
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

	// A soft heap limit derived from the container's, so memory pressure becomes GC pressure rather
	// than an OOM kill that drops every dialog this instance holds.
	if applied := proclimit.ApplyMemoryLimit(os.Getenv, proclimit.DefaultHeadroomPercent); applied > 0 {
		log.Info("applied a soft memory limit from the container's",
			"goMemLimitBytes", applied, "gomaxprocs", runtime.GOMAXPROCS(0))
	}

	// SIGINT/SIGTERM cancel this context; every listener, the sweeper and every in-flight KV write
	// hang off it, so shutdown is one cancel rather than a chain of Close calls that race.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	natsOpts := []nats.Option{
		nats.Name(config.EventSource),
		// A SIP edge must survive a broker restart without dropping registrations: it keeps
		// answering REGISTER from the credential store and catches up on events afterwards.
		nats.MaxReconnects(-1),
		nats.CustomInboxPrefix("_INBOX.sipd"),
		nats.ReconnectWait(time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Warn("nats disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			log.Info("nats reconnected", "url", c.ConnectedUrl())
		}),
	}
	// Only when configured: an empty pair means a broker with no authentication, which is what the
	// SIPp rig and the integration tests run. config.Load has already refused a half-set pair and
	// preferred NATS_SIPD_USER/PASS, so this is the least-privilege `sipd` user of config/nats.conf.
	if cfg.NATSUser != "" {
		natsOpts = append(natsOpts, nats.UserInfo(cfg.NATSUser, cfg.NATSPass))
	}
	// Transport security, off unless configured. RootCAs both enables TLS and pins the bundle (the
	// private-CA case); Secure is the system-trust-store case. Neither set leaves it plaintext.
	switch {
	case cfg.NATSTLSCA != "":
		natsOpts = append(natsOpts, nats.RootCAs(cfg.NATSTLSCA))
	case cfg.NATSTLSEnabled:
		natsOpts = append(natsOpts, nats.Secure())
	}

	conn, err := nats.Connect(cfg.NATSURL, natsOpts...)
	if err != nil {
		// A rejected credential lands here as "nats: Authorization Violation" and takes the process
		// down. An edge that cannot reach the credential RPC cannot authenticate a REGISTER, so a
		// degraded sipd would answer every phone with 500.
		return fmt.Errorf("connecting to NATS at %s: %w", cfg.NATSURL, err)
	}
	defer func() {
		if err := conn.Drain(); err != nil {
			log.Warn("draining the NATS connection", "error", err)
		}
	}()

	// Events leave asynchronously so the PubAck does not sit inside a SIP transaction. A failed ack
	// is reported here rather than at the call site, the pending window bounds what a broker stall
	// can buffer, and the timeout stops a lost ack pinning a slot for ever.
	js, err := jetstream.New(conn,
		jetstream.WithPublishAsyncErrHandler(func(_ jetstream.JetStream, msg *nats.Msg, err error) {
			log.Error("a JetStream publish was not acknowledged",
				"subject", msg.Subject, "msgId", msg.Header.Get(jetstream.MsgIDHeader), "error", err)
		}),
		jetstream.WithPublishAsyncMaxPending(cfg.PublishAsyncMaxPending),
		jetstream.WithPublishAsyncTimeout(cfg.PublishAsyncTimeout),
	)
	if err != nil {
		return fmt.Errorf("opening JetStream: %w", err)
	}
	// Outstanding acks are drained before the connection is, so a shutdown does not discard events a
	// synchronous publish would have delivered.
	defer flushPublishes(js, log, cfg.ShutdownTimeout)

	bindings, err := kv.Open(ctx, js)
	if err != nil {
		return err
	}

	// The presence bucket: apps/engine writes it, this edge only reads and watches it. Opened at
	// boot so a broker that will not serve it fails the process here, with the bucket named, rather
	// than on the first BLF key pressed.
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
		InstanceID:       cfg.InstanceID,
		MaxContacts:      cfg.MaxContactsPerAOR,
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

	// The registrar's expiry table doubles as the store's last-known-value hint, so a re-REGISTER
	// CASes against the revision this process committed instead of reading it back first.
	bindings.SetHint(reg)

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

	// The client half exists to originate NOTIFY and nothing else: the RFC 3515 transfer report and
	// the RFC 6665 lamp notifications.
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

	var group sync.WaitGroup
	errs := make(chan error, 8)

	// The two watched read models, and the state they feed.
	//
	// Opened before the INVITE surface because the ACL is a security boundary: a listener accepting
	// traffic before its ACL loaded fails closed, at the cost of a carrier outage. Non-fatal when
	// absent because apps/api writes these buckets, and a control plane that has not deployed yet
	// must not stop this edge serving REGISTER.
	trunkDirectory := trunk.NewDirectory(log)
	if cfg.EnableInvite {
		// There is always a broker by this point, so the publisher is always the JetStream one;
		// trunk.LogPublisher stays for the tests.
		var statusPublisher trunk.Publisher = trunk.NewJetStreamPublisher(js, config.EventSource)

		registrarClient, err := trunk.NewClientRegistrar(sipClient, trunk.RegistrarOptions{
			Contact:   contactURI(cfg),
			UserAgent: cfg.UserAgent,
			Auth:      trunk.NewNATSAuthorizer(conn),
		})
		if err != nil {
			return err
		}
		supervisor, err := trunk.NewSupervisor(trunk.SupervisorOptions{
			Registrar: registrarClient,
			Publisher: statusPublisher,
			Logger:    log,
		})
		if err != nil {
			return err
		}
		defer supervisor.Stop()

		// The directory drives the supervisor; the `trunks` bucket is internal/trunk's ingestion seam.
		trunkDirectory.OnChange(func() { supervisor.Apply(ctx, trunkDirectory.Configs()) })

		watchWhenAvailable(ctx, log, contract.TrunksKV.Name, time.Second, func() error {
			bucket, err := trunk.OpenDirectoryBucket(ctx, js)
			if err != nil {
				return err
			}
			_, err = trunk.Watch(ctx, bucket, trunkDirectory)
			return err
		})
	}

	// The dialog table and its claim bucket.
	//
	// The claim store is the NATS one whenever the bucket can be opened. The memory one lets a
	// single instance work but reaps nothing — a claim only one process can see is one no survivor
	// can act on — so landing on it warns rather than downgrading silently.
	dialogs := dialog.NewStore(dialog.StoreOptions{InstanceID: cfg.InstanceID})
	var claimStore dialog.ClaimStore
	var claims dialog.ClaimStore = dialog.NewMemoryClaimStore()
	if cfg.EnableInvite {
		if store, err := dialog.OpenClaims(ctx, js); err != nil {
			log.Warn("cannot open the sip-dialogs bucket; this instance's dialogs will not be reaped "+
				"if it dies, and the engine will hold channels for calls that ended with it",
				"bucket", contract.SIPDialogsKV.Name, "error", err)
		} else {
			claimStore = store
			claims = store
		}
	}

	// The dialog event publisher. There is always a broker by this point, so the seam exists for the
	// tests rather than for a degraded production mode.
	dialogEvents := sipevents.NewJetStreamPublisher(js)

	// The INVITE surface, off unless SIPD_INVITE says otherwise: turning it on makes a registrar
	// into a call-processing element, which needs dialog affinity at the load balancer, a trunk
	// directory and an ACL bucket already in place.
	if cfg.EnableInvite {
		invites, err := newInviteHandler(inviteDeps{
			cfg:         cfg,
			server:      server,
			client:      sipClient,
			conn:        conn,
			bindings:    bindings,
			trunks:      trunkDirectory,
			dialogs:     dialogs,
			claims:      claims,
			events:      dialogEvents,
			auth:        authenticator,
			credentials: credentialStore,
			ctx:         ctx,
			log:         log,
		})
		if err != nil {
			return err
		}
		server.OnInvite(invites.ServeInvite)
		server.OnAck(invites.HandleAck)
		server.OnBye(invites.HandleBye)
		server.OnCancel(invites.HandleCancel)
		server.OnUpdate(invites.HandleUpdate)
		server.OnInfo(invites.HandleInfo)

		// Attached after the SIP handlers are registered, so a command cannot arrive for a dialog
		// whose handler is not yet installed.
		commands, err := command.NewServer(command.Options{
			Dialogs:    invites,
			InstanceID: cfg.InstanceID,
			Logger:     log,
		})
		if err != nil {
			return err
		}
		subscriptionsForCommands, err := commands.Subscribe(conn)
		if err != nil {
			return err
		}
		defer func() {
			for _, subscription := range subscriptionsForCommands {
				if err := subscription.Unsubscribe(); err != nil {
					log.Debug("unsubscribing a command subject", "error", err)
				}
			}
		}()
		log.Info("dialog command surface ready",
			"instanceId", cfg.InstanceID,
			"instanceToken", commands.Token(),
			"subjects", commands.Subjects(),
			"originateQueueGroup", command.OriginateQueueGroup)

		// The claim reaper turns a dead instance's calls into CDR rows the engine would otherwise
		// never receive. Wired only with a real bucket; the memory claim store is invisible to
		// other instances.
		if claimStore != nil && dialogEvents != nil {
			sweeper, err := reaper.New(reaper.Options{
				Store:      claimStore,
				Dialogs:    dialogs,
				Events:     dialogEvents,
				InstanceID: cfg.InstanceID,
				Logger:     log,
			})
			if err != nil {
				return err
			}
			group.Go(func() {
				if err := sweeper.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
					errs <- err
				}
			})
		}

		defer func() {
			if !invites.Wait(cfg.ShutdownTimeout) {
				log.Warn("some dialog work was still in flight at shutdown")
			}
		}()
	}

	// Everything else (MESSAGE, PUBLISH, …) is refused rather than half-answered.
	server.OnNoRoute(reg.HandleUnsupported)

	group.Go(func() {
		if err := reg.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			errs <- err
		}
	})

	group.Go(func() {
		if err := subscriptions.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			errs <- err
		}
	})

	// The TLS material, loaded once at boot rather than per listener, so a certificate that cannot
	// be read fails the process here with the path in the message rather than inside a goroutine
	// whose error nobody is watching.
	var tlsConfig *tls.Config
	if cfg.EnableTLS || cfg.EnableWSS {
		certificate, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("loading the SIP TLS certificate from %s / %s: %w",
				cfg.TLSCertFile, cfg.TLSKeyFile, err)
		}
		tlsConfig = &tls.Config{
			Certificates: []tls.Certificate{certificate},
			// TLS 1.2 is the floor: RFC 5630 §3.1.3 requires TLS for `sips:` but names no version,
			// and several handset vendors still ship stacks that cannot do 1.3.
			MinVersion: tls.VersionTLS12,
		}
	}

	var readyListeners atomic.Int32
	var expectedListeners int32
	listen := func(network, addr string) {
		expectedListeners++
		group.Go(func() {
			listenCtx := context.WithValue(ctx, sipgo.ListenReadyCtxKey, sipgo.ListenReadyFuncCtxValue(func(network, addr string) {
				readyListeners.Add(1)
				log.Info("listening", "network", network, "addr", addr, "realm", cfg.Realm)
			}))
			var err error
			switch {
			case strings.HasSuffix(network, "s") && tlsConfig != nil:
				// ListenAndServeTLS closes its listener when ctx is done; a post-shutdown error is
				// the close itself, not a failure.
				err = server.ListenAndServeTLS(listenCtx, network, addr, tlsConfig)
			case network == "udp":
				err = serveUDP(listenCtx, server, addr, cfg.SocketBufferBytes, log)
			default:
				err = server.ListenAndServe(listenCtx, network, addr)
			}
			if err != nil && ctx.Err() == nil {
				errs <- fmt.Errorf("%s listener: %w", network, err)
			}
		})
	}
	if cfg.EnableUDP {
		listen("udp", cfg.ListenAddr)
	}
	if cfg.EnableTCP {
		listen("tcp", cfg.ListenAddr)
	}
	if cfg.EnableTLS {
		listen("tls", cfg.TLSListenAddr)
	}
	if cfg.EnableWS {
		// SIP over WebSocket (RFC 7118), the only transport a browser has. Signalling only: a WebRTC
		// endpoint needs DTLS-SRTP, so a softphone can register and be rung and hear nothing.
		// Plaintext `ws` is for a development origin; a browser-loaded page needs `wss`.
		listen("ws", cfg.WSListenAddr)
	}
	if cfg.EnableWSS {
		listen("wss", cfg.WSSListenAddr)
	}
	if cfg.ExternalListenAddr != "" && cfg.ExternalListenAddr != cfg.ListenAddr {
		listen("udp", cfg.ExternalListenAddr)
		listen("tcp", cfg.ExternalListenAddr)
	}
	if err := conn.FlushTimeout(3 * time.Second); err != nil {
		return fmt.Errorf("flushing SIP subscriptions: %w", err)
	}
	healthServer, err := health.Start(ctx, cfg.HealthAddr, func() bool {
		return conn.IsConnected() && expectedListeners > 0 && readyListeners.Load() == expectedListeners
	}, health.WithPprof(cfg.PProfEnabled))
	if err != nil {
		return err
	}
	if cfg.PProfEnabled {
		log.Warn("pprof is enabled on the private health listener", "addr", healthServer.Addr)
	}
	log.Info("sipd is up", "healthAddr", healthServer.Addr, "listeners", expectedListeners)

	select {
	case <-ctx.Done():
		log.Info("shutting down", "timeoutSeconds", int(cfg.ShutdownTimeout/time.Second))
	case err := <-healthServer.Errors:
		log.Error("health listener failed", "error", err)
		stop()
	case err := <-errs:
		log.Error("stopping after a fatal error", "error", err)
		stop()
		waitFor(&group, cfg.ShutdownTimeout)
		return err
	}

	// Outcome reports first: a phone left holding a 202 with no final NOTIFY keeps its transfer
	// indicator lit until the dialog dies.
	if !transfers.Wait(cfg.ShutdownTimeout) {
		log.Warn("some transfer outcomes were not reported before shutdown")
	}

	// Then the subscriptions. `terminated;reason=deactivated` is RFC 6665's "re-subscribe now", so
	// lamps move to a surviving instance within a round trip. The context is fresh and short
	// because ctx is already cancelled here and would drop every one of these.
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
// location service as the presence check, `rpc.sip.v1.transfer` at the engine, and NOTIFY back to
// the phone. It is always wired: without the engine responder the phone is accepted, the request
// times out and the final NOTIFY carries 503, which is more informative than a 501.
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
// uses, the location service as the presence check, the `presence` KV bucket for the busy-lamp state
// and `voicemail.evt.v1.*.*.mwi.updated` for the message-waiting one. Always wired: without
// apps/engine publishing presence, subscriptions are accepted and notified `down`, which is what
// idle phones should show anyway.
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

// inviteDeps is everything the INVITE surface needs, as one struct rather than thirteen positional
// parameters, several of which are interchangeable pointer types that a transposition would swap
// silently.
type inviteDeps struct {
	cfg         config.Config
	server      *sipgo.Server
	client      *sipgo.Client
	conn        *nats.Conn
	bindings    kv.Store
	trunks      *trunk.Directory
	dialogs     *dialog.Store
	claims      dialog.ClaimStore
	events      sipevents.Publisher
	auth        *registrar.Authenticator
	credentials credentials.Store
	ctx         context.Context
	log         *slog.Logger
}

// newInviteHandler wires the INVITE surface: two listener profiles, the dialog table, the same
// digest authenticator every other handler uses, the engine seam, and the outbound half.
//
// The internal/external trust boundary is two `profile.Profile` values with different
// authentication, NAT policy and — the load-bearing one — routing contexts: a digest-authenticated
// call resolves in the tenant's internal context and a trunk-matched one in the untrusted context,
// which stops an inbound PSTN call dialling back out through a trunk.
//
// RefusingPort is used when there is no broker; it answers every INVITE 503 with a Retry-After.
func newInviteHandler(deps inviteDeps) (*invite.Handler, error) {
	cfg, log := deps.cfg, deps.log

	profiles, aclWatcher, aclReady, err := buildProfiles(deps.ctx, cfg, deps.conn, log)
	if err != nil {
		return nil, err
	}
	// buildProfiles starts the ACL watch rather than finishing it, so this is where the security
	// boundary becomes loaded rather than merely opened. The wait is bounded: an empty ACL fails
	// closed, and waiting for ever would stop REGISTER over a bucket that may not exist yet.
	aclLoaded := waitForACL(deps.ctx, aclReady, aclReadyTimeout)
	if !aclLoaded {
		log.Warn("the sip-acl replay has not landed; carrier INVITEs are refused until it does",
			"bucket", contract.SIPACLKV.Name, "waited", aclReadyTimeout)
	}
	requester, err := invite.NewClientRequester(deps.client)
	if err != nil {
		return nil, err
	}
	caller, err := invite.NewClientCaller(deps.client)
	if err != nil {
		return nil, err
	}
	port, err := invite.NewNATSPort(deps.conn, invite.NATSOptions{})
	if err != nil {
		return nil, err
	}
	sink, err := invite.NewPublishingSink(deps.events, cfg.InstanceID, log)
	if err != nil {
		return nil, err
	}

	timers := dialog.TimerPolicy{
		Enabled:            cfg.EnableSessionTimers,
		MinSE:              cfg.MinSE,
		DefaultSE:          cfg.SessionExpires,
		MaxSE:              cfg.SessionExpires * 4,
		PreferLocalRefresh: true,
	}

	handler, err := invite.New(invite.Options{
		Realm:        cfg.Realm,
		Auth:         deps.auth,
		Credentials:  deps.credentials,
		Dialogs:      deps.dialogs,
		Claims:       deps.claims,
		Profiles:     profiles,
		Port:         port,
		Requester:    requester,
		Caller:       caller,
		Bindings:     deps.bindings,
		Trunks:       deps.trunks,
		TrunkAuth:    trunk.NewNATSAuthorizer(deps.conn),
		Responder:    deps.server,
		Events:       sink,
		Contact:      contactURI(cfg),
		InstanceID:   cfg.InstanceID,
		Timers:       timers,
		Logger:       log,
		ServerHeader: cfg.UserAgent,
		BaseContext:  deps.ctx,
		NewLegID:     contract.NewEventID,
	})
	if err != nil {
		return nil, err
	}

	log.Info("INVITE handling ready",
		"instanceId", cfg.InstanceID,
		"profiles", len(profiles.Profiles()),
		"admissionSubject", port.Subject(),
		"admissionTimeout", port.Timeout(),
		"eventRoot", contract.SubjectRootSIPDialog,
		"aclEntries", aclWatcher.Len(),
		"aclLoaded", aclLoaded,
		"trunks", deps.trunks.Len(),
		"sessionTimers", cfg.EnableSessionTimers)
	return handler, nil
}

// buildProfiles turns the configuration and the `sip-acl` bucket into the trust boundaries the
// INVITE handler enforces. The external profile is built whenever the bucket can be opened or the
// override names something: an empty ACL refuses every carrier (`Match` has no default allow), so
// building it early costs nothing and saves a restart when a tenant adds its first trunk.
// aclReadyTimeout is how long boot waits for the sip-acl initial replay before serving INVITEs
// anyway. Long enough for a broker round trip and a replay of a realistic ACL, short enough that a
// missing bucket does not hold up REGISTER, which has nothing to do with this boundary.
const aclReadyTimeout = 3 * time.Second

// waitForACL blocks until the initial replay lands, the deadline passes or the process is shutting
// down, and reports whether the ACL is loaded.
func waitForACL(ctx context.Context, ready <-chan struct{}, timeout time.Duration) bool {
	if ready == nil {
		return false
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ready:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func buildProfiles(
	ctx context.Context,
	cfg config.Config,
	conn *nats.Conn,
	log *slog.Logger,
) (*profile.Set, *acl.Watcher, <-chan struct{}, error) {
	listeners := make([]profile.Listener, 0, 5)
	if cfg.EnableUDP {
		listeners = append(listeners, profile.Listener{Network: "udp", Addr: cfg.ListenAddr})
	}
	if cfg.EnableTCP {
		listeners = append(listeners, profile.Listener{Network: "tcp", Addr: cfg.ListenAddr})
	}
	if cfg.EnableTLS {
		listeners = append(listeners, profile.Listener{
			Network: "tls", Addr: cfg.TLSListenAddr,
			TLSCertFile: cfg.TLSCertFile, TLSKeyFile: cfg.TLSKeyFile,
		})
	}
	if cfg.EnableWS {
		listeners = append(listeners, profile.Listener{Network: "ws", Addr: cfg.WSListenAddr})
	}
	if cfg.EnableWSS {
		listeners = append(listeners, profile.Listener{
			Network: "wss", Addr: cfg.WSSListenAddr,
			TLSCertFile: cfg.TLSCertFile, TLSKeyFile: cfg.TLSKeyFile,
		})
	}

	overrides, err := parseTrunkACL(cfg.TrunkACL)
	if err != nil {
		return nil, nil, nil, err
	}

	carrierACL := profile.NewWatchedACL(overrides)
	watcher, err := acl.NewWatcher(carrierACL, overrides, log)
	if err != nil {
		return nil, nil, nil, err
	}

	// ready closes once the bucket's initial replay has landed, however many attach attempts that
	// took. It is the signal boot waits on before it starts answering INVITEs.
	ready := make(chan struct{})
	var readyOnce sync.Once

	watchConfigured := false
	if conn != nil {
		js, err := jetstream.New(conn)
		if err != nil {
			return nil, nil, nil, err
		}
		watchConfigured = true
		watchWhenAvailable(ctx, log, contract.SIPACLKV.Name, time.Second, func() error {
			bucket, err := acl.OpenBucket(ctx, js)
			if err != nil {
				return err
			}
			replayed, err := acl.Watch(ctx, bucket, watcher)
			if err != nil {
				return err
			}
			go func() {
				select {
				case <-replayed:
					readyOnce.Do(func() { close(ready) })
				case <-ctx.Done():
				}
			}()
			return nil
		})
	}

	internal := profile.Internal("internal", listeners...)
	if !watchConfigured && len(overrides) == 0 {
		// No bucket and no overrides: no external profile, so nothing to wait for.
		readyOnce.Do(func() { close(ready) })
		set, err := profile.NewSet(internal)
		return set, watcher, ready, err
	}
	// Keep the dynamic ACL attached while the control plane creates its bucket.
	// An empty ACL refuses carrier traffic until the initial replay succeeds.

	external := profile.External("external", carrierACL)
	if cfg.ExternalListenAddr != "" {
		// A socket of its own is the stronger separation: the profile is then chosen by the address
		// the packet arrived on, which no sender can influence.
		external.Listeners = []profile.Listener{
			{Network: "udp", Addr: cfg.ExternalListenAddr},
			{Network: "tcp", Addr: cfg.ExternalListenAddr},
		}
	}
	set, err := profile.NewSet(internal, external)
	return set, watcher, ready, err
}

// parseTrunkACL reads `cidr[=trunkId]` entries separated by commas.
//
// It is an override on the `sip-acl` bucket, for a deployment whose control plane cannot write the
// bucket and for an operator admitting one address during an incident. Entries from here are
// recompiled alongside every bucket update and never removed by one.
//
// Empty is legal and expected. A value that is set and names nothing usable is an error: a typo in
// an anti-toll-fraud boundary must not silently do nothing.
func parseTrunkACL(raw string) ([]profile.Entry, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	fields := strings.Split(trimmed, ",")
	entries := make([]profile.Entry, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		network, trunkID, _ := strings.Cut(field, "=")
		// Priority zero outranks every bucket entry: acl.priorityOf negates the positive column, so
		// bucket entries compile to negative priorities and an override wins.
		entry, err := profile.ParseEntry(network, profile.ActionAllow, 0, strings.TrimSpace(trunkID), "SIPD_TRUNK_ACL")
		if err != nil {
			return nil, fmt.Errorf("SIPD_TRUNK_ACL: %w", err)
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return nil, errors.New("SIPD_TRUNK_ACL is set but names no usable network")
	}
	return entries, nil
}

// contactURI is what this edge puts in the Contact header of its 202 and its notifications.
//
// The host comes from the listen address, except when that address is a wildcard, which no phone can
// send to; the realm is used instead, being the name the handsets were provisioned with.
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

// serveUDP binds the UDP socket with an explicit receive and send buffer, then hands it to sipgo.
//
// sipgo's own ListenAndServe takes the kernel default (~200 KiB on Linux). One goroutine drains the
// socket, and a fleet re-registering after a network blip arrives faster than it can be parsed; the
// overflow is silently dropped datagrams. A kernel that refuses the size is logged, not fatal.
func serveUDP(ctx context.Context, server *sipgo.Server, addr string, bufferBytes int, log *slog.Logger) error {
	laddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return fmt.Errorf("resolving %s: %w", addr, err)
	}
	conn, err := net.ListenUDP("udp", laddr)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", addr, err)
	}
	sizes, err := netbuf.Tune(conn, bufferBytes, bufferBytes)
	if err != nil {
		log.Warn("cannot size the UDP socket buffers; the kernel default applies",
			"addr", addr, "bytes", bufferBytes, "error", err)
	} else if bufferBytes > 0 {
		log.Info("sized the UDP socket buffers",
			"addr", addr, "receiveBytes", sizes.Receive, "sendBytes", sizes.Send)
	}
	context.AfterFunc(ctx, func() { _ = conn.Close() })
	if ready, ok := ctx.Value(sipgo.ListenReadyCtxKey).(sipgo.ListenReadyFuncCtxValue); ok {
		ready("udp", conn.LocalAddr().String())
	}
	return server.ServeUDP(conn)
}

// flushPublishes waits for the outstanding asynchronous JetStream acks, bounded by timeout.
func flushPublishes(js jetstream.JetStream, log *slog.Logger, timeout time.Duration) {
	pending := js.PublishAsyncPending()
	if pending == 0 {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-js.PublishAsyncComplete():
	case <-timer.C:
		log.Warn("some events were still unacknowledged at shutdown",
			"pending", js.PublishAsyncPending(), "timeout", timeout)
	}
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
		// No probe request at boot: refusing to start because the control plane is briefly down
		// would turn an API deploy into a SIP outage. Until the responder answers, every REGISTER
		// is refused with a logged reason, and it recovers on its own.
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
