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

// minimal is the smallest environment that boots: one variable, because every other knob has a
// default that is right for a single-host development run.
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
	// The default range must not overlap Asterisk's 10000-20000: both run on the same host.
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
	if cfg.RTPSocketBufferBytes != 1<<19 {
		t.Errorf("RTPSocketBufferBytes = %d, want %d", cfg.RTPSocketBufferBytes, 1<<19)
	}
	if cfg.EnablePprof {
		t.Error("EnablePprof must default off; profiling is opt-in")
	}
}

func TestSocketBufferAndPprofAreConfigured(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"MEDIAD_RTP_SOCKET_BUFFER_BYTES": "262144",
		"MEDIAD_PPROF":                   "true",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RTPSocketBufferBytes != 262144 {
		t.Errorf("RTPSocketBufferBytes = %d, want 262144", cfg.RTPSocketBufferBytes)
	}
	if !cfg.EnablePprof {
		t.Error("EnablePprof = false, want true")
	}
}

// Zero is legal and means "leave the kernel default alone"; negative is not a size.
func TestZeroSocketBufferLeavesTheKernelDefault(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{"MEDIAD_RTP_SOCKET_BUFFER_BYTES": "0"})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RTPSocketBufferBytes != 0 {
		t.Errorf("RTPSocketBufferBytes = %d, want 0", cfg.RTPSocketBufferBytes)
	}
}

func TestCapacityCountsPairsNotPorts(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
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

// The broker URL is unprefixed, matching apps/api, apps/engine and apps/sipd; the credential is the
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

// Falling back from a half-set service pair would hand this process the operator identity and hide
// the typo behind a working connection.
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

// The shipped broker serves plaintext and its tls block lives in the compose.tls.yaml overlay, so a
// client that demanded TLS by default could never connect to it.
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
			// The value most likely to be copied from MEDIAD_BIND_IP.
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
			name: "negative socket buffer",
			env:  minimal(map[string]string{"MEDIAD_RTP_SOCKET_BUFFER_BYTES": "-1"}),
			want: "MEDIAD_RTP_SOCKET_BUFFER_BYTES must not be negative",
		},
		{
			name: "unparseable socket buffer",
			env:  minimal(map[string]string{"MEDIAD_RTP_SOCKET_BUFFER_BYTES": "512k"}),
			want: "must be a whole number",
		},
		{
			name: "unparseable pprof switch",
			env:  minimal(map[string]string{"MEDIAD_PPROF": "yes please"}),
			want: "MEDIAD_PPROF must be true or false",
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

func TestIPv6PublicAddress(t *testing.T) {
	cfg, err := config.Load(env(map[string]string{"MEDIAD_PUBLIC_IP": "2001:db8::1"}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PublicIP.String() != "2001:db8::1" {
		t.Errorf("PublicIP = %q", cfg.PublicIP)
	}
}

func TestLoadWithNilGetenvFallsBackToTheProcessEnvironment(t *testing.T) {
	if _, err := config.Load(nil); err == nil {
		t.Fatal("Load(nil) succeeded; the test process has no MEDIAD_PUBLIC_IP set")
	}
}

// An instance with no prompt library refuses every playback by name, and the engine routes those
// legs to Asterisk; a default pointing at a missing directory would turn that into a per-call error.
func TestSoundsDirDefaultsToUnset(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SoundsDir != "" {
		t.Errorf("SoundsDir = %q, want empty", cfg.SoundsDir)
	}
}

func TestSoundsDirIsTrimmed(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"MEDIAD_SOUNDS_DIR": "  /var/lib/optimiq/prompts  ",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SoundsDir != "/var/lib/optimiq/prompts" {
		t.Errorf("SoundsDir = %q, want the trimmed path", cfg.SoundsDir)
	}
}

// Undefaulted for the same reason as MEDIAD_SOUNDS_DIR, and it must be the same mount apps/api
// reads as CDR_RECORDING_ROOT: the layout under it is the engine's own object key.
func TestRecordingsDirDefaultsToUnset(t *testing.T) {
	cfg, err := config.Load(env(minimal(nil)))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RecordingsDir != "" {
		t.Errorf("RecordingsDir = %q, want empty", cfg.RecordingsDir)
	}
}

func TestRecordingsDirIsTrimmed(t *testing.T) {
	cfg, err := config.Load(env(minimal(map[string]string{
		"MEDIAD_RECORDINGS_DIR": "  /opt/optimiq-voice/recordings  ",
	})))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RecordingsDir != "/opt/optimiq-voice/recordings" {
		t.Errorf("RecordingsDir = %q, want the trimmed path", cfg.RecordingsDir)
	}
}
