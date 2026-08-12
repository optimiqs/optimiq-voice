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

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/invite"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
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

	// The INVITE surface, off unless SIPD_INVITE says otherwise.
	//
	// Off is the honest default and it must stay so until apps/engine serves `rpc.sip.v1.invite`:
	// with no responder every INVITE is answered 503 after the admission deadline, and a 503 tells
	// a carrier to retry HERE shortly, whereas the 501 the registrar answers today tells it this
	// element does not place calls. Turning it on is a deliberate act by a deployment that has the
	// other half.
	if cfg.EnableInvite {
		invites, err := newInviteHandler(cfg, server, sipClient, authenticator, credentialStore, ctx, log)
		if err != nil {
			return err
		}
		server.OnInvite(invites.HandleInvite)
		server.OnAck(invites.HandleAck)
		server.OnBye(invites.HandleBye)
		server.OnCancel(invites.HandleCancel)
		server.OnUpdate(invites.HandleUpdate)
		server.OnInfo(invites.HandleInfo)
		defer func() {
			if !invites.Wait(cfg.ShutdownTimeout) {
				log.Warn("some dialog work was still in flight at shutdown")
			}
		}()
	}

	// Everything else — MESSAGE, PUBLISH, … — is honestly refused rather than half-answered.
	server.OnNoRoute(reg.HandleUnsupported)

	var group sync.WaitGroup
	errs := make(chan error, 8)

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

// newInviteHandler wires the INVITE surface: two listener profiles, the dialog table, the same
// digest authenticator every other handler uses, and the engine seam.
//
// # The two profiles, and why they are structure rather than a comment
//
// parity-audit row 1.26 records that the internal/external trust boundary is enforced today by
// convention in a config file. Here it is two `profile.Profile` values with different
// authentication, different NAT policy and — the load-bearing one — different ROUTING CONTEXTS: a
// digest-authenticated call resolves in the tenant's internal context and a trunk-matched one in
// the untrusted context, which is what stops an inbound PSTN call from dialling back out through a
// trunk. The external profile exists only when SIPD_TRUNK_ACL names at least one network, because
// internal/profile refuses to construct an external profile with an empty ACL.
func newInviteHandler(
	cfg config.Config,
	server *sipgo.Server,
	client *sipgo.Client,
	authenticator *registrar.Authenticator,
	credentialStore credentials.Store,
	ctx context.Context,
	log *slog.Logger,
) (*invite.Handler, error) {
	profiles, err := buildProfiles(cfg)
	if err != nil {
		return nil, err
	}
	requester, err := invite.NewClientRequester(client)
	if err != nil {
		return nil, err
	}

	dialogs := dialog.NewStore(dialog.StoreOptions{InstanceID: cfg.InstanceID})
	timers := dialog.TimerPolicy{
		Enabled:            cfg.EnableSessionTimers,
		MinSE:              cfg.MinSE,
		DefaultSE:          cfg.SessionExpires,
		MaxSE:              cfg.SessionExpires * 4,
		PreferLocalRefresh: true,
	}

	handler, err := invite.New(invite.Options{
		Realm:       cfg.Realm,
		Auth:        authenticator,
		Credentials: credentialStore,
		Dialogs:     dialogs,
		// The `sip-dialogs` bucket does not exist in packages/events-go, so the claim store is the
		// in-process one: a single instance works, and nothing reaps a dead peer's calls. The
		// contract change that closes it is named in the wave report.
		Claims:       dialog.NewMemoryClaimStore(),
		Profiles:     profiles,
		Port:         invite.RefusingPort{Reason: invite.ReasonShuttingDown},
		Requester:    requester,
		Responder:    server,
		Contact:      contactURI(cfg),
		InstanceID:   cfg.InstanceID,
		Timers:       timers,
		Logger:       log,
		ServerHeader: cfg.UserAgent,
		BaseContext:  ctx,
		NewLegID:     contract.NewEventID,
	})
	if err != nil {
		return nil, err
	}

	log.Info("INVITE handling ready",
		"instanceId", cfg.InstanceID,
		"profiles", len(profiles.Profiles()),
		"sessionTimers", cfg.EnableSessionTimers)
	log.Warn("the INVITE surface is enabled and no engine serves rpc.sip.v1.invite: " +
		"every call will be refused 503 with a Retry-After until that responder exists")
	return handler, nil
}

// buildProfiles turns the configuration into the trust boundaries the INVITE handler enforces.
func buildProfiles(cfg config.Config) (*profile.Set, error) {
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

	internal := profile.Internal("internal", listeners...)
	if strings.TrimSpace(cfg.TrunkACL) == "" {
		return profile.NewSet(internal)
	}

	entries, err := parseTrunkACL(cfg.TrunkACL)
	if err != nil {
		return nil, err
	}
	external := profile.External("external", profile.NewACL(entries))
	if cfg.ExternalListenAddr != "" {
		// A socket of its own, which is the stronger separation: the profile is then chosen by the
		// address the packet ARRIVED ON, which no sender can influence, rather than by the address
		// it claims to come from.
		external.Listeners = []profile.Listener{
			{Network: "udp", Addr: cfg.ExternalListenAddr},
			{Network: "tcp", Addr: cfg.ExternalListenAddr},
		}
	}
	return profile.NewSet(internal, external)
}

// parseTrunkACL reads `cidr[=trunkId]` entries separated by commas.
func parseTrunkACL(raw string) ([]profile.Entry, error) {
	fields := strings.Split(raw, ",")
	entries := make([]profile.Entry, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		network, trunkID, _ := strings.Cut(field, "=")
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
