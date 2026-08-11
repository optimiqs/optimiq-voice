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
	// Unprefixed, and NOT `MEDIAD_NATS_URL`. apps/api, apps/engine and apps/sipd all read these
	// three names; the broker credential is one platform-account identity, not a per-service one,
	// and a per-service alias would only give the fleet three names for one secret to drift
	// between. The RTP knobs below are MEDIAD_-prefixed because they genuinely belong to this
	// process alone.
	NATSURL string

	// NATSUser and NATSPass authenticate to it. NATS_USER / NATS_PASS.
	//
	// Both empty is legal and means "a broker with no authentication configured", which is what
	// the integration rig starts. One set without the other is NOT legal: it is a rename applied
	// to half a pair, and the broker would answer every connect with an authorization violation
	// this process would spend its life retrying.
	//
	// They are options rather than userinfo in NATSURL because the URL is logged — the boot line,
	// every reconnect, and the connect error itself all carry it.
	NATSUser string
	NATSPass string

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

	// SessionIdleTimeout reaps a session that has received no RTP for this long.
	// MEDIAD_SESSION_IDLE_TIMEOUT, default 60s. Zero disables reaping.
	//
	// This is a port-leak backstop, not a call-teardown policy: the engine releases sessions it
	// knows about, and this catches the ones it stopped knowing about — an engine that crashed
	// mid-call, a release that was never sent, a leg that never sent a packet. A leaked port is
	// permanent capacity loss until restart, so the backstop matters more than its precision.
	SessionIdleTimeout time.Duration

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
		NATSURL:  stringOr(getenv, "NATS_URL", "nats://127.0.0.1:4222"),
		NATSUser: strings.TrimSpace(getenv("NATS_USER")),
		NATSPass: strings.TrimSpace(getenv("NATS_PASS")),
	}

	var err error
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

	// Half a credential is a typo, not a configuration. Caught here so it costs a startup error
	// rather than an authorization violation on every reconnect for the life of the process.
	if (cfg.NATSUser == "") != (cfg.NATSPass == "") {
		set, missing := "NATS_USER", "NATS_PASS"
		if cfg.NATSUser == "" {
			set, missing = "NATS_PASS", "NATS_USER"
		}
		fail("%s is set but %s is not: NATS authentication needs both", set, missing)
	}

	if cfg.NATSURL == "" {
		fail("NATS_URL must not be empty")
	}
	problems = append(problems, checkPortRange(cfg.RTPPortMin, cfg.RTPPortMax)...)
	if cfg.SessionIdleTimeout < 0 {
		fail("MEDIAD_SESSION_IDLE_TIMEOUT must not be negative (0 disables idle reaping)")
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
