package config_test

import (
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
)

func env(pairs map[string]string) config.Getenv {
	return func(key string) string { return pairs[key] }
}

// minimal is the smallest environment that boots. It is one variable, and that is the point: every
// other knob has a default that is right for a single-host development run.
func minimal(extra map[string]string) map[string]string {
	pairs := map[string]string{
		"MEDIAD_PUBLIC_IP": "203.0.113.10",
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

	if cfg.NATSURL != "nats://127.0.0.1:4222" {
		t.Errorf("NATSURL = %q", cfg.NATSURL)
	}
	if cfg.NATSUser != "" || cfg.NATSPass != "" {
		t.Errorf("NATS credentials should default to empty, got %q/%q", cfg.NATSUser, cfg.NATSPass)
	}
	if cfg.BindIP.String() != "0.0.0.0" {
		t.Errorf("BindIP = %q, want 0.0.0.0", cfg.BindIP)
	}
	if cfg.PublicIP.String() != "203.0.113.10" {
		t.Errorf("PublicIP = %q", cfg.PublicIP)
	}
	// The default range must not overlap Asterisk's 10000-20000, because both run on the same host
	// for the whole cutover.
	if cfg.RTPPortMin != 30000 || cfg.RTPPortMax != 30999 {
		t.Errorf("RTP range = %d-%d, want 30000-30999", cfg.RTPPortMin, cfg.RTPPortMax)
	}
	if cfg.RTPPortMin <= 20000 {
		t.Errorf("the default RTP range starts at %d, which overlaps Asterisk's 10000-20000",
			cfg.RTPPortMin)
	}
	if cfg.SessionIdleTimeout != time.Minute {
		t.Errorf("SessionIdleTimeout = %s", cfg.SessionIdleTimeout)
	}
	if cfg.ShutdownTimeout != 10*time.Second {
		t.Errorf("ShutdownTimeout = %s", cfg.ShutdownTimeout)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
}

func TestCapacityCountsPairsNotPorts(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// 1000 ports is 500 sessions: each takes an even RTP port and the odd RTCP port above it.
	if got := cfg.Capacity(); got != 500 {
		t.Errorf("Capacity() = %d, want 500 (1000 ports = 500 RTP/RTCP pairs)", got)
	}
}

func TestLoadReadsEveryKnob(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"NATS_URL":                    "nats://broker:4222",
		"NATS_USER":                   "optimiq",
		"NATS_PASS":                   "s3cret",
		"MEDIAD_BIND_IP":              "10.0.0.4",
		"MEDIAD_PUBLIC_IP":            "198.51.100.7",
		"MEDIAD_RTP_PORT_MIN":         "40000",
		"MEDIAD_RTP_PORT_MAX":         "40099",
		"MEDIAD_SESSION_IDLE_TIMEOUT": "2m",
		"MEDIAD_SHUTDOWN_TIMEOUT":     "30s",
		"MEDIAD_LOG_LEVEL":            "debug",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.NATSURL != "nats://broker:4222" || cfg.NATSUser != "optimiq" || cfg.NATSPass != "s3cret" {
		t.Errorf("nats = %q user=%q", cfg.NATSURL, cfg.NATSUser)
	}
	if cfg.BindIP.String() != "10.0.0.4" || cfg.PublicIP.String() != "198.51.100.7" {
		t.Errorf("addresses: bind=%q public=%q", cfg.BindIP, cfg.PublicIP)
	}
	if cfg.RTPPortMin != 40000 || cfg.RTPPortMax != 40099 || cfg.Capacity() != 50 {
		t.Errorf("range = %d-%d capacity=%d", cfg.RTPPortMin, cfg.RTPPortMax, cfg.Capacity())
	}
	if cfg.SessionIdleTimeout != 2*time.Minute || cfg.ShutdownTimeout != 30*time.Second {
		t.Errorf("timeouts = %s / %s", cfg.SessionIdleTimeout, cfg.ShutdownTimeout)
	}
	if cfg.LogLevel != slog.LevelDebug {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
}

// The broker URL is deliberately UNPREFIXED, matching apps/api, apps/engine and apps/sipd: where
// the broker lives is a property of the deployment, not of this process. The CREDENTIAL is the
// opposite — see TestNATSCredentialsPreferTheServicePair.
func TestNATSVariablesAreUnprefixed(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"MEDIAD_NATS_URL": "nats://wrong:4222",
		"NATS_URL":        "nats://right:4222",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSURL != "nats://right:4222" {
		t.Errorf("NATSURL = %q; NATS_URL is the platform-wide name and MEDIAD_NATS_URL is not read",
			cfg.NATSURL)
	}
}

// NATS_MEDIAD_USER/PASS is this process's own least-privilege identity in config/nats.conf; the
// unprefixed pair is the shared operator credential and only the fallback.
func TestNATSCredentialsPreferTheServicePair(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"NATS_USER":        "optimiq",
		"NATS_PASS":        "shared",
		"NATS_MEDIAD_USER": "optimiq-mediad",
		"NATS_MEDIAD_PASS": "scoped",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSUser != "optimiq-mediad" || cfg.NATSPass != "scoped" {
		t.Errorf("credentials = %q/%q; the mediad pair outranks the shared one", cfg.NATSUser, cfg.NATSPass)
	}
}

// A deployment that has not split its credentials keeps working unchanged.
func TestNATSCredentialsFallBackToTheSharedPair(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"NATS_USER": "optimiq",
		"NATS_PASS": "shared",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSUser != "optimiq" || cfg.NATSPass != "shared" {
		t.Errorf("credentials = %q/%q; the shared pair is the fallback", cfg.NATSUser, cfg.NATSPass)
	}
}

// Falling back from a half-set service pair would silently hand this process the OPERATOR identity
// and hide the typo behind a working connection. It is refused instead.
func TestHalfAServiceCredentialIsRefusedEvenWithASharedPair(t *testing.T) {
	_, err := config.Load(env(minimal(map[string]string{
		"NATS_USER":        "optimiq",
		"NATS_PASS":        "shared",
		"NATS_MEDIAD_USER": "optimiq-mediad",
	})))
	if err == nil {
		t.Fatal("Load: expected a half-set NATS_MEDIAD pair to be refused")
	}
	if !strings.Contains(err.Error(), "NATS_MEDIAD_USER is set but NATS_MEDIAD_PASS is not") {
		t.Errorf("error = %v; it should name the pair that is half set", err)
	}
}

// TLS is OFF unless configured: the shipped broker serves plaintext and its tls block lives in the
// compose.tls.yaml overlay, so a client that demanded TLS by default could never connect to it.
func TestTLSIsOffUnlessConfigured(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.NATSTLSCA != "" || cfg.NATSTLSEnabled {
		t.Errorf("tls = %q/%v; both must default off", cfg.NATSTLSCA, cfg.NATSTLSEnabled)
	}

	withCA, err := config.Load(env(minimal(map[string]string{
		"NATS_TLS_CA":      "/etc/nats/certs/ca.pem",
		"NATS_TLS_ENABLED": "true",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if withCA.NATSTLSCA != "/etc/nats/certs/ca.pem" || !withCA.NATSTLSEnabled {
		t.Errorf("tls = %q/%v", withCA.NATSTLSCA, withCA.NATSTLSEnabled)
	}
}

func TestIdleReapingCanBeDisabled(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{"MEDIAD_SESSION_IDLE_TIMEOUT": "0s"})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SessionIdleTimeout != 0 {
		t.Errorf("SessionIdleTimeout = %s, want 0 (reaping disabled)", cfg.SessionIdleTimeout)
	}
}

func TestLoadRejectsBadConfiguration(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			// The whole reason it has no default: a wrong advertised address fails as one-way
			// audio, which is silent, rather than as an error.
			name: "no public ip",
			env:  map[string]string{},
			want: "MEDIAD_PUBLIC_IP is required",
		},
		{
			name: "public ip is not an address",
			env:  map[string]string{"MEDIAD_PUBLIC_IP": "media.example.com"},
			want: "must be an IP address",
		},
		{
			// The one wrong value an operator is most likely to copy from MEDIAD_BIND_IP.
			name: "public ip is the bind address",
			env:  map[string]string{"MEDIAD_PUBLIC_IP": "0.0.0.0"},
			want: "bind address and not a reachable one",
		},
		{
			name: "bind ip is not an address",
			env:  minimal(map[string]string{"MEDIAD_BIND_IP": "eth0"}),
			want: "MEDIAD_BIND_IP must be an IP address",
		},
		{
			// RFC 3550 §11: an odd start misaligns every pair in the range.
			name: "odd port range start",
			env:  minimal(map[string]string{"MEDIAD_RTP_PORT_MIN": "30001"}),
			want: "must be even",
		},
		{
			name: "inverted port range",
			env: minimal(map[string]string{
				"MEDIAD_RTP_PORT_MIN": "40000", "MEDIAD_RTP_PORT_MAX": "30000",
			}),
			want: "must not exceed",
		},
		{
			name: "privileged port range",
			env: minimal(map[string]string{
				"MEDIAD_RTP_PORT_MIN": "80", "MEDIAD_RTP_PORT_MAX": "1000",
			}),
			want: "must be at least 1024",
		},
		{
			name: "port range past the top of the port space",
			env: minimal(map[string]string{
				"MEDIAD_RTP_PORT_MIN": "65534", "MEDIAD_RTP_PORT_MAX": "65535",
			}),
			want: "must be at most 65534",
		},
		{
			// One port cannot hold a pair.
			name: "range too small for one pair",
			env: minimal(map[string]string{
				"MEDIAD_RTP_PORT_MIN": "30000", "MEDIAD_RTP_PORT_MAX": "30000",
			}),
			want: "no RTP/RTCP pair at all",
		},
		{
			name: "port range is not a number",
			env:  minimal(map[string]string{"MEDIAD_RTP_PORT_MIN": "thirty thousand"}),
			want: "must be a whole number",
		},
		{
			name: "half a nats credential",
			env:  minimal(map[string]string{"NATS_USER": "optimiq"}),
			want: "NATS authentication needs both",
		},
		{
			name: "the other half of a nats credential",
			env:  minimal(map[string]string{"NATS_PASS": "s3cret"}),
			want: "NATS authentication needs both",
		},
		{
			name: "negative idle timeout",
			env:  minimal(map[string]string{"MEDIAD_SESSION_IDLE_TIMEOUT": "-5s"}),
			want: "must not be negative",
		},
		{
			name: "zero shutdown timeout",
			env:  minimal(map[string]string{"MEDIAD_SHUTDOWN_TIMEOUT": "0s"}),
			want: "MEDIAD_SHUTDOWN_TIMEOUT must be positive",
		},
		{
			name: "unparseable duration",
			env:  minimal(map[string]string{"MEDIAD_SHUTDOWN_TIMEOUT": "ten seconds"}),
			want: "must be a Go duration",
		},
		{
			name: "unknown log level",
			env:  minimal(map[string]string{"MEDIAD_LOG_LEVEL": "verbose"}),
			want: "must be one of debug/info/warn/error",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := config.Load(env(tc.env))
			if err == nil {
				t.Fatal("Load accepted an invalid configuration")
			}
			if !errors.Is(err, config.ErrInvalid) {
				t.Errorf("error does not wrap ErrInvalid: %v", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v\nwant it to mention %q", err, tc.want)
			}
		})
	}
}

// Every problem is reported at once, so bringing up a new deployment is one round trip rather than
// one restart per missing variable.
func TestLoadReportsEveryProblemAtOnce(t *testing.T) {
	_, err := config.Load(env(map[string]string{
		"MEDIAD_RTP_PORT_MIN": "30001",
		"NATS_USER":           "optimiq",
	}))
	if err == nil {
		t.Fatal("Load accepted an invalid configuration")
	}
	for _, want := range []string{"MEDIAD_PUBLIC_IP is required", "must be even", "needs both"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error is missing %q:\n%v", want, err)
		}
	}
}

// A 4-in-6 address is the same address; it must not print as a different-looking string.
func TestAddressesAreUnmapped(t *testing.T) {
	cfg, err := config.Load(env(map[string]string{
		"MEDIAD_PUBLIC_IP": "::ffff:203.0.113.10",
		"MEDIAD_BIND_IP":   "::ffff:10.0.0.4",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PublicIP.String() != "203.0.113.10" {
		t.Errorf("PublicIP = %q, want the unmapped 203.0.113.10", cfg.PublicIP)
	}
	if cfg.BindIP.String() != "10.0.0.4" {
		t.Errorf("BindIP = %q, want the unmapped 10.0.0.4", cfg.BindIP)
	}
}

// IPv6 is a legitimate media address and must survive Load intact.
func TestIPv6PublicAddress(t *testing.T) {
	cfg, err := config.Load(env(map[string]string{"MEDIAD_PUBLIC_IP": "2001:db8::1"}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PublicIP.String() != "2001:db8::1" {
		t.Errorf("PublicIP = %q", cfg.PublicIP)
	}
}

// Load must not read process-global state; passing nil falls back to os.Getenv, which in a test
// process has no MEDIAD_PUBLIC_IP and therefore fails rather than picking something up.
func TestLoadWithNilGetenvFallsBackToTheProcessEnvironment(t *testing.T) {
	if _, err := config.Load(nil); err == nil {
		t.Fatal("Load(nil) succeeded; the test process has no MEDIAD_PUBLIC_IP set")
	}
}
