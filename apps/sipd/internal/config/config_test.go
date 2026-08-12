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
		"NATS_USER":              "optimiq",
		"NATS_PASS":              "s3cret",
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
	if cfg.NATSURL != "nats://broker:4222" || cfg.NATSUser != "optimiq" || cfg.NATSPass != "s3cret" {
		t.Errorf("nats = %q user=%q", cfg.NATSURL, cfg.NATSUser)
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

// The broker requires authentication, and half a credential is a typo rather than a configuration:
// it produces an authorization violation on every connect and reconnect, forever, with nothing
// fatal to notice it by. Boot is the only place it is cheap to catch.
func TestLoadRejectsHalfANATSCredential(t *testing.T) {
	for _, tc := range []struct {
		name  string
		pairs map[string]string
		want  string
	}{
		{"user without pass", map[string]string{"NATS_USER": "optimiq"}, "NATS_USER is set but NATS_PASS is not"},
		{"pass without user", map[string]string{"NATS_PASS": "s3cret"}, "NATS_PASS is set but NATS_USER is not"},
		{"whitespace is not a password", map[string]string{"NATS_USER": "optimiq", "NATS_PASS": "   "}, "NATS_USER is set but NATS_PASS is not"},
		{"service user without pass", map[string]string{"NATS_SIPD_USER": "optimiq-sipd"}, "NATS_SIPD_USER is set but NATS_SIPD_PASS is not"},
		{"service pass without user", map[string]string{"NATS_SIPD_PASS": "s3cret"}, "NATS_SIPD_PASS is set but NATS_SIPD_USER is not"},
		// Falling back here would hand sipd the OPERATOR identity and hide the typo behind a
		// working connection — the exact failure this check exists to prevent.
		{"half a service pair does not fall back", map[string]string{
			"NATS_USER":      "optimiq",
			"NATS_PASS":      "shared",
			"NATS_SIPD_USER": "optimiq-sipd",
		}, "NATS_SIPD_USER is set but NATS_SIPD_PASS is not"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := config.Load(env(minimal(tc.pairs)))
			if err == nil {
				t.Fatal("Load accepted half a NATS credential")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

// Neither set is a broker with no authentication configured, which is what the SIPp rig and the
// integration tests run. It must stay legal.
func TestLoadAcceptsAnUnauthenticatedBroker(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSUser != "" || cfg.NATSPass != "" {
		t.Errorf("credentials = %q / %q, want both empty", cfg.NATSUser, cfg.NATSPass)
	}
}

// NATS_SIPD_USER/PASS is this process's own least-privilege identity in config/nats.conf — it may
// publish sip.reg.v1.>, request rpc.sip.v1.credential and use the registrations bucket, and
// nothing else. The unprefixed pair is the shared operator credential and only the fallback.
func TestLoadPrefersTheServiceCredentialPair(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"NATS_USER":      "optimiq",
		"NATS_PASS":      "shared",
		"NATS_SIPD_USER": "optimiq-sipd",
		"NATS_SIPD_PASS": "scoped",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSUser != "optimiq-sipd" || cfg.NATSPass != "scoped" {
		t.Errorf("credentials = %q / %q, want the sipd pair to outrank the shared one",
			cfg.NATSUser, cfg.NATSPass)
	}

	shared, err := config.Load(env(minimal(map[string]string{
		"NATS_USER": "optimiq",
		"NATS_PASS": "shared",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if shared.NATSUser != "optimiq" || shared.NATSPass != "shared" {
		t.Errorf("credentials = %q / %q, want the shared pair as the fallback",
			shared.NATSUser, shared.NATSPass)
	}
}

// TLS is OFF unless configured. The shipped broker serves plaintext — its tls block lives in the
// compose.tls.yaml overlay — so a client that demanded TLS by default could never reach it.
func TestLoadLeavesTLSOffUnlessConfigured(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSTLSCA != "" || cfg.NATSTLSEnabled {
		t.Errorf("tls = %q / %v, want both off by default", cfg.NATSTLSCA, cfg.NATSTLSEnabled)
	}

	withTLS, err := config.Load(env(minimal(map[string]string{
		"NATS_TLS_CA":      "/etc/nats/certs/ca.pem",
		"NATS_TLS_ENABLED": "true",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if withTLS.NATSTLSCA != "/etc/nats/certs/ca.pem" || !withTLS.NATSTLSEnabled {
		t.Errorf("tls = %q / %v", withTLS.NATSTLSCA, withTLS.NATSTLSEnabled)
	}
}

// The transports added with the INVITE wave: TLS, WS and WSS, each off by default and each with a
// bind address of its own so a deployment can use the conventional ports.
func TestTransportDefaults(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.EnableTLS || cfg.EnableWS || cfg.EnableWSS {
		t.Error("the secure and websocket transports must be opt-in")
	}
	if cfg.TLSListenAddr != "0.0.0.0:5061" || cfg.WSSListenAddr != "0.0.0.0:8089" {
		t.Errorf("addresses = %q / %q, want the conventional SIP TLS and WSS ports",
			cfg.TLSListenAddr, cfg.WSSListenAddr)
	}
	if cfg.EnableInvite {
		t.Error("the INVITE surface must stay off until an engine serves rpc.sip.v1.invite: " +
			"with no responder a 503 is a worse answer than the registrar's honest 501")
	}
	if cfg.EnableSessionTimers {
		t.Error("session timers must be opt-in: a one-sided timer is worse than none")
	}
	if cfg.MaxContactsPerAOR != 5 {
		t.Errorf("MaxContactsPerAOR = %d, want 5", cfg.MaxContactsPerAOR)
	}
	if cfg.InstanceID == "" {
		t.Error("an instance id is required: a dialog lives on one process and its commands must reach it")
	}
}

func TestTransportConfigurationIsValidated(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			name: "TLS with no certificate",
			env:  map[string]string{"SIPD_TLS": "true"},
			want: "SIPD_TLS_CERT_FILE and SIPD_TLS_KEY_FILE are both required",
		},
		{
			name: "WSS with no certificate",
			env:  map[string]string{"SIPD_WSS": "true"},
			want: "SIPD_TLS_CERT_FILE and SIPD_TLS_KEY_FILE are both required",
		},
		{
			name: "a certificate with no secure transport enabled",
			env: map[string]string{
				"SIPD_TLS_CERT_FILE": "/etc/sipd/tls.crt",
				"SIPD_TLS_KEY_FILE":  "/etc/sipd/tls.key",
			},
			want: "this deployment is plaintext and believes it is not",
		},
		{
			name: "every listener disabled",
			env:  map[string]string{"SIPD_UDP": "false", "SIPD_TCP": "false"},
			want: "sipd would accept no traffic at all",
		},
		{
			name: "two transports on one address",
			env: map[string]string{
				"SIPD_WS":             "true",
				"SIPD_WS_LISTEN_ADDR": "0.0.0.0:5060",
			},
			want: "one socket cannot serve two transports",
		},
		{
			name: "a session interval below the RFC 4028 floor",
			env:  map[string]string{"SIPD_SESSION_TIMERS": "true", "SIPD_MIN_SE": "30"},
			want: "at least 90 seconds",
		},
		{
			name: "a session interval below the negotiated floor",
			env: map[string]string{
				"SIPD_SESSION_TIMERS":  "true",
				"SIPD_MIN_SE":          "600",
				"SIPD_SESSION_EXPIRES": "120",
			},
			want: "must not be below SIPD_MIN_SE",
		},
		{
			name: "a zero contact cap",
			env:  map[string]string{"SIPD_MAX_CONTACTS": "0"},
			want: "SIPD_MAX_CONTACTS must be positive",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := config.Load(env(minimal(tc.env)))
			if err == nil {
				t.Fatal("Load must refuse this configuration")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestSecureTransportsLoadWhenFullyConfigured(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"SIPD_TLS":             "true",
		"SIPD_WS":              "true",
		"SIPD_WSS":             "true",
		"SIPD_TLS_CERT_FILE":   "/etc/sipd/tls.crt",
		"SIPD_TLS_KEY_FILE":    "/etc/sipd/tls.key",
		"SIPD_INVITE":          "true",
		"SIPD_INSTANCE_ID":     "sipd-7c9f",
		"SIPD_SESSION_TIMERS":  "true",
		"SIPD_SESSION_EXPIRES": "900",
		"SIPD_MIN_SE":          "120",
		"SIPD_MAX_CONTACTS":    "3",
		"SIPD_TRUNK_ACL":       "203.0.113.0/24=trunk-telnyx",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.EnableTLS || !cfg.EnableWS || !cfg.EnableWSS || !cfg.EnableInvite {
		t.Error("every enabled transport must survive Load")
	}
	if cfg.InstanceID != "sipd-7c9f" {
		t.Errorf("InstanceID = %q", cfg.InstanceID)
	}
	if cfg.SessionExpires != 900*time.Second || cfg.MinSE != 120*time.Second {
		t.Errorf("session timers = %s / %s", cfg.SessionExpires, cfg.MinSE)
	}
	if cfg.MaxContactsPerAOR != 3 {
		t.Errorf("MaxContactsPerAOR = %d", cfg.MaxContactsPerAOR)
	}
	if cfg.TrunkACL != "203.0.113.0/24=trunk-telnyx" {
		t.Errorf("TrunkACL = %q", cfg.TrunkACL)
	}
}
