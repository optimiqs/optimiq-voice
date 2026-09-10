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
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/registrar"
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
	// HealthAddr is an optional private HTTP listener for /healthz and /readyz.
	HealthAddr string
	// PProfEnabled serves net/http/pprof on the health listener. SIPD_PPROF, off by default.
	//
	// On the health listener and not one of its own, so there is a single private port to reason
	// about. The loopback gate moves with it: turning this on requires HealthAddr to name a loopback
	// host, because these handlers expose process memory and goroutine stacks and a SIP edge's heap
	// holds credentials in flight.
	PProfEnabled bool
	// SocketBufferBytes sizes SO_RCVBUF/SO_SNDBUF on the UDP listeners. SIPD_SOCKET_BUFFER_BYTES,
	// default 4 MiB, 0 to leave the kernel default. A REGISTER storm arrives faster than one
	// reader goroutine drains it, and a datagram dropped in the socket buffer is a phone that
	// retransmits a second later.
	SocketBufferBytes int
	// PublishAsyncMaxPending bounds unacknowledged JetStream publishes.
	// SIPD_PUBLISH_ASYNC_MAX_PENDING, default 4096. Reaching it blocks the publishing goroutine,
	// which is the backpressure that stops a stalled broker becoming unbounded memory.
	PublishAsyncMaxPending int
	// PublishAsyncTimeout is how long one unacknowledged publish is held before it is reported as
	// failed. SIPD_PUBLISH_ASYNC_TIMEOUT, default 30s.
	PublishAsyncTimeout time.Duration
	// ListenAddr is the host:port both transports bind. SIPD_LISTEN_ADDR, default 0.0.0.0:5060.
	ListenAddr string
	// EnableUDP and EnableTCP toggle the two listeners. SIPD_UDP / SIPD_TCP, both default true.
	// TCP is not optional in practice: RFC 3261 §18.1.1 requires the UA to switch once a request
	// exceeds the safe UDP MTU. The toggle exists so a test rig can isolate one transport.
	EnableUDP bool
	EnableTCP bool

	// TLS, WS and WSS listeners. SIPD_TLS / SIPD_WS / SIPD_WSS, all default false, each with its
	// own bind address so a deployment can put the secure transports on their conventional ports
	// (5061 for TLS, 8089 for WSS) without moving the plaintext ones.
	//
	// SIP over WebSocket (RFC 7118) is the only transport available to a browser softphone. WSS
	// carries signalling only; browser audio is terminated by mediad's WebRTC transport, so both
	// must be enabled in a browser-calling deployment.
	EnableTLS bool
	EnableWS  bool
	EnableWSS bool
	// TLSListenAddr, WSListenAddr and WSSListenAddr are the bind addresses for those three.
	TLSListenAddr string
	WSListenAddr  string
	WSSListenAddr string
	// TLSCertFile and TLSKeyFile are the PEM certificate and key both TLS and WSS present. One pair
	// serves both; a deployment needing different certificates per port needs two processes.
	TLSCertFile string
	TLSKeyFile  string
	// TLSMinVersion is the negotiated floor for every TLS listener and for outbound trunk
	// connections. SIPD_TLS_MIN_VERSION, `1.3` (the default) or `1.2`. Lowering it is logged at
	// boot: RFC 5630 §3.1.3 requires TLS for `sips:` but names no version, and a handful of handset
	// stacks still cannot do 1.3, so the escape hatch stays — loudly.
	TLSMinVersion string
	// TLSReloadInterval is how often the certificate files are stat'd for an out-of-band renewal.
	// SIPD_TLS_RELOAD_INTERVAL, default 30s; `0` leaves SIGHUP as the only trigger.
	TLSReloadInterval time.Duration
	// TLSClientCAFile is the PEM bundle a carrier's CLIENT certificate must chain to for mutual TLS
	// on the inbound side. SIPD_TLS_CLIENT_CA_FILE. Empty asks for no client certificate at all.
	TLSClientCAFile string
	// TLSRequireClientCert turns VerifyClientCertIfGiven into RequireAndVerifyClientCert.
	// SIPD_TLS_REQUIRE_CLIENT_CERT, default false, because a TLS listener shared with handsets
	// cannot demand one. Set it on an edge that terminates carriers only.
	TLSRequireClientCert bool
	// TrunkTLSCertFile and TrunkTLSKeyFile are the CLIENT certificate this edge presents to
	// carriers that ask for one. SIPD_TRUNK_TLS_CERT_FILE / SIPD_TRUNK_TLS_KEY_FILE. Per-trunk
	// selection is by the CA list the carrier names in its CertificateRequest (RFC 8446 §4.4.2.1).
	TrunkTLSCertFile string
	TrunkTLSKeyFile  string
	// TrunkTLSCAFile is the CA pin outbound carrier certificates are verified against, replacing
	// the system roots. SIPD_TRUNK_TLS_CA_FILE.
	TrunkTLSCAFile string

	// EnableInvite turns on the INVITE surface: the dialog layer, the admission RPC, the engine's
	// five-subject command surface, the trunk directory, the `sip-acl` watch and the claim reaper.
	// SIPD_INVITE, default false.
	//
	// It is off by default because it converts a registrar into a call-processing element with
	// prerequisites the deployment must already meet: the front end must be dialog-affine (a
	// mid-dialog request landing on the wrong instance is answered 481), and the `trunks` and
	// `sip-acl` buckets must be written by apps/api.
	EnableInvite bool
	// InstanceID is this process's identity on the backbone: it stamps every `sip-dialogs` claim and
	// is the token engine commands for these dialogs are addressed at. SIPD_INSTANCE_ID, defaulting
	// to the hostname.
	InstanceID string

	// Session timers (RFC 4028). SIPD_SESSION_TIMERS (default false), SIPD_SESSION_EXPIRES (1800)
	// and SIPD_MIN_SE (90, the RFC's own floor). Off by default because mediad's RTP timeout already
	// reaps a far end that vanished without a BYE; required in front of a carrier that offers
	// `Supported: timer`.
	EnableSessionTimers bool
	SessionExpires      time.Duration
	MinSE               time.Duration

	// MaxContactsPerAOR caps simultaneous registrations for one address of record and is the
	// enforcement point for the `extension.maxRegistrations` column. SIPD_MAX_CONTACTS, default 5;
	// an unbounded contact set is a fork that rings every stale binding.
	MaxContactsPerAOR int

	// TrunkACL is an override on the carrier-facing source-address allow list, as `cidr[=trunkId]`
	// entries separated by commas. SIPD_TRUNK_ACL, normally empty.
	//
	// The source of truth is the `sip-acl` KV bucket, watched by internal/acl rather than read per
	// INVITE: a KV get per INVITE is a broker round trip inside a SIP transaction, on the one code
	// path whose rate an attacker controls. This override is merged on top of every bucket update
	// and never removed by one, so it still admits a carrier when the control plane cannot write the
	// bucket.
	//
	// Empty is the normal state and does not disable the external profile, which is built whenever
	// the bucket is reachable (Match has no default allow, so an empty ACL still refuses everyone).
	// A value that is set and names nothing usable is a boot failure: a typo in an anti-toll-fraud
	// boundary must not silently do nothing.
	TrunkACL string
	// ExternalListenAddr is where the carrier-facing profile listens, when a TrunkACL is configured.
	// SIPD_EXTERNAL_LISTEN_ADDR, default empty, meaning the external profile shares the main
	// listeners and is selected by source address.
	ExternalListenAddr string

	// Realm is the digest realm this edge challenges with when a request names NO domain — a
	// "no tenant matched" default and not a tenant's realm. A request that names one (the To host on
	// a REGISTER, the From host otherwise) is challenged and looked up under THAT domain, so one
	// process serves many tenants; see registrar.Authenticator.ForRequest. SIPD_REALM.
	//
	// It is part of HA1 = MD5(username:realm:password), so changing it invalidates every stored
	// credential. There is no default: a shared realm would make a credential from one deployment
	// replayable against another.
	Realm string

	// NATSURL is the backbone. NATS_URL, default nats://127.0.0.1:4222.
	NATSURL string

	// NATSUser and NATSPass authenticate to it. NATS_SIPD_USER / NATS_SIPD_PASS, falling back to
	// the unprefixed NATS_USER / NATS_PASS.
	//
	// The prefixed pair is this process's least-privilege identity in config/nats.conf: the `sipd`
	// user may publish `sip.reg.v1.>`, request `rpc.sip.v1.credential` and use the `registrations`
	// bucket, and nothing else. Both empty means a broker with no authentication, which is legal;
	// one of a pair set without the other is not, and is refused rather than silently falling back.
	//
	// They are options rather than userinfo in NATSURL because the URL is logged.
	NATSUser string
	NATSPass string

	// NATSTLSCA is the path to a PEM bundle the broker's certificate must chain to. NATS_TLS_CA.
	// Empty is plaintext unless NATSTLSEnabled says otherwise: the shipped broker listens without
	// TLS, so demanding it by default would break every checkout without generated certificates.
	NATSTLSCA string

	// NATSTLSEnabled turns on TLS against the SYSTEM trust store. NATS_TLS_ENABLED. Setting
	// NATSTLSCA implies it; the two names exist because a private CA and a public issuer are
	// genuinely different configurations.
	NATSTLSEnabled bool

	// Expiry policy, in seconds on the wire.
	//   SIPD_MIN_EXPIRES     default 60   — below this a REGISTER gets 423 Interval Too Brief
	//   SIPD_MAX_EXPIRES     default 3600 — above this the grant is silently clamped down
	//   SIPD_DEFAULT_EXPIRES default 300  — used when the REGISTER states no interval at all
	MinExpires     time.Duration
	MaxExpires     time.Duration
	DefaultExpires time.Duration

	// Subscription expiry policy, in seconds on the wire. It governs SUBSCRIBE (BLF and MWI), not
	// REGISTER.
	//
	//   SIPD_SUBSCRIBE_MIN_EXPIRES     default 60  — below this a SUBSCRIBE gets 423
	//   SIPD_SUBSCRIBE_MAX_EXPIRES     default 600 — above this the grant is silently clamped down
	//   SIPD_SUBSCRIBE_DEFAULT_EXPIRES default 600 — used when the SUBSCRIBE states no interval
	//
	// The ten-minute ceiling bounds how long a dead instance's subscribers keep stale lamps: the
	// subscription table is instance-local (see internal/subscribe). RFC 6665 §4.2.1 lets the
	// notifier shorten what a phone asked for, so a handset requesting 3600 is granted 600.
	SubscribeMinExpires     time.Duration
	SubscribeMaxExpires     time.Duration
	SubscribeDefaultExpires time.Duration

	// NonceTTL bounds how long a digest challenge stays usable. SIPD_NONCE_TTL, default 60s.
	NonceTTL time.Duration
	// NonceSecret keys the nonce MAC. SIPD_NONCE_SECRET.
	//
	// Empty generates a random one at boot, which is correct for a single instance and wrong for a
	// fleet: a device challenged by instance A would be rejected by instance B. Set it (32+ random
	// bytes, same value fleet-wide) in any deployment with more than one replica.
	NonceSecret string

	// Credential-spray lockout. The rate at which a source may guess a SIP password, enforced in
	// internal/registrar and shared by REGISTER and INVITE.
	//
	//   SIPD_AUTH_LOCKOUT_THRESHOLD        default 5   — failures on one (source, account) pair
	//   SIPD_AUTH_LOCKOUT_SOURCE_THRESHOLD default 50  — failures from one source, any account; 0 off
	//   SIPD_AUTH_LOCKOUT_BASE             default 30s — first lockout, doubling on each subsequent
	//   SIPD_AUTH_LOCKOUT_MAX              default 30m — the ceiling on that doubling
	//   SIPD_AUTH_LOCKOUT_WINDOW           default 15m — idle time after which a counter is forgotten
	//
	// A threshold of 0 disables the mechanism entirely, which is a deliberate choice and not a
	// default: without it a spray costs one credential RPC per packet.
	AuthLockout registrar.LockoutPolicy

	// SweepInterval is how often the expiry sweeper runs. SIPD_SWEEP_INTERVAL, default 5s. It bounds
	// how late an `expired` event can be, not how long a binding lives.
	SweepInterval time.Duration

	// CredentialSource and CredentialsFile pick and configure the credential store.
	// SIPD_CREDENTIAL_SOURCE (file|nats, default file), SIPD_CREDENTIALS_FILE.
	CredentialSource CredentialSource
	CredentialsFile  string

	// CredentialTimeout bounds one `rpc.sip.v1.credential` request.
	// SIPD_CREDENTIAL_TIMEOUT, default 500ms — the contract's own deadline.
	//
	// It sits inside a REGISTER transaction, and a phone's retransmission timer starts at 500ms, so
	// a slower reply is already competing with the retry it caused.
	CredentialTimeout time.Duration

	// CredentialCacheTTL and CredentialNegativeCacheTTL are how long a resolved credential and a
	// definite refusal are reused. SIPD_CREDENTIAL_CACHE_TTL (default 30s),
	// SIPD_CREDENTIAL_NEGATIVE_CACHE_TTL (default 10s).
	//
	// Both are short: a longer positive TTL lets an account disabled minutes ago still register. The
	// negative one stops a username scanner becoming a query per guess. Failures are never cached.
	CredentialCacheTTL         time.Duration
	CredentialNegativeCacheTTL time.Duration

	// CredentialCacheMaxEntries bounds the credential cache.
	// SIPD_CREDENTIAL_CACHE_MAX_ENTRIES, default 10000. An unbounded negative cache keyed on an
	// attacker-supplied username is one map entry per guess.
	CredentialCacheMaxEntries int

	// ProvisionSecretKey is the provisioning root key, and is normally empty.
	// SIPD_PROVISION_SECRET_KEY.
	//
	// Production sipd never derives a password — `rpc.sip.v1.credential` returns a ready-made HA1 —
	// so this key stays on the control plane. It derives every tenant's password, so holding it on
	// the internet-exposed process turns an edge compromise into a total credential compromise.
	//
	// It exists for the file store's derived form, so a development or SIPp-rig fixture can name an
	// (orgId, secretRef) pair instead of a copied literal. See internal/credentials/derive.go.
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
		HealthAddr:         strings.TrimSpace(getenv("SIPD_HEALTH_ADDR")),
		ListenAddr:         stringOr(getenv, "SIPD_LISTEN_ADDR", "0.0.0.0:5060"),
		Realm:              strings.TrimSpace(getenv("SIPD_REALM")),
		NATSURL:            stringOr(getenv, "NATS_URL", "nats://127.0.0.1:4222"),
		NATSTLSCA:          strings.TrimSpace(getenv("NATS_TLS_CA")),
		NonceSecret:        getenv("SIPD_NONCE_SECRET"),
		CredentialsFile:    getenv("SIPD_CREDENTIALS_FILE"),
		ProvisionSecretKey: strings.TrimSpace(getenv("SIPD_PROVISION_SECRET_KEY")),
		UserAgent:          stringOr(getenv, "SIPD_USER_AGENT", "optimiq-sipd"),
		TLSListenAddr:      stringOr(getenv, "SIPD_TLS_LISTEN_ADDR", "0.0.0.0:5061"),
		WSListenAddr:       stringOr(getenv, "SIPD_WS_LISTEN_ADDR", "0.0.0.0:5080"),
		WSSListenAddr:      stringOr(getenv, "SIPD_WSS_LISTEN_ADDR", "0.0.0.0:8089"),
		TLSCertFile:        strings.TrimSpace(getenv("SIPD_TLS_CERT_FILE")),
		TLSKeyFile:         strings.TrimSpace(getenv("SIPD_TLS_KEY_FILE")),
		TLSMinVersion:      stringOr(getenv, "SIPD_TLS_MIN_VERSION", "1.3"),
		TLSClientCAFile:    strings.TrimSpace(getenv("SIPD_TLS_CLIENT_CA_FILE")),
		TrunkTLSCertFile:   strings.TrimSpace(getenv("SIPD_TRUNK_TLS_CERT_FILE")),
		TrunkTLSKeyFile:    strings.TrimSpace(getenv("SIPD_TRUNK_TLS_KEY_FILE")),
		TrunkTLSCAFile:     strings.TrimSpace(getenv("SIPD_TRUNK_TLS_CA_FILE")),
		InstanceID:         strings.TrimSpace(getenv("SIPD_INSTANCE_ID")),
		TrunkACL:           strings.TrimSpace(getenv("SIPD_TRUNK_ACL")),
		ExternalListenAddr: strings.TrimSpace(getenv("SIPD_EXTERNAL_LISTEN_ADDR")),
	}
	if cfg.InstanceID == "" {
		// The hostname is the pod name in the deployments this repository targets, which is the
		// granularity a per-instance command subject needs.
		if hostname, err := os.Hostname(); err == nil {
			cfg.InstanceID = hostname
		} else {
			cfg.InstanceID = "sipd"
		}
	}

	// The per-service pair first, the shared pair as the fallback. Collected into `problems` so a
	// half-set pair is reported alongside every other configuration error.
	cfg.NATSUser, cfg.NATSPass, problems = resolveNATSCredentials(getenv, "SIPD", problems)

	var err error
	if cfg.NATSTLSEnabled, err = boolOr(getenv, "NATS_TLS_ENABLED", false); err != nil {
		fail("%v", err)
	}
	if cfg.EnableUDP, err = boolOr(getenv, "SIPD_UDP", true); err != nil {
		fail("%v", err)
	}
	if cfg.EnableTCP, err = boolOr(getenv, "SIPD_TCP", true); err != nil {
		fail("%v", err)
	}
	if cfg.EnableTLS, err = boolOr(getenv, "SIPD_TLS", false); err != nil {
		fail("%v", err)
	}
	if cfg.EnableWS, err = boolOr(getenv, "SIPD_WS", false); err != nil {
		fail("%v", err)
	}
	if cfg.TLSRequireClientCert, err = boolOr(getenv, "SIPD_TLS_REQUIRE_CLIENT_CERT", false); err != nil {
		fail("%v", err)
	}
	if cfg.TLSReloadInterval, err = durationOr(getenv, "SIPD_TLS_RELOAD_INTERVAL", 30*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.EnableWSS, err = boolOr(getenv, "SIPD_WSS", false); err != nil {
		fail("%v", err)
	}
	if cfg.EnableInvite, err = boolOr(getenv, "SIPD_INVITE", false); err != nil {
		fail("%v", err)
	}
	if cfg.EnableSessionTimers, err = boolOr(getenv, "SIPD_SESSION_TIMERS", false); err != nil {
		fail("%v", err)
	}
	if cfg.SessionExpires, err = secondsOr(getenv, "SIPD_SESSION_EXPIRES", 1800); err != nil {
		fail("%v", err)
	}
	if cfg.MinSE, err = secondsOr(getenv, "SIPD_MIN_SE", 90); err != nil {
		fail("%v", err)
	}
	if cfg.PublishAsyncMaxPending, err = intOr(getenv, "SIPD_PUBLISH_ASYNC_MAX_PENDING", 4096); err != nil {
		fail("%v", err)
	}
	if cfg.PublishAsyncMaxPending < 1 {
		fail("SIPD_PUBLISH_ASYNC_MAX_PENDING must be at least 1")
	}
	if cfg.PublishAsyncTimeout, err = durationOr(getenv, "SIPD_PUBLISH_ASYNC_TIMEOUT", 30*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.PublishAsyncTimeout <= 0 {
		fail("SIPD_PUBLISH_ASYNC_TIMEOUT must be positive")
	}
	if cfg.SocketBufferBytes, err = intOr(getenv, "SIPD_SOCKET_BUFFER_BYTES", 4<<20); err != nil {
		fail("%v", err)
	}
	if cfg.SocketBufferBytes < 0 {
		fail("SIPD_SOCKET_BUFFER_BYTES must not be negative")
	}
	if cfg.PProfEnabled, err = boolOr(getenv, "SIPD_PPROF", false); err != nil {
		fail("%v", err)
	}
	if strings.TrimSpace(getenv("SIPD_PPROF_ADDR")) != "" {
		// Refused rather than ignored: pprof moved onto the health listener, and silently dropping
		// the old variable would leave an operator profiling a port nothing is listening on.
		fail("SIPD_PPROF_ADDR is no longer used; set SIPD_PPROF=1 and point SIPD_HEALTH_ADDR at a loopback address")
	}
	if cfg.PProfEnabled {
		if cfg.HealthAddr == "" {
			fail("SIPD_PPROF needs SIPD_HEALTH_ADDR: pprof is served on the health listener")
		} else if err := requireLoopback(cfg.HealthAddr); err != nil {
			fail("SIPD_PPROF requires a loopback SIPD_HEALTH_ADDR: %v", err)
		}
	}
	if cfg.MaxContactsPerAOR, err = intOr(getenv, "SIPD_MAX_CONTACTS", 5); err != nil {
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
	if cfg.SubscribeMinExpires, err = secondsOr(getenv, "SIPD_SUBSCRIBE_MIN_EXPIRES", 60); err != nil {
		fail("%v", err)
	}
	if cfg.SubscribeMaxExpires, err = secondsOr(getenv, "SIPD_SUBSCRIBE_MAX_EXPIRES", 600); err != nil {
		fail("%v", err)
	}
	if cfg.SubscribeDefaultExpires, err = secondsOr(getenv, "SIPD_SUBSCRIBE_DEFAULT_EXPIRES", 600); err != nil {
		fail("%v", err)
	}
	if cfg.NonceTTL, err = durationOr(getenv, "SIPD_NONCE_TTL", time.Minute); err != nil {
		fail("%v", err)
	}
	if cfg.SweepInterval, err = durationOr(getenv, "SIPD_SWEEP_INTERVAL", 5*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.AuthLockout.Threshold, err = intOr(getenv, "SIPD_AUTH_LOCKOUT_THRESHOLD", 5); err != nil {
		fail("%v", err)
	}
	if cfg.AuthLockout.SourceThreshold, err = intOr(getenv, "SIPD_AUTH_LOCKOUT_SOURCE_THRESHOLD", 50); err != nil {
		fail("%v", err)
	}
	if cfg.AuthLockout.Base, err = durationOr(getenv, "SIPD_AUTH_LOCKOUT_BASE", 30*time.Second); err != nil {
		fail("%v", err)
	}
	if cfg.AuthLockout.Max, err = durationOr(getenv, "SIPD_AUTH_LOCKOUT_MAX", 30*time.Minute); err != nil {
		fail("%v", err)
	}
	if cfg.AuthLockout.Window, err = durationOr(getenv, "SIPD_AUTH_LOCKOUT_WINDOW", 15*time.Minute); err != nil {
		fail("%v", err)
	}
	cfg.AuthLockout.MaxTracked = registrar.DefaultLockoutPolicy().MaxTracked
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
	if !cfg.EnableUDP && !cfg.EnableTCP && !cfg.EnableTLS && !cfg.EnableWS && !cfg.EnableWSS {
		fail("every listener is disabled: sipd would accept no traffic at all")
	}
	// A certificate is required for exactly the transports that terminate TLS, and refused for the
	// ones that do not: a deployment that set a cert and forgot to enable TLS believes it is
	// encrypted and is not.
	if (cfg.EnableTLS || cfg.EnableWSS) && (cfg.TLSCertFile == "" || cfg.TLSKeyFile == "") {
		fail("SIPD_TLS_CERT_FILE and SIPD_TLS_KEY_FILE are both required when SIPD_TLS or SIPD_WSS is on")
	}
	if !cfg.EnableTLS && !cfg.EnableWSS && (cfg.TLSCertFile != "" || cfg.TLSKeyFile != "") {
		fail("SIPD_TLS_CERT_FILE/SIPD_TLS_KEY_FILE are set but neither SIPD_TLS nor SIPD_WSS is on: " +
			"this deployment is plaintext and believes it is not")
	}
	if version := strings.TrimSpace(cfg.TLSMinVersion); version != "1.3" && version != "1.2" {
		fail("SIPD_TLS_MIN_VERSION must be 1.3 or 1.2, got %q", cfg.TLSMinVersion)
	}
	if cfg.TLSReloadInterval < 0 {
		fail("SIPD_TLS_RELOAD_INTERVAL must not be negative")
	}
	// The client CA is the mutual-TLS half, so it only means anything on a listener that terminates
	// TLS. Requiring a client certificate without one to verify it against would refuse every peer.
	if cfg.TLSClientCAFile != "" && !cfg.EnableTLS && !cfg.EnableWSS {
		fail("SIPD_TLS_CLIENT_CA_FILE is set but neither SIPD_TLS nor SIPD_WSS is on")
	}
	if cfg.TLSRequireClientCert && cfg.TLSClientCAFile == "" {
		fail("SIPD_TLS_REQUIRE_CLIENT_CERT needs SIPD_TLS_CLIENT_CA_FILE: there would be nothing to verify against")
	}
	if (cfg.TrunkTLSCertFile == "") != (cfg.TrunkTLSKeyFile == "") {
		fail("SIPD_TRUNK_TLS_CERT_FILE and SIPD_TRUNK_TLS_KEY_FILE must be set together")
	}
	// Two listeners on one address is a bind failure at best and a silent race at worst.
	if duplicate, found := duplicateListener(cfg); found {
		fail("two listeners are configured on %s: one socket cannot serve two transports", duplicate)
	}
	if cfg.MaxContactsPerAOR <= 0 {
		fail("SIPD_MAX_CONTACTS must be positive: zero would refuse every registration")
	}
	if cfg.MaxContactsPerAOR > 20 {
		fail("SIPD_MAX_CONTACTS must not exceed the contract limit of 20")
	}
	if cfg.EnableSessionTimers {
		if cfg.MinSE < 90*time.Second {
			fail("SIPD_MIN_SE must be at least 90 seconds (RFC 4028 §4 sets that floor), got %s", cfg.MinSE)
		}
		if cfg.SessionExpires < cfg.MinSE {
			fail("SIPD_SESSION_EXPIRES (%s) must not be below SIPD_MIN_SE (%s)",
				cfg.SessionExpires, cfg.MinSE)
		}
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
	if cfg.SubscribeMinExpires <= 0 {
		fail("SIPD_SUBSCRIBE_MIN_EXPIRES must be positive")
	}
	if cfg.SubscribeMinExpires > cfg.SubscribeMaxExpires {
		fail("SIPD_SUBSCRIBE_MIN_EXPIRES (%s) must not exceed SIPD_SUBSCRIBE_MAX_EXPIRES (%s)",
			cfg.SubscribeMinExpires, cfg.SubscribeMaxExpires)
	}
	if cfg.SubscribeDefaultExpires < cfg.SubscribeMinExpires ||
		cfg.SubscribeDefaultExpires > cfg.SubscribeMaxExpires {
		fail("SIPD_SUBSCRIBE_DEFAULT_EXPIRES (%s) must lie within [%s, %s]",
			cfg.SubscribeDefaultExpires, cfg.SubscribeMinExpires, cfg.SubscribeMaxExpires)
	}
	if cfg.SweepInterval <= 0 {
		fail("SIPD_SWEEP_INTERVAL must be positive")
	}
	if cfg.NonceTTL <= 0 {
		fail("SIPD_NONCE_TTL must be positive")
	}
	if cfg.AuthLockout.Threshold < 0 {
		fail("SIPD_AUTH_LOCKOUT_THRESHOLD must not be negative; 0 disables the lockout")
	}
	if cfg.AuthLockout.SourceThreshold < 0 {
		fail("SIPD_AUTH_LOCKOUT_SOURCE_THRESHOLD must not be negative; 0 disables the source cap")
	}
	if cfg.AuthLockout.Threshold > 0 {
		if cfg.AuthLockout.Base <= 0 {
			fail("SIPD_AUTH_LOCKOUT_BASE must be positive")
		}
		if cfg.AuthLockout.Max < cfg.AuthLockout.Base {
			fail("SIPD_AUTH_LOCKOUT_MAX (%s) must not be shorter than SIPD_AUTH_LOCKOUT_BASE (%s)",
				cfg.AuthLockout.Max, cfg.AuthLockout.Base)
		}
		if cfg.AuthLockout.Window <= 0 {
			fail("SIPD_AUTH_LOCKOUT_WINDOW must be positive")
		}
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("%w:\n  - %s", ErrInvalid,
			strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// duplicateListener reports the first bind address claimed by two enabled transports.
//
// It is a boot check because the runtime symptom is one listener binding, the other failing in a
// goroutine nobody watches, and phones unable to reach the transport they were provisioned for.
//
// The collision is between sockets of the same family, not between transports: UDP and TCP
// legitimately share one address, which is why they have one SIPD_LISTEN_ADDR between them, but
// TCP, TLS, WS and WSS all bind a stream socket.
func duplicateListener(cfg Config) (string, bool) {
	claimed := make(map[string]string, 5)
	for _, listener := range [5]struct {
		enabled bool
		name    string
		family  string
		addr    string
	}{
		{cfg.EnableUDP, "SIPD_UDP", "udp", cfg.ListenAddr},
		{cfg.EnableTCP, "SIPD_TCP", "tcp", cfg.ListenAddr},
		{cfg.EnableTLS, "SIPD_TLS", "tcp", cfg.TLSListenAddr},
		{cfg.EnableWS, "SIPD_WS", "tcp", cfg.WSListenAddr},
		{cfg.EnableWSS, "SIPD_WSS", "tcp", cfg.WSSListenAddr},
	} {
		if !listener.enabled {
			continue
		}
		key := listener.family + "/" + listener.addr
		if previous, taken := claimed[key]; taken {
			return listener.addr + " (" + previous + " and " + listener.name + ")", true
		}
		claimed[key] = listener.name
	}
	return "", false
}

// ErrInvalid marks a configuration problem, for callers that want to branch on it.
var ErrInvalid = errors.New("invalid sipd configuration")

// resolveNATSCredentials reads the broker identity, preferring this service's own.
//
// `NATS_<SERVICE>_USER` / `NATS_<SERVICE>_PASS` win when both are set; otherwise the shared
// `NATS_USER` / `NATS_PASS` are used. Both absent is a broker with no authentication, which is legal.
//
// A half-set pair is refused per pair rather than ignored: falling back from a half-set
// `NATS_SIPD_*` to the shared pair would hand this process the operator identity and hide the typo
// behind a working connection. Problems are collected so one startup message carries them all.
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
// environment does too ("300" rather than "5m"), matching what a packet capture shows.
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

// requireLoopback refuses an address that is not explicitly on a loopback host. The pprof handlers
// dump heap and goroutine stacks, which on a SIP edge includes credentials in flight, so a wildcard
// or external address is a configuration error rather than an operator's choice.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%q is not a host:port address: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("%q binds every interface; name 127.0.0.1 or ::1", addr)
	}
	address, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return fmt.Errorf("%q is not an IP address; name 127.0.0.1 or ::1", host)
	}
	if !address.IsLoopback() {
		return fmt.Errorf("%q is not a loopback address; pprof must not be reachable off-host", host)
	}
	return nil
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
