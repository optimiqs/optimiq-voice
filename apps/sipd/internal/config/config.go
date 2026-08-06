// Package config resolves sipd's runtime configuration from the environment.
//
// Twelve-factor: every knob is an environment variable, every variable has a documented default
// except the ones where a wrong default is a security problem, and validation happens once at boot
// so a misconfigured edge fails to start rather than failing per-REGISTER.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

// CredentialSource selects which credentials.Store implementation is wired at boot.
type CredentialSource string

const (
	// CredentialSourceFile reads a static JSON file. Development and the SIPp test rig.
	CredentialSourceFile CredentialSource = "file"
	// CredentialSourceNATS resolves credentials over `rpc.sip.v1.credential` request-reply
	// against apps/api. This is the production source.
	CredentialSourceNATS CredentialSource = "nats"
)

// Config is sipd's fully-resolved configuration. It is immutable after Load.
type Config struct {
	// ListenAddr is the host:port both transports bind. SIPD_LISTEN_ADDR, default 0.0.0.0:5060.
	ListenAddr string
	// EnableUDP and EnableTCP toggle the two listeners. SIPD_UDP / SIPD_TCP, both default true.
	//
	// TCP is not optional in practice: a REGISTER carrying a long Contact and several Via headers
	// exceeds the safe UDP MTU, and RFC 3261 §18.1.1 requires the UA to switch. It is a toggle only
	// so a test rig can isolate one transport.
	EnableUDP bool
	EnableTCP bool

	// Realm is the digest authentication realm presented in every challenge. SIPD_REALM.
	//
	// It is part of HA1 = MD5(username:realm:password), so changing it invalidates every stored
	// credential. There is no default: guessing one would make every deployment share a realm and
	// therefore make a credential from one deployment replayable against another.
	Realm string

	// NATSURL is the backbone. NATS_URL, default nats://127.0.0.1:4222.
	NATSURL string

	// Expiry policy, in seconds on the wire.
	//   SIPD_MIN_EXPIRES     default 60   — below this a REGISTER gets 423 Interval Too Brief
	//   SIPD_MAX_EXPIRES     default 3600 — above this the grant is silently clamped down
	//   SIPD_DEFAULT_EXPIRES default 300  — used when the REGISTER states no interval at all
	MinExpires     time.Duration
	MaxExpires     time.Duration
	DefaultExpires time.Duration

	// NonceTTL bounds how long a digest challenge stays usable. SIPD_NONCE_TTL, default 60s.
	NonceTTL time.Duration
	// NonceSecret keys the nonce MAC. SIPD_NONCE_SECRET.
	//
	// Empty means "generate a random one at boot", which is correct for a single instance and
	// WRONG for a fleet: a device challenged by instance A would be rejected by instance B. Set it
	// (32+ random bytes, same value fleet-wide) in any deployment with more than one replica.
	NonceSecret string

	// SweepInterval is how often the expiry sweeper runs. SIPD_SWEEP_INTERVAL, default 5s.
	//
	// It bounds how late an `expired` event can be, not how long a binding lives: the binding's own
	// deadline is exact, the sweeper is just when we notice.
	SweepInterval time.Duration

	// CredentialSource and CredentialsFile pick and configure the credential store.
	// SIPD_CREDENTIAL_SOURCE (file|nats, default file), SIPD_CREDENTIALS_FILE.
	CredentialSource CredentialSource
	CredentialsFile  string

	// CredentialTimeout bounds one `rpc.sip.v1.credential` request.
	// SIPD_CREDENTIAL_TIMEOUT, default 500ms — the contract's own deadline.
	//
	// It sits inside a REGISTER transaction, and a phone's retransmission timer starts at 500 ms,
	// so a reply slower than that is already competing with the retry it caused. Raising it does
	// not make a slow control plane work; it makes the edge queue behind one.
	CredentialTimeout time.Duration

	// CredentialCacheTTL and CredentialNegativeCacheTTL are how long a resolved credential and a
	// definite refusal are reused. SIPD_CREDENTIAL_CACHE_TTL (default 30s),
	// SIPD_CREDENTIAL_NEGATIVE_CACHE_TTL (default 10s).
	//
	// Short on purpose: the alternative to staleness is an account disabled minutes ago that can
	// still register. The negative one is what stops a username scanner turning into a query per
	// guess. Failures are never cached at any TTL.
	CredentialCacheTTL         time.Duration
	CredentialNegativeCacheTTL time.Duration

	// CredentialCacheMaxEntries bounds the credential cache.
	// SIPD_CREDENTIAL_CACHE_MAX_ENTRIES, default 10000.
	//
	// An unbounded negative cache keyed on an attacker-supplied username is a memory amplifier:
	// one map entry per guess, for free.
	CredentialCacheMaxEntries int

	// ProvisionSecretKey is the provisioning root key, and is normally EMPTY.
	// SIPD_PROVISION_SECRET_KEY.
	//
	// Production sipd never derives a password: `rpc.sip.v1.credential` returns a ready-made HA1
	// the API derived, precisely so this key stays on the control plane rather than on the most
	// internet-exposed process in the system. It derives every tenant's password, so an edge that
	// holds it turns an edge compromise into a total credential compromise.
	//
	// It exists for the file store's derived form: a development or SIPp-rig fixture can name an
	// (orgId, secretRef) pair and get exactly the password apps/api would render, instead of a
	// copied literal that drifts. See internal/credentials/derive.go.
	ProvisionSecretKey string

	// UserAgent is the Server/User-Agent header value. SIPD_USER_AGENT, default "optimiq-sipd".
	UserAgent string

	// LogLevel is SIPD_LOG_LEVEL (debug|info|warn|error), default info.
	LogLevel slog.Level

	// ShutdownTimeout bounds graceful shutdown. SIPD_SHUTDOWN_TIMEOUT, default 10s.
	ShutdownTimeout time.Duration
}

// EventSource is the `source` field sipd stamps on every envelope it publishes.
const EventSource = "sipd"

// Getenv is the environment accessor Load reads through, so tests need no process-global state.
type Getenv func(string) string

// Load resolves and validates the configuration. Pass os.Getenv in production.
func Load(getenv Getenv) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}

	var problems []string
	fail := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	cfg := Config{
		ListenAddr:         stringOr(getenv, "SIPD_LISTEN_ADDR", "0.0.0.0:5060"),
		Realm:              strings.TrimSpace(getenv("SIPD_REALM")),
		NATSURL:            stringOr(getenv, "NATS_URL", "nats://127.0.0.1:4222"),
		NonceSecret:        getenv("SIPD_NONCE_SECRET"),
		CredentialsFile:    getenv("SIPD_CREDENTIALS_FILE"),
		ProvisionSecretKey: strings.TrimSpace(getenv("SIPD_PROVISION_SECRET_KEY")),
		UserAgent:          stringOr(getenv, "SIPD_USER_AGENT", "optimiq-sipd"),
	}

	var err error
	if cfg.EnableUDP, err = boolOr(getenv, "SIPD_UDP", true); err != nil {
		fail("%v", err)
	}
	if cfg.EnableTCP, err = boolOr(getenv, "SIPD_TCP", true); err != nil {
		fail("%v", err)
	}
	if cfg.MinExpires, err = secondsOr(getenv, "SIPD_MIN_EXPIRES", 60); err != nil {
		fail("%v", err)
	}
	if cfg.MaxExpires, err = secondsOr(getenv, "SIPD_MAX_EXPIRES", 3600); err != nil {
		fail("%v", err)
	}
	if cfg.DefaultExpires, err = secondsOr(getenv, "SIPD_DEFAULT_EXPIRES", 300); err != nil {
		fail("%v", err)
	}
	if cfg.NonceTTL, err = durationOr(getenv, "SIPD_NONCE_TTL", time.Minute); err != nil {
		fail("%v", err)
	}
	if cfg.SweepInterval, err = durationOr(getenv, "SIPD_SWEEP_INTERVAL", 5*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.ShutdownTimeout, err = durationOr(getenv, "SIPD_SHUTDOWN_TIMEOUT", 10*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.LogLevel, err = levelOr(getenv, "SIPD_LOG_LEVEL", slog.LevelInfo); err != nil {
		fail("%v", err)
	}
	if cfg.CredentialTimeout, err = durationOr(getenv, "SIPD_CREDENTIAL_TIMEOUT", 500*time.Millisecond); err != nil {
		fail("%v", err)
	}
	if cfg.CredentialCacheTTL, err = durationOr(getenv, "SIPD_CREDENTIAL_CACHE_TTL", 30*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.CredentialNegativeCacheTTL, err = durationOr(getenv, "SIPD_CREDENTIAL_NEGATIVE_CACHE_TTL", 10*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.CredentialCacheMaxEntries, err = intOr(getenv, "SIPD_CREDENTIAL_CACHE_MAX_ENTRIES", 10_000); err != nil {
		fail("%v", err)
	}

	switch source := CredentialSource(stringOr(getenv, "SIPD_CREDENTIAL_SOURCE", string(CredentialSourceFile))); source {
	case CredentialSourceFile, CredentialSourceNATS:
		cfg.CredentialSource = source
	default:
		fail("SIPD_CREDENTIAL_SOURCE must be %q or %q, got %q",
			CredentialSourceFile, CredentialSourceNATS, source)
	}

	if cfg.Realm == "" {
		fail("SIPD_REALM is required: it is part of the digest HA1, so there is no safe default")
	}
	if cfg.ListenAddr == "" {
		fail("SIPD_LISTEN_ADDR must not be empty")
	}
	if !cfg.EnableUDP && !cfg.EnableTCP {
		fail("SIPD_UDP and SIPD_TCP are both false: sipd would accept no traffic at all")
	}
	if cfg.CredentialSource == CredentialSourceFile && cfg.CredentialsFile == "" {
		fail("SIPD_CREDENTIALS_FILE is required when SIPD_CREDENTIAL_SOURCE=file")
	}
	if cfg.CredentialTimeout <= 0 {
		fail("SIPD_CREDENTIAL_TIMEOUT must be positive")
	}
	if cfg.CredentialCacheTTL < 0 || cfg.CredentialNegativeCacheTTL < 0 {
		fail("the credential cache TTLs must not be negative")
	}
	if cfg.CredentialCacheMaxEntries <= 0 {
		fail("SIPD_CREDENTIAL_CACHE_MAX_ENTRIES must be positive")
	}
	// The clamps are only meaningful ordered: min <= default <= max.
	if cfg.MinExpires > cfg.MaxExpires {
		fail("SIPD_MIN_EXPIRES (%s) must not exceed SIPD_MAX_EXPIRES (%s)", cfg.MinExpires, cfg.MaxExpires)
	}
	if cfg.DefaultExpires < cfg.MinExpires || cfg.DefaultExpires > cfg.MaxExpires {
		fail("SIPD_DEFAULT_EXPIRES (%s) must lie within [%s, %s]",
			cfg.DefaultExpires, cfg.MinExpires, cfg.MaxExpires)
	}
	if cfg.MinExpires <= 0 {
		fail("SIPD_MIN_EXPIRES must be positive")
	}
	if cfg.SweepInterval <= 0 {
		fail("SIPD_SWEEP_INTERVAL must be positive")
	}
	if cfg.NonceTTL <= 0 {
		fail("SIPD_NONCE_TTL must be positive")
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("sipd configuration is invalid:\n  - %s",
			strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// ErrInvalid marks a configuration problem, for callers that want to branch on it.
var ErrInvalid = errors.New("invalid sipd configuration")

func stringOr(getenv Getenv, key, fallback string) string {
	if value := strings.TrimSpace(getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolOr(getenv Getenv, key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback, fmt.Errorf("%s must be a boolean (true/false/1/0), got %q", key, raw)
	}
	return value, nil
}

// secondsOr reads a bare integer count of seconds. SIP states intervals in seconds, so the
// environment does too — "300" rather than "5m" — and the wire value is what an operator reads in a
// packet capture.
func secondsOr(getenv Getenv, key string, fallback int) (time.Duration, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return time.Duration(fallback) * time.Second, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("%s must be a non-negative whole number of seconds, got %q", key, raw)
	}
	return time.Duration(value) * time.Second, nil
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
		return 0, fmt.Errorf("%s must be a Go duration such as 5s or 1m, got %q", key, raw)
	}
	return value, nil
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
