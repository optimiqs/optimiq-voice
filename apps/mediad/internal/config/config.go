// Package config resolves mediad's runtime configuration from the environment.
//
// Every knob is an environment variable, and validation happens once in [Load] so a misconfigured
// media plane fails to start rather than per-call: the symptom of a bad address is one-way audio on
// live calls, not an error.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is mediad's fully-resolved configuration. It is immutable after Load.
type Config struct {
	// HealthAddr is an optional private HTTP listener for /healthz and /readyz.
	HealthAddr                   string
	EnableWebRTC                 bool
	WebRTCPortMin, WebRTCPortMax int
	// NATSURL is the backbone. NATS_URL, default nats://127.0.0.1:4222.
	//
	// Unprefixed on purpose: apps/api, apps/engine and apps/sipd read the same name, because where
	// the broker lives is a property of the deployment rather than of any one process.
	NATSURL string

	// NATSUser and NATSPass authenticate to it. NATS_MEDIAD_USER / NATS_MEDIAD_PASS, falling back
	// to the unprefixed NATS_USER / NATS_PASS.
	//
	// The prefixed pair is this process's own least-privilege identity, scoped in config/nats.conf
	// to the `rpc.media.v1.*` subjects, `media.evt.v1.>` and the `media-sessions` KV bucket. Both
	// empty is legal (a broker with no authentication); half a pair is refused, per pair, because
	// falling back would hand this process the operator identity and hide the typo.
	//
	// They are options rather than userinfo in NATSURL because the URL is logged.
	NATSUser string
	NATSPass string

	// NATSTLSCA is the path to a PEM bundle the broker's certificate must chain to. NATS_TLS_CA.
	// Empty is plaintext unless NATSTLSEnabled says otherwise.
	NATSTLSCA string

	// NATSTLSEnabled turns on TLS against the system trust store. NATS_TLS_ENABLED. A private CA
	// needs NATSTLSCA instead, which implies this.
	NATSTLSEnabled bool

	// BindIP is the address the RTP/RTCP sockets bind. MEDIAD_BIND_IP, default 0.0.0.0.
	//
	// Distinct from PublicIP: behind NAT the socket binds a private address while the SDP must
	// advertise the public one, so the two are validated separately.
	BindIP netip.Addr

	// PublicIP is the address advertised to the far end. MEDIAD_PUBLIC_IP. Required.
	//
	// No default: every candidate is wrong somewhere, and a wrong value fails as silence — the far
	// end sends RTP to an address that drops it — rather than as an error.
	PublicIP netip.Addr

	// RTPPortMin and RTPPortMax bound the port range sessions are allocated from.
	// MEDIAD_RTP_PORT_MIN (default 30000), MEDIAD_RTP_PORT_MAX (default 30999).
	//
	// The default range is disjoint from Asterisk's 10000-20000, since both run side by side for
	// the cutover. Min must be EVEN: RFC 3550 §11 puts RTP on an even port and RTCP on the odd port
	// above it, so capacity is (max-min+1)/2 sessions, not (max-min+1).
	RTPPortMin int
	RTPPortMax int

	// InstanceID names this process on the wire, in the session directory and on every lifecycle
	// event. MEDIAD_INSTANCE_ID, defaulting to the hostname plus the pid. It must be stable for the
	// life of the process and distinct between processes.
	InstanceID string

	// RTPTimeout declares a session dead when it HAS received audio and then stops for this long.
	// MEDIAD_RTP_TIMEOUT, default 30s. Zero falls back to SessionIdleTimeout.
	//
	// Distinct from SessionIdleTimeout: this is a media failure on a call the signalling plane
	// still believes is up, and is announced as such. 30s because RTP is UDP over networks that
	// hiccup, and a two-second gap is not a dead call.
	RTPTimeout time.Duration

	// EchoDiagnostic makes every allocated session echo instead of relay. MEDIAD_ECHO_DIAGNOSTIC,
	// default false. A deployment with it on serves no working calls by design, so it is behind a
	// flag and warned about loudly at boot.
	EchoDiagnostic bool

	// SessionIdleTimeout reaps a session that has received no RTP for this long.
	// MEDIAD_SESSION_IDLE_TIMEOUT, default 60s. Zero disables reaping.
	//
	// A port-leak backstop rather than a teardown policy: it catches sessions the engine stopped
	// knowing about, and a leaked port is capacity lost until restart.
	SessionIdleTimeout time.Duration

	// SoundsDir is the directory `rpc.media.v1.start-playback` resolves `sound:` references under.
	// MEDIAD_SOUNDS_DIR, default empty.
	//
	// Empty is legal and means this instance refuses every playback with `not_supported`, which the
	// engine answers by routing the leg to Asterisk. It is the same mount Asterisk gets as
	// ENGINE_OBJECT_MEDIA_ROOT, so one `sound:` string resolves on either plane.
	SoundsDir string

	// RecordingsDir is the directory `rpc.media.v1.start-recording` writes files under.
	// MEDIAD_RECORDINGS_DIR, default empty. Empty refuses every recording with `not_supported`.
	//
	// It must be the same mount apps/api reads as CDR_RECORDING_ROOT, and the layout under it is
	// the engine's object key exactly (`<orgId>/<callId>/<recordingRef>.wav`), so a file mediad
	// writes is one the existing archive pipeline picks up unchanged.
	RecordingsDir string

	// RTPSocketBufferBytes sizes SO_RCVBUF/SO_SNDBUF on every allocated RTP/RTCP pair.
	// MEDIAD_RTP_SOCKET_BUFFER_BYTES, default 512 KiB. Zero leaves the kernel default.
	//
	// The default holds roughly two seconds of one leg's G.711 at 50 pps, so a read loop that is
	// descheduled catches up from the socket instead of losing the overflow in the kernel.
	RTPSocketBufferBytes int

	// EnablePprof serves net/http/pprof on the private health listener. MEDIAD_PPROF, default false.
	//
	// The health listener only: an open profiling endpoint on a public port is both a denial of
	// service and a memory disclosure.
	EnablePprof bool

	// LogLevel is MEDIAD_LOG_LEVEL (debug|info|warn|error), default info.
	LogLevel slog.Level

	// ShutdownTimeout bounds graceful shutdown. MEDIAD_SHUTDOWN_TIMEOUT, default 10s.
	ShutdownTimeout time.Duration

	// SRTPPolicy decides SDES-SRTP (RFC 4568) on the SIP/RTP legs. MEDIAD_SRTP_POLICY, default
	// `prefer`. WebRTC is unaffected: that leg is DTLS-SRTP and mandatory either way.
	//
	// Deployment-wide because no per-org or per-device setting exists yet; when one does, the engine
	// carries it per leg on allocate-session and this becomes the fallback.
	SRTPPolicy SRTPPolicy
}

// SRTPPolicy is what mediad does about SDES on a SIP leg.
type SRTPPolicy string

const (
	// SRTPPrefer accepts SDES when the offer carries a usable crypto line under SAVP, and answers
	// plain RTP/AVP otherwise. The default: desk phones on UDP/TCP frequently offer neither.
	SRTPPrefer SRTPPolicy = "prefer"
	// SRTPRequire refuses an offer with no usable SDES.
	SRTPRequire SRTPPolicy = "require"
	// SRTPDisable never offers or accepts SDES.
	SRTPDisable SRTPPolicy = "disable"
)

// EventSource is the `source` field mediad stamps on anything it publishes, and its NATS client
// name.
const EventSource = "mediad"

// Capacity reports how many concurrent sessions the configured range can hold.
func (c Config) Capacity() int {
	if c.RTPPortMax < c.RTPPortMin {
		return 0
	}
	return (c.RTPPortMax - c.RTPPortMin + 1) / 2
}

// Getenv is the environment accessor Load reads through, so tests need no process-global state.
type Getenv func(string) string

// Load resolves and validates the configuration. Pass os.Getenv in production.
//
// Every problem is collected before returning rather than returning the first, so an operator
// learns about all of them in one startup message.
func Load(getenv Getenv) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}

	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	cfg := Config{
		HealthAddr: strings.TrimSpace(getenv("MEDIAD_HEALTH_ADDR")),
		NATSURL:    stringOr(getenv, "NATS_URL", "nats://127.0.0.1:4222"),
		NATSTLSCA:  strings.TrimSpace(getenv("NATS_TLS_CA")),
	}

	cfg.NATSUser, cfg.NATSPass, problems = resolveNATSCredentials(getenv, "MEDIAD", problems)

	var err error
	if cfg.EnableWebRTC, err = boolOr(getenv, "MEDIAD_WEBRTC", false); err != nil {
		fail("%v", err)
	}
	if cfg.WebRTCPortMin, err = intOr(getenv, "MEDIAD_WEBRTC_PORT_MIN", 31000); err != nil {
		fail("%v", err)
	}
	if cfg.WebRTCPortMax, err = intOr(getenv, "MEDIAD_WEBRTC_PORT_MAX", 31999); err != nil {
		fail("%v", err)
	}
	if cfg.NATSTLSEnabled, err = boolOr(getenv, "NATS_TLS_ENABLED", false); err != nil {
		fail("%v", err)
	}
	if cfg.BindIP, err = addrOr(getenv, "MEDIAD_BIND_IP", netip.AddrFrom4([4]byte{0, 0, 0, 0})); err != nil {
		fail("%v", err)
	}
	if cfg.RTPPortMin, err = intOr(getenv, "MEDIAD_RTP_PORT_MIN", 30000); err != nil {
		fail("%v", err)
	}
	if cfg.RTPPortMax, err = intOr(getenv, "MEDIAD_RTP_PORT_MAX", 30999); err != nil {
		fail("%v", err)
	}
	if cfg.EnableWebRTC {
		if cfg.WebRTCPortMin < 1024 || cfg.WebRTCPortMax > 65535 || cfg.WebRTCPortMax < cfg.WebRTCPortMin {
			fail("WebRTC UDP range must be within 1024-65535 with min <= max")
		}
		if cfg.WebRTCPortMin <= cfg.RTPPortMax && cfg.WebRTCPortMax >= cfg.RTPPortMin {
			fail("WebRTC and RTP port ranges must not overlap")
		}
	}
	if cfg.SessionIdleTimeout, err = durationOr(getenv, "MEDIAD_SESSION_IDLE_TIMEOUT", time.Minute); err != nil {
		fail("%v", err)
	}
	if cfg.RTPTimeout, err = durationOr(getenv, "MEDIAD_RTP_TIMEOUT", 30*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.EchoDiagnostic, err = boolOr(getenv, "MEDIAD_ECHO_DIAGNOSTIC", false); err != nil {
		fail("%v", err)
	}
	cfg.InstanceID = stringOr(getenv, "MEDIAD_INSTANCE_ID", defaultInstanceID())
	cfg.SoundsDir = strings.TrimSpace(getenv("MEDIAD_SOUNDS_DIR"))
	cfg.RecordingsDir = strings.TrimSpace(getenv("MEDIAD_RECORDINGS_DIR"))
	if cfg.ShutdownTimeout, err = durationOr(getenv, "MEDIAD_SHUTDOWN_TIMEOUT", 10*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.LogLevel, err = levelOr(getenv, "MEDIAD_LOG_LEVEL", slog.LevelInfo); err != nil {
		fail("%v", err)
	}
	if cfg.RTPSocketBufferBytes, err = intOr(getenv, "MEDIAD_RTP_SOCKET_BUFFER_BYTES", 1<<19); err != nil {
		fail("%v", err)
	}
	if cfg.EnablePprof, err = boolOr(getenv, "MEDIAD_PPROF", false); err != nil {
		fail("%v", err)
	}
	switch policy := SRTPPolicy(stringOr(getenv, "MEDIAD_SRTP_POLICY", string(SRTPPrefer))); policy {
	case SRTPPrefer, SRTPRequire, SRTPDisable:
		cfg.SRTPPolicy = policy
	default:
		fail("MEDIAD_SRTP_POLICY must be one of prefer/require/disable, got %q", policy)
	}

	// PublicIP has no fallback, so it is parsed here rather than through addrOr.
	switch raw := strings.TrimSpace(getenv("MEDIAD_PUBLIC_IP")); raw {
	case "":
		fail("MEDIAD_PUBLIC_IP is required: it is the address the far end sends RTP to, and " +
			"every wrong guess fails as silence rather than as an error")
	default:
		addr, parseErr := netip.ParseAddr(raw)
		switch {
		case parseErr != nil:
			fail("MEDIAD_PUBLIC_IP must be an IP address, got %q", raw)
		case addr.IsUnspecified():
			// As an advertised address, the unspecified address means "send to nowhere". It is the
			// value most likely to be copied from MEDIAD_BIND_IP, so it is refused by name.
			fail("MEDIAD_PUBLIC_IP is %s, which is a bind address and not a reachable one: "+
				"advertise the address the far end can actually reach", raw)
		default:
			cfg.PublicIP = addr.Unmap()
		}
	}

	if cfg.NATSURL == "" {
		fail("NATS_URL must not be empty")
	}
	problems = append(problems, checkPortRange(cfg.RTPPortMin, cfg.RTPPortMax)...)
	if cfg.SessionIdleTimeout < 0 {
		fail("MEDIAD_SESSION_IDLE_TIMEOUT must not be negative (0 disables idle reaping)")
	}
	if cfg.RTPTimeout < 0 {
		fail("MEDIAD_RTP_TIMEOUT must not be negative (0 falls back to MEDIAD_SESSION_IDLE_TIMEOUT)")
	}
	if !isSubjectToken(cfg.InstanceID) {
		// The id ends up in a NATS subject, so it must be a subject token.
		fail("MEDIAD_INSTANCE_ID must be one token of [A-Za-z0-9_-], got %q", cfg.InstanceID)
	}
	if cfg.ShutdownTimeout <= 0 {
		fail("MEDIAD_SHUTDOWN_TIMEOUT must be positive")
	}
	if cfg.RTPSocketBufferBytes < 0 {
		fail("MEDIAD_RTP_SOCKET_BUFFER_BYTES must not be negative (0 leaves the kernel default), got %d",
			cfg.RTPSocketBufferBytes)
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("%w:\n  - %s", ErrInvalid, strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// ErrInvalid marks a configuration problem, for callers that want to branch on it.
var ErrInvalid = errors.New("mediad configuration is invalid")

// checkPortRange validates the RTP range as a unit.
func checkPortRange(low, high int) []string {
	var problems []string
	add := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	// Ports below 1024 need privileges this deployment does not grant, and port 0 means "pick one".
	if low < 1024 {
		add("MEDIAD_RTP_PORT_MIN must be at least 1024, got %d", low)
	}
	if high > 65534 {
		// 65534 rather than 65535: the pair needs an RTCP port above the RTP one.
		add("MEDIAD_RTP_PORT_MAX must be at most 65534, got %d", high)
	}
	if low > high {
		add("MEDIAD_RTP_PORT_MIN (%d) must not exceed MEDIAD_RTP_PORT_MAX (%d)", low, high)
	}
	if low%2 != 0 {
		add("MEDIAD_RTP_PORT_MIN must be even (%d is not): RFC 3550 §11 pairs an even RTP port "+
			"with the odd RTCP port above it, and an odd start misaligns every pair in the range",
			low)
	}
	if low <= high && low >= 1024 && high <= 65534 && (high-low+1)/2 == 0 {
		add("MEDIAD_RTP_PORT_MIN/MAX (%d-%d) leave room for no RTP/RTCP pair at all", low, high)
	}
	return problems
}

// resolveNATSCredentials reads the broker identity, preferring this service's own.
//
// NATS_<SERVICE>_USER / NATS_<SERVICE>_PASS win when both are set; otherwise the shared
// NATS_USER / NATS_PASS. Both absent is a broker with no authentication, which is legal. A half-set
// pair is refused rather than ignored: falling back would hand this process the operator identity
// and hide the typo behind a working connection. Problems are appended, not returned, so one
// startup message carries them all.
func resolveNATSCredentials(getenv Getenv, service string, problems []string) (string, string, []string) {
	scopedUserKey, scopedPassKey := "NATS_"+service+"_USER", "NATS_"+service+"_PASS"

	for _, pair := range [2][2]string{
		{scopedUserKey, scopedPassKey},
		{"NATS_USER", "NATS_PASS"},
	} {
		user := strings.TrimSpace(getenv(pair[0]))
		pass := strings.TrimSpace(getenv(pair[1]))

		switch {
		case user != "" && pass != "":
			return user, pass, problems
		case user != "":
			return "", "", append(problems, fmt.Sprintf(
				"%s is set but %s is not: NATS authentication needs both", pair[0], pair[1]))
		case pass != "":
			return "", "", append(problems, fmt.Sprintf(
				"%s is set but %s is not: NATS authentication needs both", pair[1], pair[0]))
		}
	}

	return "", "", problems
}

func stringOr(getenv Getenv, key, fallback string) string {
	if value := strings.TrimSpace(getenv(key)); value != "" {
		return value
	}
	return fallback
}

func intOr(getenv Getenv, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback, fmt.Errorf("%s must be a whole number, got %q", key, raw)
	}
	return value, nil
}

func durationOr(getenv Getenv, key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a Go duration such as 30s or 2m, got %q", key, raw)
	}
	return value, nil
}

func addrOr(getenv Getenv, key string, fallback netip.Addr) (netip.Addr, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := netip.ParseAddr(raw)
	if err != nil {
		return fallback, fmt.Errorf("%s must be an IP address, got %q", key, raw)
	}
	// Unmap so a 4-in-6 form such as ::ffff:10.0.0.4 prints as the IPv4 address that was written.
	return value.Unmap(), nil
}

func levelOr(getenv Getenv, key string, fallback slog.Level) (slog.Level, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(raw)); err != nil {
		return fallback, fmt.Errorf("%s must be one of debug/info/warn/error, got %q", key, raw)
	}
	return level, nil
}

// defaultInstanceID builds a stable, distinct, readable name for this process: hostname-pid, with
// any character outside the subject-token set folded to `-` rather than refused.
func defaultInstanceID() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "mediad"
	}
	var cleaned strings.Builder
	for _, r := range host {
		switch {
		case r == '-' || r == '_' ||
			(r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z'):
			cleaned.WriteRune(r)
		default:
			cleaned.WriteRune('-')
		}
	}
	return fmt.Sprintf("%s-%d", cleaned.String(), os.Getpid())
}

// isSubjectToken mirrors the contract package's token rule, restated so validation carries no
// dependency into the boot path.
func isSubjectToken(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r == '-' || r == '_' ||
			(r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z'):
		default:
			return false
		}
	}
	return true
}

func boolOr(getenv Getenv, key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback, fmt.Errorf("%s must be true or false, got %q", key, raw)
	}
	return value, nil
}
