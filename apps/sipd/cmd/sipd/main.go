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
	"io"
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
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/lease"
	sipdmetrics "github.com/optimiqs/optimiq-voice/apps/sipd/internal/metrics"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/reaper"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/siplog"
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

	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel})
	log := slog.New(handler)
	slog.SetDefault(log)
	// sipgo takes its transport and transaction loggers from this one, and logs several routine
	// per-call facts at WARN and ERROR — including the sender's raw bytes on a parse failure.
	sip.SetDefaultLogger(slog.New(siplog.Wrap(handler)))
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

	// A provisioning write evicts this edge's cache on the commit rather than on the TTL. A file
	// store caches nothing and implements no evictor, so this is skipped for the SIPp rig.
	if evictor, ok := credentialStore.(credentials.OrgEvictor); ok {
		if err := credentials.WatchInvalidations(ctx, conn, evictor, log); err != nil {
			return err
		}
		log.Info("watching credential invalidations", "subject", credentials.InvalidationFilter)
	}

	// sipgo never stamps the destination on an inbound message, so the local listener address is
	// captured here, before parsing, and is what `profile.Set.For` selects the trust boundary by.
	// Without it selection falls back to the SENDER's address and a trunk ACL entry can reclassify
	// another network's authenticated phones as digest-free carrier peers.
	arrivals := profile.NewArrivals(profile.DefaultArrivalCapacity)

	userAgent, err := sipgo.NewUA(
		sipgo.WithUserAgent(cfg.UserAgent),
		sipgo.WithUserAgentTransportLayerOptions(sip.WithTransportLayerReadFilter(arrivals.ReadFilter())),
	)
	if err != nil {
		return fmt.Errorf("creating the SIP user agent: %w", err)
	}
	defer userAgent.Close()

	// Built before the registrar because the registrar probes it: a WebSocket binding is only
	// reachable over the connection that registered it (RFC 7118 §5.2), so a closed tab has to be
	// swept rather than left to expire.
	connections := newTransportProbe(userAgent)

	authenticator, err := registrar.NewAuthenticator(cfg.Realm, []byte(cfg.NonceSecret), cfg.NonceTTL)
	if err != nil {
		return err
	}
	if cfg.NonceSecret == "" {
		log.Warn("SIPD_NONCE_SECRET is unset; a random per-process secret was generated. " +
			"Set it fleet-wide before running more than one replica, or a device challenged by " +
			"one instance will be rejected by another.")
	}

	// The `scope=registration` half of the `sip-acl` bucket. Built here rather than in
	// buildProfiles because the registrar is wired before the INVITE surface and serves REGISTER
	// whether or not that surface exists; buildProfiles attaches it to the same watch when it runs,
	// and it stays empty — admitting everything — when it does not.
	registrationACL := profile.NewWatchedBlocklist(nil)

	// One lockout for the whole process, shared by REGISTER, INVITE, SUBSCRIBE and REFER through
	// registrar.DigestGate: a spray that alternated methods would otherwise get a budget each.
	lockout := registrar.NewLockout(cfg.AuthLockout, time.Now)
	if lockout == nil {
		log.Warn("SIPD_AUTH_LOCKOUT_THRESHOLD is 0; credential guessing is unthrottled and every " +
			"attempt costs a credential lookup.")
	}

	reg, err := registrar.New(registrar.Options{
		InstanceID:       cfg.InstanceID,
		MaxContacts:      cfg.MaxContactsPerAOR,
		Realm:            cfg.Realm,
		Auth:             authenticator,
		Expiry:           registrar.ExpiryPolicy{Min: cfg.MinExpires, Max: cfg.MaxExpires, Default: cfg.DefaultExpires},
		RegistrationACL:  registrationACL,
		Lockout:          lockout,
		Credentials:      credentialStore,
		Bindings:         bindings,
		Connections:      connections,
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

	// The dialog table, built before the handlers because REFER authorises an in-dialog request by
	// membership of it.
	dialogs := dialog.NewStore(dialog.StoreOptions{InstanceID: cfg.InstanceID})

	transfers, err := newTransferHandler(
		cfg, conn, sipClient, authenticator, credentialStore, lockout, bindings, dialogs, ctx, log)
	if err != nil {
		return err
	}

	subscriptions, err := newSubscribeHandler(
		cfg, conn, sipClient, authenticator, credentialStore, lockout, bindings, presenceStore, ctx, log)
	if err != nil {
		return err
	}

	// Telemetry, wrapped around every handler rather than threaded through them. There is no
	// switch: unlike pprof — which is a denial-of-service and a memory disclosure, and is why the
	// health listener is private in the first place — a Prometheus registry costs a handful of
	// atomics per request and an endpoint nothing reaches unless it is scraped.
	metrics := sipdmetrics.New()
	server.OnRegister(metrics.Wrap("REGISTER", reg.HandleRegister))
	server.OnOptions(metrics.Wrap("OPTIONS", reg.HandleOptions))
	server.OnRefer(metrics.Wrap("REFER", transfers.HandleRefer))
	server.OnSubscribe(metrics.Wrap("SUBSCRIBE", subscriptions.HandleSubscribe))
	metrics.Gauge("subscriptions", "Active RFC 6665 subscriptions held by this instance.",
		subscriptions.Subscriptions)
	metrics.Counter("subscription_notifications_dropped_total",
		"NOTIFYs dropped because a subscriber's queue was full.",
		func() uint64 { return uint64(max(subscriptions.Dropped(), 0)) })
	metrics.Counter("auth_lockout_failures_total",
		"Credential failures counted by the spray throttle.",
		func() uint64 { return lockout.Stats().Failures })
	metrics.Counter("auth_lockouts_total",
		"Times a source or account entered a cooling window.",
		func() uint64 { return lockout.Stats().Lockouts })
	metrics.Counter("auth_lockout_refusals_total",
		"Requests refused because a cooling window was in force, regardless of credential.",
		func() uint64 { return lockout.Stats().Refused })

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

	// The dialog claim bucket. The claim store is the NATS one whenever the bucket can be opened.
	// The memory one lets a single instance work but reaps nothing — a claim only one process can
	// see is one no survivor can act on — so landing on it warns rather than downgrading silently.
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

	// This instance's liveness lease. One key, renewed every few seconds, so the ENGINE can end the
	// legs that died with this process — the case internal/reaper cannot cover, because a
	// single-instance edge leaves no survivor to sweep. The reaper reads it too, which is what lets
	// a dead peer's dialogs be reaped in seconds rather than at their own ninety-second lease.
	var leaseStore lease.Store
	if cfg.EnableInvite {
		if store, err := lease.Open(ctx, js); err != nil {
			log.Warn("cannot open the sip-instances bucket; if this process dies the engine will not "+
				"learn it until each dialog claim expires",
				"bucket", contract.SIPInstancesKV.Name, "error", err)
		} else {
			leaseStore = store
			renewer, err := lease.New(lease.Options{
				Store:      store,
				InstanceID: cfg.InstanceID,
				Dialogs:    func() int { return len(dialogs.Claims()) },
				Logger:     log,
			})
			if err != nil {
				return err
			}
			group.Go(func() {
				if err := renewer.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
					errs <- err
				}
			})
			log.Info("renewing this instance's liveness lease",
				"instanceId", cfg.InstanceID,
				"bucket", contract.SIPInstancesKV.Name,
				"interval", lease.RenewInterval,
				"ttl", contract.SIPInstancesKV.TTL)
		}
	}

	// The dialog event publisher. There is always a broker by this point, so the seam exists for the
	// tests rather than for a degraded production mode.
	dialogEvents := sipevents.NewJetStreamPublisher(js)

	// The INVITE surface, off unless SIPD_INVITE says otherwise: turning it on makes a registrar
	// into a call-processing element, which needs dialog affinity at the load balancer, a trunk
	// directory and an ACL bucket already in place.
	if cfg.EnableInvite {
		invites, finalizer, err := newInviteHandler(inviteDeps{
			cfg:             cfg,
			server:          server,
			client:          sipClient,
			conn:            conn,
			bindings:        bindings,
			trunks:          trunkDirectory,
			dialogs:         dialogs,
			claims:          claims,
			events:          dialogEvents,
			auth:            authenticator,
			credentials:     credentialStore,
			lockout:         lockout,
			registrar:       reg,
			registrationACL: registrationACL,
			arrivals:        arrivals,
			ctx:             ctx,
			log:             log,
		})
		if err != nil {
			return err
		}
		// Drained before the JetStream flush below it, so a termination still waiting for its
		// acknowledgement is published — and its claim released — rather than abandoned.
		defer func() {
			drainCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
			defer cancel()
			if !finalizer.Shutdown(drainCtx) {
				log.Warn("some dialog terminations were still unacknowledged at shutdown",
					"pending", finalizer.Pending())
			}
		}()
		server.OnInvite(metrics.Wrap("INVITE", invites.ServeInvite))
		server.OnAck(metrics.Wrap("ACK", invites.HandleAck))
		server.OnBye(metrics.Wrap("BYE", invites.HandleBye))
		server.OnCancel(metrics.Wrap("CANCEL", invites.HandleCancel))
		server.OnUpdate(metrics.Wrap("UPDATE", invites.HandleUpdate))
		server.OnInfo(metrics.Wrap("INFO", invites.HandleInfo))
		metrics.Gauge("dialogs", "Dialogs this instance holds.", dialogs.Len)

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
			// Admission closes with the subscriptions; the commands already accepted still answer.
			drainCtx, cancelDrain := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
			defer cancelDrain()
			if !commands.DrainCommands(drainCtx) {
				log.Warn("commands were still running at the shutdown deadline")
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
				Leases:     leaseStore,
				InstanceID: cfg.InstanceID,
				Logger:     log,
			})
			if err != nil {
				return err
			}
			// Before the ticker starts, and before any INVITE is admitted: this process holds no
			// dialogs yet, so any claim carrying its own instance id belongs to an incarnation that
			// is gone. The ordinary sweep can never take those — it must not reap its own claims —
			// so without this a stable instance id leaves one dead dialog per crashed call in the
			// bucket until the six-hour TTL.
			sweeper.SweepPredecessor(ctx)
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
	server.OnNoRoute(metrics.Wrap("unsupported", reg.HandleUnsupported))

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
	// Every transport binds its own socket here, on this goroutine, and only then hands the bound
	// socket to sipgo's Serve* variant. sipgo's ListenAndServe/ListenAndServeTLS bind inside the
	// call while a cancellation goroutine it started at sipgo@v1.4.3/server.go:102-108 already reads
	// the connection the same function writes at server.go:123-128 — a data race on every shutdown.
	// A bound socket is also the readiness signal, so a bind failure is fatal here with the address
	// named rather than surfacing from a goroutine after health has reported ready.
	listen := func(network, addr string) error {
		ready := sipgo.ListenReadyFuncCtxValue(func(network, addr string) {
			readyListeners.Add(1)
			log.Info("listening", "network", network, "addr", addr, "realm", cfg.Realm)
		})
		bound, err := bindListener(network, addr, tlsConfig, cfg.SocketBufferBytes, log)
		if err != nil {
			return err
		}
		expectedListeners++
		context.AfterFunc(ctx, func() { _ = bound.closer.Close() })
		ready(network, bound.addr)
		group.Go(func() {
			if err := bound.serve(server); err != nil && ctx.Err() == nil {
				errs <- fmt.Errorf("%s listener: %w", network, err)
			}
		})
		return nil
	}
	if cfg.EnableUDP {
		if err := listen("udp", cfg.ListenAddr); err != nil {
			return err
		}
	}
	if cfg.EnableTCP {
		if err := listen("tcp", cfg.ListenAddr); err != nil {
			return err
		}
	}
	if cfg.EnableTLS {
		if err := listen("tls", cfg.TLSListenAddr); err != nil {
			return err
		}
	}
	if cfg.EnableWS {
		// SIP over WebSocket (RFC 7118), the only transport a browser has. Signalling only: a WebRTC
		// endpoint needs DTLS-SRTP, so a softphone can register and be rung and hear nothing.
		// Plaintext `ws` is for a development origin; a browser-loaded page needs `wss`.
		if err := listen("ws", cfg.WSListenAddr); err != nil {
			return err
		}
	}
	if cfg.EnableWSS {
		if err := listen("wss", cfg.WSSListenAddr); err != nil {
			return err
		}
	}
	if cfg.ExternalListenAddr != "" && cfg.ExternalListenAddr != cfg.ListenAddr {
		if err := listen("udp", cfg.ExternalListenAddr); err != nil {
			return err
		}
		if err := listen("tcp", cfg.ExternalListenAddr); err != nil {
			return err
		}
	}
	if err := conn.FlushTimeout(3 * time.Second); err != nil {
		return fmt.Errorf("flushing SIP subscriptions: %w", err)
	}
	healthServer, err := health.Start(ctx, cfg.HealthAddr, func() bool {
		return conn.IsConnected() && expectedListeners > 0 && readyListeners.Load() == expectedListeners
	}, health.WithPprof(cfg.PProfEnabled), health.WithMetrics(metrics.Registry().Handler()))
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

// newTransferHandler wires REFER: dialog membership for an in-dialog request and digest against the
// same authenticator the registrar uses for the rest, the location service as the presence check, `rpc.sip.v1.transfer` at the engine, and NOTIFY back to
// the phone. It is always wired: without the engine responder the phone is accepted, the request
// times out and the final NOTIFY carries 503, which is more informative than a 501.
func newTransferHandler(
	cfg config.Config,
	conn *nats.Conn,
	client *sipgo.Client,
	authenticator *registrar.Authenticator,
	credentialStore credentials.Store,
	lockout *registrar.Lockout,
	bindings kv.Store,
	dialogs *dialog.Store,
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
		Lockout:      lockout,
		Dialogs:      dialogs,
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
	lockout *registrar.Lockout,
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
		Lockout:     lockout,
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
	// lockout is the process-wide credential-guessing throttle, shared with the registrar.
	lockout *registrar.Lockout
	// registrar receives the profile set as its NAT clamp, so a granted registration cannot outlive
	// the pinhole the arriving profile's position allows. It is attached here because the profile
	// set is built here; a deployment with no INVITE surface builds no profiles and has no clamp to
	// apply.
	registrar *registrar.Registrar
	// registrationACL is filled by the same `sip-acl` watch the trunk ACL uses. Owned by the
	// registrar, which is built first; passed through so one watch feeds both scopes.
	registrationACL *profile.ACL
	// arrivals is the listener-address table the transport read filter fills; the profile set
	// selects by it, since sipgo leaves the destination unset on inbound messages.
	arrivals *profile.Arrivals
	ctx      context.Context
	log      *slog.Logger
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
func newInviteHandler(deps inviteDeps) (*invite.Handler, *sipevents.Finalizer, error) {
	cfg, log := deps.cfg, deps.log

	profiles, aclWatcher, aclReady, err := buildProfiles(deps.ctx, cfg, deps.registrationACL, deps.conn, log)
	if err != nil {
		return nil, nil, err
	}
	profiles.TrackArrivals(deps.arrivals)
	if deps.registrar != nil {
		deps.registrar.TrackNATPolicy(profiles)
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
		return nil, nil, err
	}
	caller, err := invite.NewClientCaller(deps.client)
	if err != nil {
		return nil, nil, err
	}
	port, err := invite.NewNATSPort(deps.conn, invite.NATSOptions{})
	if err != nil {
		return nil, nil, err
	}
	// The recovery claim is released by the finalizer and not by the leg, so a `dialog.terminated`
	// the stream never accepted leaves the evidence a reaper needs.
	finalizer, err := sipevents.NewFinalizer(sipevents.FinalizerOptions{
		Publisher: deps.events,
		Claims:    deps.claims,
		Timeout:   cfg.PublishAsyncTimeout,
		Logger:    log,
	})
	if err != nil {
		return nil, nil, err
	}
	sink, err := invite.NewFinalizingSink(deps.events, cfg.InstanceID, finalizer, log)
	if err != nil {
		return nil, nil, err
	}

	timers := dialog.TimerPolicy{
		Enabled:   cfg.EnableSessionTimers,
		MinSE:     cfg.MinSE,
		DefaultSE: cfg.SessionExpires,
		MaxSE:     cfg.SessionExpires * 4,
		// Not local: this edge has no way to BUILD a refresh — the re-INVITE's offer comes from
		// mediad by way of the engine — so volunteering as the refresher would promise a peer a
		// refresh that never arrives and let it tear down a live call (RFC 4028 §7.2).
		PreferLocalRefresh: false,
	}
	if err := timers.Validate(); err != nil {
		return nil, nil, err
	}

	handler, err := invite.New(invite.Options{
		Realm:        cfg.Realm,
		Auth:         deps.auth,
		Credentials:  deps.credentials,
		Lockout:      deps.lockout,
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
		Finalizer:    finalizer,
		Contact:      contactURI(cfg),
		InstanceID:   cfg.InstanceID,
		Timers:       timers,
		Logger:       log,
		ServerHeader: cfg.UserAgent,
		BaseContext:  deps.ctx,
		NewLegID:     contract.NewEventID,
	})
	if err != nil {
		return nil, nil, err
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
	return handler, finalizer, nil
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
	registrationACL *profile.ACL,
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
	if registrationACL != nil {
		watcher.WithRegistrationACL(registrationACL)
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
	if cfg.ExternalListenAddr == "" {
		// Without a socket of its own the external profile shares the internal one, and the only
		// thing left to tell a carrier from a phone is the source address — so a trunk ACL entry
		// covering an office network reclassifies that office's authenticated phones as digest-free
		// carrier peers. Actionable, and logged once at boot rather than per call.
		log.Warn("the external profile has no listener of its own; a trunk ACL entry will claim "+
			"matching sources on the internal socket too. Set SIPD_EXTERNAL_LISTEN_ADDR to make the "+
			"listener the trust boundary.",
			"internalListenAddr", cfg.ListenAddr)
	}
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

// boundListener is one SIP transport whose socket is already bound. serve blocks until closer is
// closed; closer is owned by the caller.
type boundListener struct {
	addr   string
	closer io.Closer
	serve  func(*sipgo.Server) error
}

// bindListener binds the socket for one SIP transport and returns it with the sipgo Serve variant
// that accepts an already-bound listener.
//
// Binding here rather than through sipgo's ListenAndServe/ListenAndServeTLS keeps the process out
// of the upstream race at sipgo@v1.4.3/server.go:102-108 (the cancellation goroutine reads the
// listener) versus server.go:123-128 (the same function writes it).
//
// UDP is additionally given an explicit receive and send buffer: sipgo takes the kernel default
// (~200 KiB on Linux), one goroutine drains the socket, and a fleet re-registering after a network
// blip arrives faster than it can be parsed. A kernel that refuses the size is logged, not fatal.
func bindListener(network, addr string, tlsConfig *tls.Config, bufferBytes int, log *slog.Logger) (*boundListener, error) {
	switch network {
	case "udp":
		laddr, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			return nil, fmt.Errorf("resolving %s: %w", addr, err)
		}
		conn, err := net.ListenUDP("udp", laddr)
		if err != nil {
			return nil, fmt.Errorf("listening on %s: %w", addr, err)
		}
		sizes, err := netbuf.Tune(conn, bufferBytes, bufferBytes)
		if err != nil {
			log.Warn("cannot size the UDP socket buffers; the kernel default applies",
				"addr", addr, "bytes", bufferBytes, "error", err)
		} else if bufferBytes > 0 {
			log.Info("sized the UDP socket buffers",
				"addr", addr, "receiveBytes", sizes.Receive, "sendBytes", sizes.Send)
		}
		return &boundListener{
			addr:   conn.LocalAddr().String(),
			closer: conn,
			serve:  func(server *sipgo.Server) error { return server.ServeUDP(conn) },
		}, nil
	case "tcp", "ws":
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("listening on %s: %w", addr, err)
		}
		serve := (*sipgo.Server).ServeTCP
		if network == "ws" {
			serve = (*sipgo.Server).ServeWS
		}
		return &boundListener{
			addr:   listener.Addr().String(),
			closer: listener,
			serve:  func(server *sipgo.Server) error { return serve(server, listener) },
		}, nil
	case "tls", "wss":
		if tlsConfig == nil {
			return nil, fmt.Errorf("listening on %s: %s needs a TLS certificate", addr, network)
		}
		inner, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("listening on %s: %w", addr, err)
		}
		listener := tls.NewListener(inner, tlsConfig)
		serve := (*sipgo.Server).ServeTLS
		if network == "wss" {
			serve = (*sipgo.Server).ServeWSS
		}
		return &boundListener{
			addr:   listener.Addr().String(),
			closer: listener,
			serve:  func(server *sipgo.Server) error { return serve(server, listener) },
		}, nil
	}
	return nil, fmt.Errorf("listening on %s: unsupported transport %q", addr, network)
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
