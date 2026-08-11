// Command mediad is the Optimiq Voice media plane (plan §3.4, PG track).
//
// It serves rung 2 of plans/mediad-design.md §2 — BRIDGED CALLS. It answers `rpc.media.v1.*` with
// SDP (G.711 passthrough plus RFC 4733), allocates RTP/RTCP port pairs from a configured range,
// learns each far end from the packets themselves, relays between two sessions, and publishes
// `media.evt.v1.*` when a session ends or its audio stops. Which mediad instance holds which session
// is recorded in the `media-sessions` KV directory, so the commands after an allocate reach the one
// instance that can serve them.
//
// The rungs above this one (recording → MOH/park → conference mix-minus → Opus/G.722 → T.38) are
// still Asterisk's, and Asterisk keeps serving every real call until each is proven. The engine
// chooses per deployment with ENGINE_MEDIA_DRIVER.
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

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// queueGroup lets several mediad instances share the command subjects; NATS delivers each request
// to exactly one of them. See control.Server.Subscribe.
const queueGroup = "mediad"

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		// The logger may not exist yet when configuration fails, so this one line goes to stderr
		// directly. Everything after boot is structured JSON.
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

	allocator, err := rtp.NewAllocator(cfg.BindIP, cfg.RTPPortMin, cfg.RTPPortMax)
	if err != nil {
		return err
	}

	natsOpts := []nats.Option{
		nats.Name(config.EventSource),
		// A media plane must survive a broker restart without dropping calls in progress: RTP does
		// not go through NATS, so a session already up keeps working while the control surface
		// reconnects. Giving up would kill live audio to fix a control-plane problem.
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
	// integration rig runs. config.Load has already refused a half-set pair.
	if cfg.NATSUser != "" {
		natsOpts = append(natsOpts, nats.UserInfo(cfg.NATSUser, cfg.NATSPass))
	}

	conn, err := nats.Connect(cfg.NATSURL, natsOpts...)
	if err != nil {
		// A rejected credential lands here as "nats: Authorization Violation" and takes the process
		// down with it. Deliberate: a media plane that cannot be commanded is not degraded, it is
		// a pool of ports nobody can allocate.
		return fmt.Errorf("connecting to NATS at %s: %w", cfg.NATSURL, err)
	}
	defer func() {
		if err := conn.Drain(); err != nil {
			log.Warn("draining the NATS connection", "error", err)
		}
	}()

	// JetStream is needed for two things and neither is optional at this rung: the `media-sessions`
	// KV directory, without which a second instance cannot route a command, and the lifecycle
	// publisher, without which a call that loses audio ends silently.
	js, err := jetstream.New(conn)
	if err != nil {
		return fmt.Errorf("opening JetStream: %w", err)
	}

	openCtx, cancelOpen := context.WithTimeout(ctx, 10*time.Second)
	sessionDirectory, err := directory.Open(openCtx, js, log)
	cancelOpen()
	if err != nil {
		return err
	}

	announcer := control.NewLifecycleAnnouncer(
		mediaevents.NewJetStreamPublisher(js), sessionDirectory, cfg.InstanceID, log)

	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:      allocator,
		PublicAddr:     cfg.PublicIP,
		IdleAfter:      cfg.SessionIdleTimeout,
		RTPTimeout:     cfg.RTPTimeout,
		EchoDiagnostic: cfg.EchoDiagnostic,
		Lifecycle:      announcer,
		Logger:         log,
	})
	if err != nil {
		return err
	}

	server, err := control.NewServer(control.ServerOptions{
		Sessions:   manager,
		Directory:  sessionDirectory,
		InstanceID: cfg.InstanceID,
		PublicAddr: cfg.PublicIP,
		Logger:     log,
	})
	if err != nil {
		return err
	}
	subscriptions, err := server.Subscribe(conn, queueGroup)
	if err != nil {
		return err
	}

	log.Info("mediad is up",
		"nats", cfg.NATSURL,
		"bindIp", cfg.BindIP.String(),
		"publicIp", cfg.PublicIP.String(),
		"rtpPortRange", fmt.Sprintf("%d-%d", cfg.RTPPortMin, cfg.RTPPortMax),
		"capacity", cfg.Capacity(),
		"instanceId", cfg.InstanceID,
		"subjects", []string{
			control.SubjectAllocateSession,
			control.SubjectBridgeSessions,
			control.SubjectUnbridgeSessions,
			control.SubjectReleaseSession,
		},
		"queueGroup", queueGroup,
		"rtpTimeout", cfg.RTPTimeout.String(),
		"idleTimeout", cfg.SessionIdleTimeout.String())
	if cfg.EchoDiagnostic {
		// Refused as a state rather than as a value: a deployment with this on serves NO working
		// calls, because every leg hears itself instead of the other party. It is a smoke-test mode
		// and an operator who left it on needs to see that on every boot, not once in a changelog.
		log.Warn("MEDIAD_ECHO_DIAGNOSTIC is on: every session ECHOES and no call will connect. " +
			"This is a diagnostic mode; turn it off to serve traffic.")
	}
	log.Info("mediad serves rung 2 (bridged calls): G.711 passthrough, RFC 4733 DTMF, two-party " +
		"relay. Recording, MOH, conferencing and T.38 are still Asterisk's — see plans/mediad-design.md")

	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		if err := manager.RunReaper(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("the idle-session reaper stopped", "error", err)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down", "timeoutSeconds", int(cfg.ShutdownTimeout/time.Second), "live", manager.Len())

	// Stop accepting commands BEFORE draining sessions. The other order would let an allocate
	// arriving mid-drain create a session nothing will ever release.
	for _, subscription := range subscriptions {
		if err := subscription.Unsubscribe(); err != nil {
			log.Warn("unsubscribing", "subject", subscription.Subject, "error", err)
		}
	}

	drainCtx, cancelDrain := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancelDrain()
	if err := manager.Drain(drainCtx); err != nil {
		log.Warn("draining sessions timed out; exiting anyway", "error", err)
	}

	group.Wait()
	log.Info("stopped")
	return nil
}
