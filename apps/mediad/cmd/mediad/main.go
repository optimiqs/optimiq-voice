// Command mediad is the Optimiq Voice media plane.
//
// It answers `rpc.media.v1.*` with SDP, allocates RTP/RTCP port pairs, relays between two sessions
// or mixes N of them with mix-minus, reads RTCP, and publishes `media.evt.v1.*`. The `media-sessions`
// KV directory records which instance holds which session, so later commands reach that instance.
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
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/health"
	"github.com/optimiqs/optimiq-voice/packages/runtime-go/proclimit"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/metrics"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	secure "github.com/optimiqs/optimiq-voice/apps/mediad/internal/webrtc"
)

// queueGroup lets several mediad instances share the command subjects; NATS delivers each request
// to exactly one of them. See control.Server.Subscribe.
const queueGroup = "mediad"

func main() {
	var err error
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		err = health.Probe(os.Getenv("MEDIAD_HEALTH_ADDR"))
	} else {
		err = run()
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		// The logger may not exist yet when configuration fails; everything after boot is JSON.
		fmt.Fprintf(os.Stderr, "mediad: %v\n", err)
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

	// SIGINT/SIGTERM cancel this context; the reaper and every session read loop hang off it, so
	// shutdown is one cancel rather than a chain of Close calls that race.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if soft := proclimit.ApplyMemoryLimit(os.Getenv, proclimit.DefaultHeadroomPercent); soft > 0 {
		log.Info("GOMEMLIMIT derived from the container memory limit", "softLimitBytes", soft)
	}

	allocator, err := rtp.NewAllocator(cfg.BindIP, cfg.RTPPortMin, cfg.RTPPortMax)
	if err != nil {
		return err
	}
	allocator.SocketBufferBytes = cfg.RTPSocketBufferBytes

	natsOpts := []nats.Option{
		nats.Name(config.EventSource),
		// RTP does not go through NATS, so a live session survives a broker restart; giving up
		// reconnecting would kill live audio over a control-plane problem.
		nats.MaxReconnects(-1),
		nats.CustomInboxPrefix("_INBOX.mediad"),
		nats.ReconnectWait(time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Warn("nats disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			log.Info("nats reconnected", "url", c.ConnectedUrl())
		}),
	}
	// An empty pair means a broker with no authentication; config.Load has already refused a
	// half-set pair. The `mediad` user's permissions are scoped in config/nats.conf, so a subject
	// outside that set fails as an authorization violation on the publish, not at connect.
	if cfg.NATSUser != "" {
		natsOpts = append(natsOpts, nats.UserInfo(cfg.NATSUser, cfg.NATSPass))
	}
	// Transport security, off unless configured. RootCAs both enables TLS and pins the bundle
	// (private CA); Secure is the system-trust-store case. Neither set leaves the connection plaintext.
	switch {
	case cfg.NATSTLSCA != "":
		natsOpts = append(natsOpts, nats.RootCAs(cfg.NATSTLSCA))
	case cfg.NATSTLSEnabled:
		natsOpts = append(natsOpts, nats.Secure())
	}

	conn, err := nats.Connect(cfg.NATSURL, natsOpts...)
	if err != nil {
		// A rejected credential takes the process down deliberately: a media plane that cannot be
		// commanded is a pool of ports nobody can allocate.
		return fmt.Errorf("connecting to NATS at %s: %w", cfg.NATSURL, err)
	}
	defer func() {
		if err := conn.Drain(); err != nil {
			log.Warn("draining the NATS connection", "error", err)
		}
	}()

	// JetStream backs the `media-sessions` KV directory, without which a second instance cannot
	// route a command, and the lifecycle publisher, without which a call that loses audio ends silently.
	js, err := jetstream.New(conn)
	if err != nil {
		return fmt.Errorf("opening JetStream: %w", err)
	}

	openCtx, cancelOpen := context.WithTimeout(ctx, 10*time.Second)
	sessionDirectory, err := directory.Open(openCtx, js, log)
	var owners *directory.KVOwners
	if err == nil {
		owners, err = directory.OpenOwners(openCtx, js)
	}
	cancelOpen()
	if err != nil {
		return err
	}

	announcer := control.NewLifecycleAnnouncer(
		mediaevents.NewJetStreamPublisher(js), sessionDirectory, cfg.InstanceID, log)

	// Telemetry, fed by decorating the lifecycle the Manager already calls. No switch, for the
	// reason sipd states: a Prometheus registry is not a denial-of-service surface the way pprof is.
	mediadMetrics := metrics.New()

	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:      allocator,
		PublicAddr:     cfg.PublicIP,
		IdleAfter:      cfg.SessionIdleTimeout,
		RTPTimeout:     cfg.RTPTimeout,
		EchoDiagnostic: cfg.EchoDiagnostic,
		Lifecycle:      mediadMetrics.Observe(announcer),
		Logger:         log,
	})
	if err != nil {
		return err
	}

	library := audio.NewLibrary(cfg.SoundsDir)
	if !library.Configured() {
		// Warn rather than refuse to boot: everything but playback still works, and the refusal
		// happens per command by name, which is where an operator can act on it.
		log.Warn("no prompt library is configured; every playback will be refused as not_supported",
			"hint", "set MEDIAD_SOUNDS_DIR to the directory prompts are mounted at")
	}

	if cfg.RecordingsDir == "" {
		// Warn rather than refuse to boot, as with the prompt library: a default pointing at a
		// directory that probably does not exist would turn one clear refusal into a per-call
		// "cannot create file".
		log.Warn("no recordings directory is configured; every recording will be refused as not_supported",
			"hint", "set MEDIAD_RECORDINGS_DIR to the same mount apps/api reads as CDR_RECORDING_ROOT")
	}

	var webRTC *secure.Factory
	if cfg.EnableWebRTC {
		if !cfg.PublicIP.Is4() {
			return errors.New("WebRTC currently requires an IPv4 public address")
		}
		webRTC, err = secure.NewFactory(secure.Options{BindIP: cfg.BindIP, PublicIP: cfg.PublicIP, PortMin: uint16(cfg.WebRTCPortMin), PortMax: uint16(cfg.WebRTCPortMax)})
		if err != nil {
			return fmt.Errorf("configuring WebRTC: %w", err)
		}
	}
	server, err := control.NewServer(control.ServerOptions{
		WebRTC:        webRTC,
		Sessions:      manager,
		Directory:     sessionDirectory,
		Owners:        owners,
		Library:       library,
		RecordingsDir: cfg.RecordingsDir,
		InstanceID:    cfg.InstanceID,
		PublicAddr:    cfg.PublicIP,
		SRTPPolicy:    cfg.SRTPPolicy,
		Logger:        log,
	})
	if err != nil {
		return err
	}
	mediadMetrics.Gauge("sessions", "Media sessions this instance holds.", manager.Len)
	mediadMetrics.Gauge("session_capacity", "Sessions the configured RTP port range can hold.",
		manager.Capacity)

	subscriptions, err := server.Subscribe(conn, queueGroup)
	if err != nil {
		return err
	}
	go server.RenewOwnership(ctx)
	if err := conn.FlushTimeout(3 * time.Second); err != nil {
		return fmt.Errorf("flushing media subscriptions: %w", err)
	}
	healthServer, err := health.Start(ctx, cfg.HealthAddr,
		func() bool { return conn.IsConnected() && !cfg.EchoDiagnostic },
		health.WithPprof(cfg.EnablePprof), health.WithMetrics(mediadMetrics.Handler()))
	if err != nil {
		return err
	}

	log.Info("mediad is up",
		"healthAddr", healthServer.Addr,
		"pprof", cfg.EnablePprof,
		"rtpSocketBufferBytes", allocator.SocketBufferBytes,
		"gomaxprocs", runtime.GOMAXPROCS(0),
		"nats", cfg.NATSURL,
		"bindIp", cfg.BindIP.String(),
		"publicIp", cfg.PublicIP.String(),
		"rtpPortRange", fmt.Sprintf("%d-%d", cfg.RTPPortMin, cfg.RTPPortMax),
		"capacity", cfg.Capacity(),
		"instanceId", cfg.InstanceID,
		"subjects", control.CommandSubjects,
		"soundsDir", cfg.SoundsDir,
		"recordingsDir", cfg.RecordingsDir,
		"queueGroup", queueGroup,
		"rtpTimeout", cfg.RTPTimeout.String(),
		"idleTimeout", cfg.SessionIdleTimeout.String())
	if cfg.EchoDiagnostic {
		// A deployment with this on serves NO working calls — every leg hears itself — so an
		// operator who left it on must see it on every boot.
		log.Warn("MEDIAD_ECHO_DIAGNOSTIC is on: every session ECHOES and no call will connect. " +
			"This is a diagnostic mode; turn it off to serve traffic.")
	}
	log.Info("mediad serves rungs 1-7: two-party relay, WAV prompts and generated tones, RFC 4733 " +
		"DTMF both ways, WAV recording with beep and digit termination, hold/mute and music on " +
		"hold, N-way conference mixing with mix-minus and supervision taps, and G.711/G.722 with " +
		"transcoding at the bridge and mix boundaries. Opus is negotiated and RELAYED but never " +
		"transcoded, and T.38 (rung 8) is still Asterisk's — see plans/mediad-design.md")

	var group sync.WaitGroup
	group.Go(func() {
		if err := manager.RunReaper(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("the idle-session reaper stopped", "error", err)
		}
	})

	select {
	case <-ctx.Done():
	case err := <-healthServer.Errors:
		log.Error("health listener failed", "error", err)
		stop()
	}
	log.Info("shutting down", "timeoutSeconds", int(cfg.ShutdownTimeout/time.Second), "live", manager.Len())

	// Stop accepting commands BEFORE draining sessions: the other order would let an allocate
	// arriving mid-drain create a session nothing will ever release.
	for _, subscription := range subscriptions {
		if err := subscription.Unsubscribe(); err != nil {
			log.Warn("unsubscribing", "subject", subscription.Subject, "error", err)
		}
	}

	drainCtx, cancelDrain := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancelDrain()
	// Then the commands already accepted: a handler still running would otherwise act on a session
	// the drain below has closed.
	if !server.DrainCommands(drainCtx) {
		log.Warn("commands were still running at the shutdown deadline")
	}
	if err := manager.Drain(drainCtx); err != nil {
		log.Warn("draining sessions timed out; exiting anyway", "error", err)
	}
	// The events the drain just produced are handed off, not yet sent; returning here would run the
	// deferred conn.Drain() and exit under them, losing the `session.ended` for every live call.
	if !announcer.Wait(drainCtx) {
		log.Warn("lifecycle events were still in flight at the shutdown deadline; some may be lost")
	}

	group.Wait()
	log.Info("stopped")
	return nil
}
