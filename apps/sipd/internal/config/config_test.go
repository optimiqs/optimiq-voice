package config_test

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/config"
)

func env(pairs map[string]string) config.Getenv {
	return func(key string) string { return pairs[key] }
}

func minimal(extra map[string]string) map[string]string {
	pairs := map[string]string{
		"SIPD_REALM":            "acme.example.com",
		"SIPD_CREDENTIALS_FILE": "/etc/sipd/credentials.json",
	}
	for key, value := range extra {
		pairs[key] = value
	}
	return pairs
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.ListenAddr != "0.0.0.0:5060" {
		t.Errorf("ListenAddr = %q", cfg.ListenAddr)
	}
	if !cfg.EnableUDP || !cfg.EnableTCP {
		t.Error("both transports must be on by default: a REGISTER can exceed the UDP MTU")
	}
	if cfg.NATSURL != "nats://127.0.0.1:4222" {
		t.Errorf("NATSURL = %q", cfg.NATSURL)
	}
	if cfg.MinExpires != 60*time.Second || cfg.MaxExpires != time.Hour || cfg.DefaultExpires != 300*time.Second {
		t.Errorf("expiry defaults = %s/%s/%s", cfg.MinExpires, cfg.MaxExpires, cfg.DefaultExpires)
	}
	if cfg.CredentialSource != config.CredentialSourceFile {
		t.Errorf("CredentialSource = %q, want file", cfg.CredentialSource)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
	if cfg.SweepInterval != 5*time.Second {
		t.Errorf("SweepInterval = %s", cfg.SweepInterval)
	}
}

func TestLoadReadsEveryKnob(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"SIPD_LISTEN_ADDR":       "10.0.0.4:5080",
		"SIPD_UDP":               "false",
		"SIPD_TCP":               "1",
		"NATS_URL":               "nats://broker:4222",
		"SIPD_MIN_EXPIRES":       "30",
		"SIPD_MAX_EXPIRES":       "7200",
		"SIPD_DEFAULT_EXPIRES":   "600",
		"SIPD_NONCE_TTL":         "2m",
		"SIPD_NONCE_SECRET":      "fleet-wide",
		"SIPD_SWEEP_INTERVAL":    "1s",
		"SIPD_USER_AGENT":        "optimiq-sipd/1",
		"SIPD_LOG_LEVEL":         "debug",
		"SIPD_SHUTDOWN_TIMEOUT":  "30s",
		"SIPD_CREDENTIAL_SOURCE": "nats",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.ListenAddr != "10.0.0.4:5080" || cfg.EnableUDP || !cfg.EnableTCP {
		t.Errorf("listeners = %q udp=%v tcp=%v", cfg.ListenAddr, cfg.EnableUDP, cfg.EnableTCP)
	}
	if cfg.MinExpires != 30*time.Second || cfg.MaxExpires != 7200*time.Second || cfg.DefaultExpires != 600*time.Second {
		t.Errorf("expiry = %s/%s/%s", cfg.MinExpires, cfg.MaxExpires, cfg.DefaultExpires)
	}
	if cfg.NonceTTL != 2*time.Minute || cfg.NonceSecret != "fleet-wide" {
		t.Errorf("nonce = %s / %q", cfg.NonceTTL, cfg.NonceSecret)
	}
	if cfg.LogLevel != slog.LevelDebug {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
	if cfg.CredentialSource != config.CredentialSourceNATS {
		t.Errorf("CredentialSource = %q", cfg.CredentialSource)
	}
	if cfg.ShutdownTimeout != 30*time.Second {
		t.Errorf("ShutdownTimeout = %s", cfg.ShutdownTimeout)
	}
}

func TestLoadRejectsBadConfiguration(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			"no realm",
			map[string]string{"SIPD_CREDENTIALS_FILE": "/x"},
			"SIPD_REALM is required",
		},
		{
			"both transports off",
			minimal(map[string]string{"SIPD_UDP": "false", "SIPD_TCP": "false"}),
			"would accept no traffic",
		},
		{
			"file source without a file",
			map[string]string{"SIPD_REALM": "acme.example.com"},
			"SIPD_CREDENTIALS_FILE is required",
		},
		{
			"min above max",
			minimal(map[string]string{"SIPD_MIN_EXPIRES": "7200", "SIPD_MAX_EXPIRES": "60"}),
			"must not exceed",
		},
		{
			"default outside the range",
			minimal(map[string]string{"SIPD_DEFAULT_EXPIRES": "10"}),
			"must lie within",
		},
		{
			"unknown credential source",
			minimal(map[string]string{"SIPD_CREDENTIAL_SOURCE": "ldap"}),
			"SIPD_CREDENTIAL_SOURCE must be",
		},
		{
			"non-numeric expiry",
			minimal(map[string]string{"SIPD_MIN_EXPIRES": "1m"}),
			"whole number of seconds",
		},
		{
			"non-boolean toggle",
			minimal(map[string]string{"SIPD_UDP": "yes please"}),
			"must be a boolean",
		},
		{
			"bad log level",
			minimal(map[string]string{"SIPD_LOG_LEVEL": "verbose"}),
			"debug/info/warn/error",
		},
		{
			"bad duration",
			minimal(map[string]string{"SIPD_SWEEP_INTERVAL": "soon"}),
			"Go duration",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := config.Load(env(tc.env))
			if err == nil {
				t.Fatal("Load accepted an invalid configuration")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestLoadReportsEveryProblemAtOnce(t *testing.T) {
	// One boot, one list. Fixing configuration one error per restart is miserable in a container.
	_, err := config.Load(env(map[string]string{
		"SIPD_UDP":         "false",
		"SIPD_TCP":         "false",
		"SIPD_MIN_EXPIRES": "nope",
	}))
	if err == nil {
		t.Fatal("Load accepted an invalid configuration")
	}
	if strings.Count(err.Error(), "\n  - ") < 3 {
		t.Errorf("error reports too few problems:\n%v", err)
	}
}
