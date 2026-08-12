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
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

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

	var group sync.WaitGroup
	errs := make(chan error, 8)

	// The two watched read models, and the state they feed.
	//
	// Both are opened BEFORE the INVITE surface and both are non-fatal when absent, and the two
	// halves of that are deliberate. Opened first, because the ACL is a security boundary and an
	// INVITE listener that started accepting traffic before its ACL had loaded would be admitting
	// carriers on an empty policy — which fails closed, but fails closed at the cost of a carrier
	// outage nobody asked for. Non-fatal, because these buckets are written by apps/api: a control
	// plane that has not deployed yet must not stop this edge from serving REGISTER, which has
	// nothing to do with either of them.
	trunkDirectory := trunk.NewDirectory(log)
	if cfg.EnableInvite {
		// The status publisher is the JetStream one whenever there is a broker, which by this point
		// there always is — the process refuses to start without one. LogPublisher survives for the
		// no-broker development case and is chosen by the same condition, so a deployment either
		// publishes or says loudly that it cannot and never silently drops a carrier outage.
		var statusPublisher trunk.Publisher = trunk.NewJetStreamPublisher(js, config.EventSource)
		if conn == nil {
			statusPublisher = trunk.LogPublisher{Log: log}
		}

		registrarClient, err := trunk.NewClientRegistrar(sipClient, trunk.RegistrarOptions{
			Contact:   contactURI(cfg),
			UserAgent: cfg.UserAgent,
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

		// The directory drives the supervisor. This is the wire internal/trunk's package comment has
		// been describing as missing: "nothing delivers trunk configuration to sipd today… this
		// package defines the struct it NEEDS, takes it from a caller, and names the ingestion seam".
		// The seam is the `trunks` bucket, and this is the caller.
		trunkDirectory.OnChange(func() { supervisor.Apply(ctx, trunkDirectory.Configs()) })

		if bucket, err := trunk.OpenDirectoryBucket(ctx, js); err != nil {
			log.Warn("no trunk directory is available; every originate to a trunk will be refused "+
				"unknown_trunk and no carrier registration will be attempted",
				"bucket", contract.TrunksKV.Name, "error", err)
		} else if _, err := trunk.Watch(ctx, bucket, trunkDirectory); err != nil {
			log.Warn("cannot watch the trunk directory", "error", err)
		}
	}

	// The dialog table and its claim bucket.
	//
	// The claim store is the NATS one whenever the bucket can be opened. The memory one is not a
	// fallback in the ordinary sense — it lets a single instance work and reaps NOTHING, because a
	// claim only one process can see is a claim no survivor can act on — so a deployment that lands
	// on it gets a warning naming the consequence rather than a silent downgrade.
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

	// The dialog event publisher. JetStream when there is a broker, which there always is by this
	// point — the process refuses to start without one — so the seam exists for the tests rather
	// than for a degraded production mode.
	dialogEvents := sipevents.NewJetStreamPublisher(js)

	// The INVITE surface, off unless SIPD_INVITE says otherwise.
	//
	// Off is still the default, and the reason has CHANGED rather than gone away. It is no longer
	// "no engine serves rpc.sip.v1.invite" — one does now — it is that turning this on makes a
	// registrar into a call-processing element, which is a deployment decision with a blast radius
	// (dialog affinity at the load balancer, a trunk directory, an ACL bucket) that nobody should
	// acquire by upgrading a binary.
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
		server.OnInvite(invites.HandleInvite)
		server.OnAck(invites.HandleAck)
		server.OnBye(invites.HandleBye)
		server.OnCancel(invites.HandleCancel)
		server.OnUpdate(invites.HandleUpdate)
		server.OnInfo(invites.HandleInfo)

		// The engine's command surface. Attached AFTER the SIP handlers are registered, so a command
		// can never arrive for a dialog whose handler is not yet installed — which would be a 200 OK
		// this process could not write.
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

		// The claim reaper. It is what turns a dead instance's calls into CDR rows the engine would
		// otherwise never receive (design §6.2), and it is wired only when there is a bucket to sweep
		// — with the memory claim store there is nothing another instance could ever see.
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
			group.Add(1)
			go func() {
				defer group.Done()
				if err := sweeper.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
					errs <- err
				}
			}()
		}

		defer func() {
			if !invites.Wait(cfg.ShutdownTimeout) {
				log.Warn("some dialog work was still in flight at shutdown")
			}
		}()
	}

	// Everything else — MESSAGE, PUBLISH, … — is honestly refused rather than half-answered.
	server.OnNoRoute(reg.HandleUnsupported)

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

	// The TLS material, loaded ONCE at boot rather than per listener.
	//
	// Once, because a certificate that cannot be read must fail the process here — with the path in
	// the message — rather than inside a goroutine whose error nobody is watching, leaving a
	// deployment that believes it serves TLS and serves nothing on 5061.
	var tlsConfig *tls.Config
	if cfg.EnableTLS || cfg.EnableWSS {
		certificate, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("loading the SIP TLS certificate from %s / %s: %w",
				cfg.TLSCertFile, cfg.TLSKeyFile, err)
		}
		tlsConfig = &tls.Config{
			Certificates: []tls.Certificate{certificate},
			// TLS 1.2 is the floor. RFC 5630 §3.1.3 requires TLS for `sips:` and says nothing about
			// versions; 1.2 is the lowest version with no known practical break and the highest
			// floor every SIP handset in the field can actually reach — several vendors still ship
			// stacks that cannot do 1.3.
			MinVersion: tls.VersionTLS12,
		}
	}

	listen := func(network, addr string) {
		group.Add(1)
		go func() {
			defer group.Done()
			log.Info("listening", "network", network, "addr", addr, "realm", cfg.Realm)
			var err error
			if strings.HasSuffix(network, "s") && tlsConfig != nil {
				// ListenAndServeTLS closes its listener when ctx is done and returns; a
				// post-shutdown error is the close itself, not a failure.
				err = server.ListenAndServeTLS(ctx, network, addr, tlsConfig)
			} else {
				err = server.ListenAndServe(ctx, network, addr)
			}
			if err != nil && ctx.Err() == nil {
				errs <- fmt.Errorf("%s listener: %w", network, err)
			}
		}()
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
		// SIP over WebSocket (RFC 7118). It is the only transport a browser has, and it delivers
		// SIGNALLING only: a WebRTC endpoint needs DTLS-SRTP and apps/mediad has no SRTP, so a
		// softphone can register and be rung and will hear nothing. Plaintext `ws` is for a
		// development origin; anything a browser will actually load needs `wss`.
		listen("ws", cfg.WSListenAddr)
	}
	if cfg.EnableWSS {
		listen("wss", cfg.WSSListenAddr)
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

// inviteDeps is everything the INVITE surface needs, as one struct.
//
// A struct rather than thirteen positional parameters, and the reason is not cosmetic: the previous
// signature had six, four of which were pointers to different services, and this wave adds seven
// more. A call site with thirteen positional arguments is one transposition away from handing the
// dialog store to the claim store's slot — which compiles, and which would produce a process that
// heartbeats an empty table while its real dialogs go unclaimed.
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
// # The two profiles, and why they are structure rather than a comment
//
// parity-audit row 1.26 records that the internal/external trust boundary is enforced today by
// convention in a config file. Here it is two `profile.Profile` values with different
// authentication, different NAT policy and — the load-bearing one — different ROUTING CONTEXTS: a
// digest-authenticated call resolves in the tenant's internal context and a trunk-matched one in
// the untrusted context, which is what stops an inbound PSTN call from dialling back out through a
// trunk.
//
// # The engine seam is real now
//
// `rpc.sip.v1.invite` exists and is served, so the Port is the NATS one. RefusingPort survives for
// the deployment that genuinely has no broker, and it is the honest production behaviour for that
// state rather than a stub: every INVITE is answered 503 with a Retry-After and the log says why.
func newInviteHandler(deps inviteDeps) (*invite.Handler, error) {
	cfg, log := deps.cfg, deps.log

	profiles, aclWatcher, err := buildProfiles(deps.ctx, cfg, deps.conn, log)
	if err != nil {
		return nil, err
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
		"trunks", deps.trunks.Len(),
		"sessionTimers", cfg.EnableSessionTimers)
	return handler, nil
}

// buildProfiles turns the configuration and the `sip-acl` bucket into the trust boundaries the
// INVITE handler enforces.
//
// # The external profile now exists whenever a bucket does
//
// It used to exist only when SIPD_TRUNK_ACL named a network, because that was the only source of
// entries. Now the source is the watched bucket, and the profile is built whenever either the
// bucket can be opened or the override names something. An external profile whose ACL is empty
// refuses every carrier — `Match` has no default allow and there is no constructor that could give
// it one — so building it early costs nothing and saves a restart the first time a tenant adds a
// trunk.
func buildProfiles(
	ctx context.Context,
	cfg config.Config,
	conn *nats.Conn,
	log *slog.Logger,
) (*profile.Set, *acl.Watcher, error) {
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
		return nil, nil, err
	}

	carrierACL := profile.NewWatchedACL(overrides)
	watcher, err := acl.NewWatcher(carrierACL, overrides, log)
	if err != nil {
		return nil, nil, err
	}

	bucketAvailable := false
	if conn != nil {
		if js, err := jetstream.New(conn); err == nil {
			if bucket, err := acl.OpenBucket(ctx, js); err != nil {
				log.Warn("no sip-acl bucket is available; unauthenticated INVITEs are refused unless "+
					"SIPD_TRUNK_ACL names their source",
					"bucket", contract.SIPACLKV.Name, "error", err)
			} else if _, err := acl.Watch(ctx, bucket, watcher); err != nil {
				log.Warn("cannot watch the sip-acl bucket", "error", err)
			} else {
				bucketAvailable = true
			}
		}
	}

	internal := profile.Internal("internal", listeners...)
	if !bucketAvailable && len(overrides) == 0 {
		// Nothing can ever admit an unauthenticated INVITE, so there is no external boundary to
		// declare. That is the safe state and it is the one this process has always had by default:
		// every INVITE is challenged for a digest.
		set, err := profile.NewSet(internal)
		return set, watcher, err
	}

	external := profile.External("external", carrierACL)
	if cfg.ExternalListenAddr != "" {
		// A socket of its own, which is the stronger separation: the profile is then chosen by the
		// address the packet ARRIVED ON, which no sender can influence, rather than by the address
		// it claims to come from.
		external.Listeners = []profile.Listener{
			{Network: "udp", Addr: cfg.ExternalListenAddr},
			{Network: "tcp", Addr: cfg.ExternalListenAddr},
		}
	}
	set, err := profile.NewSet(internal, external)
	return set, watcher, err
}

// parseTrunkACL reads `cidr[=trunkId]` entries separated by commas.
//
// # It is an OVERRIDE now, not the source
//
// The source is the `sip-acl` bucket. This variable survives as an escape hatch and is deliberately
// not removed, for two situations that are both real: a deployment whose control plane cannot yet
// write the bucket, and an operator who needs one address admitted RIGHT NOW during an incident and
// cannot wait for a database write to propagate. Entries from here are recompiled alongside every
// bucket update and are never removed by one, which is what makes the second case trustworthy.
//
// Empty is now legal and is the expected state, where it used to build no external profile at all.
// A value that is set and names nothing usable is still an error: it is a typo, and a typo in an
// anti-toll-fraud boundary that silently did nothing is exactly the failure this check exists for.
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
		// Priority zero, which OUTRANKS every bucket entry: acl.priorityOf negates the column, whose
		// values are positive, so a bucket entry compiles to a negative priority and an override to
		// zero. That is the intent — an override exists to win — and it is stated here because the
		// arithmetic is not obvious at either end on its own.
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
