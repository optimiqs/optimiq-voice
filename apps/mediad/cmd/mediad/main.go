// Command mediad is the Optimiq Voice media plane (plan §3.4, PG track).
//
// Today it is a WALKING SKELETON: it allocates RTP/RTCP port pairs from a configured range over
// `rpc.media.v0.allocate` / `.release`, receives RTP on them, learns the far end from the packets
// themselves, and echoes G.711 back. That is the substrate — nothing more. The capability ladder
// that turns it into Asterisk's replacement (bridged calls → recording → conference mix-minus →
// T.38) is in plans/mediad-design.md, and Asterisk keeps serving every real call until each rung
// is proven.
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

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
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

	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: cfg.PublicIP,
		IdleAfter:  cfg.SessionIdleTimeout,
		Logger:     log,
	})
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

	server, err := control.NewServer(manager, log)
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
		"allocateSubject", control.SubjectAllocate,
		"releaseSubject", control.SubjectRelease,
		"queueGroup", queueGroup,
		"idleTimeout", cfg.SessionIdleTimeout.String())
	log.Warn("this is the mediad walking skeleton: it allocates ports and echoes G.711. " +
		"No call is served by it — Asterisk is still the media plane. See plans/mediad-design.md")

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
