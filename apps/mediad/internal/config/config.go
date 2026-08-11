// Package config resolves mediad's runtime configuration from the environment.
//
// Same contract as apps/sipd/internal/config, and deliberately so: every knob is an environment
// variable, every variable has a documented default except the ones where a wrong default is an
// operational problem, and validation happens once at boot so a misconfigured media plane fails to
// start rather than failing per-call. A media server that boots and then hands out unroutable
// addresses is worse than one that refuses to boot, because the symptom is one-way audio on live
// calls rather than a line in a log at deploy time.
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
	// NATSURL is the backbone. NATS_URL, default nats://127.0.0.1:4222.
	//
	// Unprefixed, and NOT `MEDIAD_NATS_URL`. apps/api, apps/engine and apps/sipd all read this
	// name; where the broker lives is a property of the deployment rather than of any one
	// process. The RTP knobs below are MEDIAD_-prefixed because they genuinely belong to this
	// process alone.
	NATSURL string

	// NATSUser and NATSPass authenticate to it. NATS_MEDIAD_USER / NATS_MEDIAD_PASS, falling
	// back to the unprefixed NATS_USER / NATS_PASS.
	//
	// The prefixed pair is this process's OWN broker identity. `config/nats.conf` gives the
	// `mediad` user a permission set scoped to what this inventory actually needs — the four
	// `rpc.media.v1.*` command subjects, `media.evt.v1.>` publishes and the `media-sessions` KV
	// bucket — and nothing else. It cannot read `rpc.sip.v1.credential`, cannot forge a CDR leg
	// and cannot see another plane's events. That is the whole reason the prefixed pair exists:
	// a media plane that is compromised should not also be a control plane.
	//
	// The unprefixed fallback is what keeps a deployment that has not split its credentials, and
	// the integration rig that starts an unauthenticated broker, working unchanged.
	//
	// Both empty is legal and means "a broker with no authentication configured", which is what
	// the integration rig starts. One set without the other is NOT legal, PER PAIR: it is a
	// rename applied to half a pair, and the broker would answer every connect with an
	// authorization violation this process would spend its life retrying.
	//
	// They are options rather than userinfo in NATSURL because the URL is logged — the boot line,
	// every reconnect, and the connect error itself all carry it.
	NATSUser string
	NATSPass string

	// NATSTLSCA is the path to a PEM bundle the broker's certificate must chain to.
	// NATS_TLS_CA. Empty is PLAINTEXT unless NATS_TLS_ENABLED says otherwise.
	//
	// Empty by default on purpose: the shipped broker listens without TLS and the `tls` block
	// lives in `compose.tls.yaml`, an overlay. A client that demanded TLS by default would fail
	// to connect on every checkout that has never run `config/certs/generate-dev-certs.sh`.
	NATSTLSCA string

	// NATSTLSEnabled turns on TLS against the SYSTEM trust store. NATS_TLS_ENABLED.
	//
	// The two-name split matters: a private CA (development, and any deployment that issues its
	// own) needs NATSTLSCA, while a broker whose certificate comes from a public issuer needs
	// only this. Setting NATSTLSCA implies this.
	NATSTLSEnabled bool

	// BindIP is the address the RTP/RTCP sockets bind. MEDIAD_BIND_IP, default 0.0.0.0.
	//
	// Distinct from PublicIP on purpose. Behind NAT — every container deployment, and most cloud
	// ones — the socket binds a private address while the SDP must advertise the public one.
	// Collapsing the two into a single variable is the single most common cause of one-way audio
	// in a media plane, so they are two variables that are validated separately.
	BindIP netip.Addr

	// PublicIP is the address advertised to the far end. MEDIAD_PUBLIC_IP. REQUIRED.
	//
	// There is no default, for the same reason sipd's realm has none: every candidate default is
	// wrong somewhere, and the failure mode of a wrong value is not an error but silence — the far
	// end sends its RTP to an address that drops it, and the call connects with no audio one way.
	// A required variable turns that into a boot failure an operator sees once.
	//
	// v0 does not emit SDP yet (see plans/mediad-design.md §5). It is required now anyway, because
	// the allocate reply already carries the address the engine will put in an SDP `c=` line, and
	// making it optional today would mean changing a deployed contract later.
	PublicIP netip.Addr

	// RTPPortMin and RTPPortMax bound the port range sessions are allocated from.
	// MEDIAD_RTP_PORT_MIN (default 30000), MEDIAD_RTP_PORT_MAX (default 30999).
	//
	// The default range is deliberately disjoint from Asterisk's 10000-20000
	// (ASTERISK_RTP_PORT_START/END in .env.example). mediad and Asterisk run side by side for the
	// whole cutover, and two media servers sharing a port range on one host is a race whose loser
	// is a call.
	//
	// Min must be EVEN. RFC 3550 §11 puts RTP on an even port and its RTCP on the odd port above
	// it, so the range is consumed in pairs and a range starting odd would misalign every pair in
	// it. Capacity is therefore (max-min+1)/2 concurrent sessions, not (max-min+1).
	RTPPortMin int
	RTPPortMax int

	// InstanceID names this process on the wire, in the session directory, and on every lifecycle
	// event. MEDIAD_INSTANCE_ID, defaulting to the hostname plus the pid.
	//
	// It has to be STABLE for the life of the process and DISTINCT between processes, and those are
	// the only two requirements. The hostname alone is not enough — two mediad containers on one
	// host in a local compose run share it — and a random value alone would be unreadable in the
	// one place it matters most, which is an operator reading "session X lives on instance Y" and
	// having to work out which container that is.
	InstanceID string

	// RTPTimeout declares a session dead when it HAS received audio and then stops for this long.
	// MEDIAD_RTP_TIMEOUT, default 30s. Zero falls back to SessionIdleTimeout.
	//
	// Distinct from SessionIdleTimeout, and the distinction is the whole point: this one is a MEDIA
	// FAILURE on a call the signalling plane still believes is up, and it is announced as such. The
	// idle timeout below is a port-leak backstop for sessions that never carried anything.
	//
	// 30 seconds rather than something tighter because RTP is UDP over networks that hiccup: a
	// two-second gap is a bad Wi-Fi moment, and tearing a call down for one would make mediad worse
	// than the network it runs on. Thirty seconds of total silence is not a hiccup.
	RTPTimeout time.Duration

	// EchoDiagnostic makes every allocated session echo instead of relay. MEDIAD_ECHO_DIAGNOSTIC,
	// default false.
	//
	// Design doc open question 5, settled: echo survives rung 2 as the simplest possible smoke test
	// of a real deployment's ports and NAT, and it is put behind a flag so it can never be reached
	// by a production call path. A deployment that turns this on has NO working calls, by design —
	// every leg hears itself — which is why it is refused loudly at boot when it is on.
	EchoDiagnostic bool

	// SessionIdleTimeout reaps a session that has received no RTP for this long.
	// MEDIAD_SESSION_IDLE_TIMEOUT, default 60s. Zero disables reaping.
	//
	// This is a port-leak backstop, not a call-teardown policy: the engine releases sessions it
	// knows about, and this catches the ones it stopped knowing about — an engine that crashed
	// mid-call, a release that was never sent, a leg that never sent a packet. A leaked port is
	// permanent capacity loss until restart, so the backstop matters more than its precision.
	SessionIdleTimeout time.Duration

	// SoundsDir is the directory `rpc.media.v1.start-playback` resolves `sound:` references under.
	// MEDIAD_SOUNDS_DIR, default empty.
	//
	// Empty is legal and means this instance REFUSES every playback with `not_supported`, which the
	// engine answers by routing the leg to Asterisk. That is the correct default for a rung-1
	// cutover: a deployment opts into mediad playback by mounting a prompt store, and one that has
	// not must fail loudly rather than answer `ok` and send silence at a caller.
	//
	// It is the same mount Asterisk gets as `ENGINE_OBJECT_MEDIA_ROOT`, deliberately, so one
	// `sound:` string resolves on either plane while both are serving calls. See the package doc on
	// internal/audio for why a mounted directory and not an HTTP fetch from apps/api.
	SoundsDir string

	// RecordingsDir is the directory `rpc.media.v1.start-recording` writes files under.
	// MEDIAD_RECORDINGS_DIR, default empty.
	//
	// Empty is legal and means this instance REFUSES every recording with `not_supported`, which the
	// engine answers by routing the leg to Asterisk — the same shape as SoundsDir above, and for the
	// same reason: a recording that answered `ok` and wrote nowhere is a call that connects, sounds
	// perfect, and has no recording, discovered days later by the person who needed it.
	//
	// It is the SAME MOUNT apps/api reads as CDR_RECORDING_ROOT, and the layout under it is the
	// engine's object key exactly — `<orgId>/<callId>/<recordingRef>.wav` — so a file mediad writes
	// is a file the existing archive pipeline stats and copies with no change at all. Getting that
	// convention wrong is not a broken recording but a missing one: the archiver logs that the
	// object was not on the shared volume and moves on.
	RecordingsDir string

	// LogLevel is MEDIAD_LOG_LEVEL (debug|info|warn|error), default info.
	LogLevel slog.Level

	// ShutdownTimeout bounds graceful shutdown. MEDIAD_SHUTDOWN_TIMEOUT, default 10s.
	ShutdownTimeout time.Duration
}

// EventSource is the `source` field mediad stamps on anything it publishes, and its NATS client
// name. It matches the directory, as sipd's does.
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
// Every problem is collected before returning, rather than returning the first: an operator
// bringing up a new deployment should learn about all four missing variables at once instead of
// discovering them one restart at a time.
func Load(getenv Getenv) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}

	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	cfg := Config{
		NATSURL:   stringOr(getenv, "NATS_URL", "nats://127.0.0.1:4222"),
		NATSTLSCA: strings.TrimSpace(getenv("NATS_TLS_CA")),
	}

	// The per-service pair first, the shared pair as the fallback. `problems` collects the
	// half-set complaint rather than returning it, so an operator sees it alongside every other
	// configuration error in one startup message.
	cfg.NATSUser, cfg.NATSPass, problems = resolveNATSCredentials(getenv, "MEDIAD", problems)

	var err error
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
			// 0.0.0.0 binds every interface, but as an advertised address it means "send to
			// nowhere". It is the one wrong value an operator is most likely to copy from
			// MEDIAD_BIND_IP, so it is refused by name.
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
		// The instance id ends up in logs, in a KV value and on the wire. Constraining it to the
		// same character set every other token on this backbone uses means it can never be the
		// reason a value fails to parse somewhere three services away.
		fail("MEDIAD_INSTANCE_ID must be one token of [A-Za-z0-9_-], got %q", cfg.InstanceID)
	}
	if cfg.ShutdownTimeout <= 0 {
		fail("MEDIAD_SHUTDOWN_TIMEOUT must be positive")
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("%w:\n  - %s", ErrInvalid, strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// ErrInvalid marks a configuration problem, for callers that want to branch on it.
var ErrInvalid = errors.New("mediad configuration is invalid")

// checkPortRange validates the RTP range as a unit. It is separate from Load so the pair-alignment
// rules are stated once, in the order an operator would hit them.
func checkPortRange(low, high int) []string {
	var problems []string
	add := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	// Ports 0-1023 need privileges nothing in this deployment grants, and port 0 means "pick one"
	// to the kernel — which would defeat having a range at all.
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
// `NATS_<SERVICE>_USER` / `NATS_<SERVICE>_PASS` win when BOTH are set — that is the least-privilege
// user `config/nats.conf` defines for this process. Otherwise the shared `NATS_USER` / `NATS_PASS`
// are used, which is what a deployment that has not split its credentials and the integration rig
// still supply. Both absent is a broker with no authentication, which is legal.
//
// A HALF-SET pair is refused PER PAIR, and refused rather than ignored: falling back from a
// half-set `NATS_MEDIAD_*` to the shared pair would hand this process the operator identity and
// hide the typo behind a working connection, which is the failure this check exists to prevent.
// It is collected into `problems` rather than returned so one startup message carries every
// configuration error at once.
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
	// Unmap so a 4-in-6 form such as ::ffff:10.0.0.4 compares and prints as the IPv4 address the
	// operator wrote, rather than as a different-looking string with the same meaning.
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

// defaultInstanceID builds a stable, distinct, readable name for this process.
//
// hostname-pid: the hostname is what an operator recognises, the pid disambiguates two processes on
// one host (a local compose run, or a restart whose predecessor has not fully exited). A hostname
// that is not a clean token has its illegal characters folded to `-` rather than being rejected,
// because refusing to boot over a machine name nobody chose would be refusing to boot for no
// operational reason.
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

// isSubjectToken mirrors the contract package's token rule, restated here so config validation does
// not drag a dependency on it into the boot path.
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
