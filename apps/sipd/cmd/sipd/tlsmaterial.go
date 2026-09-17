package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/siptls"
)

// tlsMaterial is the pair of configurations the edge speaks TLS with: `server` is what the TLS and
// WSS listeners present, `client` is what outbound trunk connections dial with. Either may be nil,
// which means that direction is plaintext.
type tlsMaterial struct {
	server *tls.Config
	client *tls.Config
}

// loadTLSMaterial reads every certificate the process needs, refuses a floor it does not
// understand, and starts the reload watcher.
//
// The watcher is what makes an ACME renewal free: SIGHUP and a file-change poll both re-read the
// PEM pair into the reloader the listeners' GetCertificate hook reads, so no socket is rebound and
// no registration is dropped. It is bounded by ctx and needs no separate shutdown.
func loadTLSMaterial(ctx context.Context, cfg config.Config, log *slog.Logger) (tlsMaterial, error) {
	minimum, err := siptls.ParseMinVersion(cfg.TLSMinVersion)
	if err != nil {
		return tlsMaterial{}, err
	}
	if minimum == siptls.MinTLS12 {
		log.Warn("SIP TLS is admitting TLS 1.2 for legacy peers; 1.3 is the default floor",
			"minVersion", string(minimum), "env", "SIPD_TLS_MIN_VERSION")
	} else {
		log.Info("SIP TLS floor", "minVersion", string(minimum))
	}

	var material tlsMaterial
	if cfg.EnableTLS || cfg.EnableWSS {
		reloader, err := siptls.NewReloader(cfg.TLSCertFile, cfg.TLSKeyFile, log)
		if err != nil {
			return tlsMaterial{}, err
		}
		options := siptls.ServerOptions{Min: minimum, RequireClientCert: cfg.TLSRequireClientCert}
		if cfg.TLSClientCAFile != "" {
			pool, err := siptls.LoadCAs(cfg.TLSClientCAFile)
			if err != nil {
				return tlsMaterial{}, err
			}
			options.ClientCAs = pool
			log.Info("SIP TLS accepts carrier client certificates",
				"clientCA", cfg.TLSClientCAFile, "required", cfg.TLSRequireClientCert)
		}
		material.server = siptls.ServerConfig(reloader, options)

		hangups := make(chan os.Signal, 1)
		signal.Notify(hangups, syscall.SIGHUP)
		reloads := make(chan struct{}, 1)
		go func() {
			defer signal.Stop(hangups)
			for {
				select {
				case <-ctx.Done():
					close(reloads)
					return
				case <-hangups:
					select {
					case reloads <- struct{}{}:
					default:
					}
				}
			}
		}()
		go reloader.Watch(ctx, reloads, cfg.TLSReloadInterval)
	}

	material.client, err = trunkClientConfig(cfg, minimum, log)
	if err != nil {
		return tlsMaterial{}, err
	}
	return material, nil
}

// trunkClientConfig builds what the user agent dials carriers with: the configured floor always,
// plus the client certificate and CA pin when this deployment does mutual TLS with its carriers.
func trunkClientConfig(cfg config.Config, minimum siptls.MinVersion, log *slog.Logger) (*tls.Config, error) {
	var identity siptls.TrunkIdentity
	if cfg.TrunkTLSCertFile != "" {
		certificate, err := tls.LoadX509KeyPair(cfg.TrunkTLSCertFile, cfg.TrunkTLSKeyFile)
		if err != nil {
			return nil, fmt.Errorf("loading the trunk client certificate from %s / %s: %w",
				cfg.TrunkTLSCertFile, cfg.TrunkTLSKeyFile, err)
		}
		identity.Certificate = &certificate
	}
	if cfg.TrunkTLSCAFile != "" {
		pool, err := siptls.LoadCAs(cfg.TrunkTLSCAFile)
		if err != nil {
			return nil, err
		}
		identity.CAs = pool
	}
	if identity.Certificate == nil && identity.CAs == nil {
		return siptls.ClientConfig(siptls.ClientOptions{Min: minimum}), nil
	}
	log.Info("outbound trunk TLS carries mutual authentication",
		"clientCert", cfg.TrunkTLSCertFile, "caPin", cfg.TrunkTLSCAFile)
	options := siptls.ClientOptions{Min: minimum}
	if identity.Certificate != nil {
		options.ClientCertificates = []*tls.Certificate{identity.Certificate}
	}
	if identity.CAs != nil {
		options.Pins = func(serverName string) (siptls.TrunkIdentity, bool) {
			named := identity
			named.TrunkID = serverName
			return named, true
		}
	}
	return siptls.ClientConfig(options), nil
}
