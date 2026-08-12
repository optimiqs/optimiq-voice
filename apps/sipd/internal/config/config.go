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

	// TLS, WS and WSS listeners. SIPD_TLS / SIPD_WS / SIPD_WSS, all default false, each with its
	// own bind address so a deployment can put the secure transports on their conventional ports
	// (5061 for TLS, 8089 for WSS) without moving the plaintext ones.
	//
	// # Why WS and WSS are here at all
	//
	// A browser cannot open a UDP or TCP socket. SIP over WebSocket (RFC 7118) is the ONLY transport
	// a WebRTC softphone has, and parity-audit row 1.28 records that neither plane serves one today
	// — which blocks the T3 softphone entirely. sipgo serves both (`Server.ServeWS`/`ServeWSS`, and
	// `ListenAndServe` accepts "ws" and "wss" as network names), so this is wiring rather than
	// implementation.
	//
	// # What a WSS listener does NOT deliver
	//
	// Audio. SDP stays vanilla here: a WebRTC endpoint needs DTLS-SRTP, and apps/mediad has no SRTP
	// — plans/mediad-design.md §1 declined pion/webrtc deliberately and left "a separate ingress in
	// front of the same session model" as an argument nobody has had yet. So WSS delivers
	// SIGNALLING for a browser client and no media, and saying so is better than shipping half a
	// feature quietly.
	EnableTLS bool
	EnableWS  bool
	EnableWSS bool
	// TLSListenAddr, WSListenAddr and WSSListenAddr are the bind addresses for those three.
	TLSListenAddr string
	WSListenAddr  string
	WSSListenAddr string
	// TLSCertFile and TLSKeyFile are the PEM certificate and key both TLS and WSS present. One pair
	// for both: a deployment that needs different certificates for 5061 and 8089 needs two
	// processes, and pretending otherwise would put certificate selection into a config file that
	// cannot express SNI.
	TLSCertFile string
	TLSKeyFile  string

	// EnableInvite turns on the INVITE surface: the dialog layer, the admission RPC, the engine's
	// five-subject command surface, the trunk directory, the `sip-acl` watch and the claim reaper.
	// SIPD_INVITE, default FALSE.
	//
	// Still off by default, and the REASON has changed rather than gone away. It is no longer "no
	// engine serves `rpc.sip.v1.invite`" — one does. It is that turning this on converts a registrar
	// into a call-processing element, and that has a blast radius nobody should acquire by upgrading
	// a binary: the front end must become dialog-affine (a mid-dialog request that lands on the wrong
	// instance is answered 481, design §6.4), the `trunks` and `sip-acl` buckets must be written by
	// apps/api, and this process starts subscribing to business subjects for the first time. Turning
	// it on is a deliberate act by a deployment that has all of that.
	EnableInvite bool
	// InstanceID is this process's identity on the backbone: it stamps every `sip-dialogs` claim and
	// is the token engine commands for these dialogs are addressed at. SIPD_INSTANCE_ID, defaulting
	// to the hostname, because a dialog lives on one process and a command for it must reach that
	// one.
	InstanceID string

	// Session timers (RFC 4028). SIPD_SESSION_TIMERS (default false), SIPD_SESSION_EXPIRES (1800)
	// and SIPD_MIN_SE (90, the RFC's own floor).
	//
	// Off by default because a one-sided timer is worse than none and because mediad's RTP timeout
	// already reaps a far end that vanished without a BYE. They become mandatory in front of a
	// carrier that offers `Supported: timer`, which will tear the call down itself if it never sees
	// a refresh.
	EnableSessionTimers bool
	SessionExpires      time.Duration
	MinSE               time.Duration

	// MaxContactsPerAOR caps simultaneous registrations for one address of record.
	// SIPD_MAX_CONTACTS, default 5.
	//
	// It is the `extension.maxRegistrations` column's enforcement point. Five rather than one
	// because a desk phone plus a softphone plus a mobile client is an ordinary user, and rather
	// than unlimited because an unbounded contact set is a fork that rings twenty stale bindings.
	MaxContactsPerAOR int

	// TrunkACL is an OVERRIDE on the carrier-facing source-address allow list, as `cidr[=trunkId]`
	// entries separated by commas. SIPD_TRUNK_ACL, empty by default and expected to stay empty.
	//
	// # It is no longer the source, and it was deliberately not removed
	//
	// The source is the `sip-acl` KV bucket (design §8.1): organization-scoped in PostgreSQL, written
	// non-org-scoped by apps/api because the reader does not know the tenant, and WATCHED here rather
	// than read per INVITE — a KV get per INVITE is a broker round trip inside a SIP transaction on
	// the one code path an attacker controls the rate of. internal/acl is the ingestion.
	//
	// Deleting this variable outright was the tidier change and it loses on two situations that are
	// both real. A deployment whose control plane cannot yet write the bucket has no other way to
	// admit a carrier; and an operator who needs one address admitted RIGHT NOW during an incident
	// cannot wait for a database write to propagate through apps/api. So it survives as an override
	// that is recompiled alongside every bucket update and is never removed by one — which is what
	// makes the second case trustworthy rather than a race.
	//
	// Empty is now the NORMAL state and no longer means "no external profile". The profile is built
	// whenever the bucket is reachable, because an external profile whose ACL is empty refuses every
	// carrier — Match has no default allow and no constructor can give it one — so building it early
	// costs nothing and saves a restart the first time a tenant adds a trunk. A value that is SET and
	// names nothing usable is still a boot failure: that is a typo, and a typo in an anti-toll-fraud
	// boundary that silently did nothing is exactly what this check exists for.
	TrunkACL string
	// ExternalListenAddr is where the carrier-facing profile listens, when a TrunkACL is configured.
	// SIPD_EXTERNAL_LISTEN_ADDR, default empty, meaning the external profile shares the main
	// listeners and is selected by source address.
	ExternalListenAddr string

	// Realm is the digest authentication realm presented in every challenge. SIPD_REALM.
	//
	// It is part of HA1 = MD5(username:realm:password), so changing it invalidates every stored
	// credential. There is no default: guessing one would make every deployment share a realm and
	// therefore make a credential from one deployment replayable against another.
	Realm string

	// NATSURL is the backbone. NATS_URL, default nats://127.0.0.1:4222.
	NATSURL string

	// NATSUser and NATSPass authenticate to it. NATS_SIPD_USER / NATS_SIPD_PASS, falling back to
	// the unprefixed NATS_USER / NATS_PASS.
	//
	// The broker requires authentication (config/nats.conf), and the prefixed pair is this
	// process's OWN identity there. The `sipd` user may publish `sip.reg.v1.>`, request
	// `rpc.sip.v1.credential` and use the `registrations` KV bucket; it subscribes to no business
	// subject at all, because sipd's request surface is SIP rather than NATS. It cannot write a
	// CDR leg, cannot read the dial plan and cannot see another plane's events — which is the
	// point, for the process that terminates SIP from the internet.
	//
	// The unprefixed fallback is what keeps a deployment that has not split its credentials
	// working unchanged.
	//
	// Both empty is legal and means "a broker with no authentication configured" — the SIPp rig and
	// the integration tests start one of those per run. One set without the other is NOT legal,
	// PER PAIR: it is a rename applied to half a pair, and the broker would answer every connect
	// with an authorization violation that this process would spend its life retrying.
	//
	// They are options rather than userinfo in NATSURL because the URL is logged: the boot line,
	// every reconnect and the connect error itself all carry it.
	NATSUser string
	NATSPass string

	// NATSTLSCA is the path to a PEM bundle the broker's certificate must chain to. NATS_TLS_CA.
	// Empty is PLAINTEXT unless NATSTLSEnabled says otherwise — the shipped broker listens without
	// TLS and its `tls` block lives in the `compose.tls.yaml` overlay, so a client that demanded
	// TLS by default would fail to connect on every checkout that has not generated certificates.
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
	// REGISTER, and the numbers are deliberately different from the registration ones.
	//
	//   SIPD_SUBSCRIBE_MIN_EXPIRES     default 60  — below this a SUBSCRIBE gets 423
	//   SIPD_SUBSCRIBE_MAX_EXPIRES     default 600 — above this the grant is silently clamped down
	//   SIPD_SUBSCRIBE_DEFAULT_EXPIRES default 600 — used when the SUBSCRIBE states no interval
	//
	// Ten minutes rather than an hour, and that ceiling is the load-bearing one. The subscription
	// table is instance-local (see internal/subscribe), so if an instance dies its subscribers'
	// lamps freeze until they re-subscribe — and this is what bounds that window. RFC 6665 §4.2.1
	// lets the notifier shorten what a phone asked for, so a handset requesting 3600 is simply
	// granted 600 and refreshes six times as often. The cost is one SUBSCRIBE per phone per ten
	// minutes; the alternative is a BLF wall that can be an hour stale after a pod is rescheduled.
	SubscribeMinExpires     time.Duration
	SubscribeMaxExpires     time.Duration
	SubscribeDefaultExpires time.Duration

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
		InstanceID:         strings.TrimSpace(getenv("SIPD_INSTANCE_ID")),
		TrunkACL:           strings.TrimSpace(getenv("SIPD_TRUNK_ACL")),
		ExternalListenAddr: strings.TrimSpace(getenv("SIPD_EXTERNAL_LISTEN_ADDR")),
	}
	if cfg.InstanceID == "" {
		// The hostname, because in every deployment this repository targets that is the pod name,
		// which is exactly the granularity a per-instance command subject needs. A random id would
		// work too and would make a restarted pod unaddressable by anything that cached the old one.
		if hostname, err := os.Hostname(); err == nil {
			cfg.InstanceID = hostname
		} else {
			cfg.InstanceID = "sipd"
		}
	}

	// The per-service pair first, the shared pair as the fallback. Collected into `problems` so a
	// half-set pair is reported alongside every other configuration error rather than on its own.
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
	// ones that do not — a deployment that set a cert and forgot to enable TLS is one that believes
	// it is encrypted and is not, which is the failure worth failing the boot for.
	if (cfg.EnableTLS || cfg.EnableWSS) && (cfg.TLSCertFile == "" || cfg.TLSKeyFile == "") {
		fail("SIPD_TLS_CERT_FILE and SIPD_TLS_KEY_FILE are both required when SIPD_TLS or SIPD_WSS is on")
	}
	if !cfg.EnableTLS && !cfg.EnableWSS && (cfg.TLSCertFile != "" || cfg.TLSKeyFile != "") {
		fail("SIPD_TLS_CERT_FILE/SIPD_TLS_KEY_FILE are set but neither SIPD_TLS nor SIPD_WSS is on: " +
			"this deployment is plaintext and believes it is not")
	}
	// Two listeners on one address is a bind failure at best and a silent race at worst.
	if duplicate, found := duplicateListener(cfg); found {
		fail("two listeners are configured on %s: one socket cannot serve two transports", duplicate)
	}
	if cfg.MaxContactsPerAOR <= 0 {
		fail("SIPD_MAX_CONTACTS must be positive: zero would refuse every registration")
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

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("sipd configuration is invalid:\n  - %s",
			strings.Join(problems, "\n  - "))
	}
	return cfg, nil
}

// duplicateListener reports the first bind address claimed by two enabled transports.
//
// It is a boot check rather than a runtime one because the runtime symptom is miserable: one
// listener binds, the other fails, the error is logged by a goroutine nobody is watching, and half
// the fleet's phones cannot reach the transport they were provisioned for.
func duplicateListener(cfg Config) (string, bool) {
	claimed := make(map[string]string, 5)
	for _, listener := range [5]struct {
		enabled bool
		name    string
		addr    string
	}{
		{cfg.EnableUDP, "SIPD_UDP", cfg.ListenAddr},
		{cfg.EnableTCP, "SIPD_TCP", cfg.ListenAddr},
		{cfg.EnableTLS, "SIPD_TLS", cfg.TLSListenAddr},
		{cfg.EnableWS, "SIPD_WS", cfg.WSListenAddr},
		{cfg.EnableWSS, "SIPD_WSS", cfg.WSSListenAddr},
	} {
		if !listener.enabled {
			continue
		}
		// UDP and TCP legitimately share one address: they are different sockets on different
		// protocols, which is why they have one SIPD_LISTEN_ADDR between them.
		if listener.name == "SIPD_TCP" {
			continue
		}
		if previous, taken := claimed[listener.addr]; taken {
			return listener.addr + " (" + previous + " and " + listener.name + ")", true
		}
		claimed[listener.addr] = listener.name
	}
	return "", false
}

// ErrInvalid marks a configuration problem, for callers that want to branch on it.
var ErrInvalid = errors.New("invalid sipd configuration")

// resolveNATSCredentials reads the broker identity, preferring this service's own.
//
// `NATS_<SERVICE>_USER` / `NATS_<SERVICE>_PASS` win when BOTH are set — that is the least-privilege
// user `config/nats.conf` defines for this process. Otherwise the shared `NATS_USER` / `NATS_PASS`
// are used, which is what a deployment that has not split its credentials, the SIPp rig and the
// integration tests still supply. Both absent is a broker with no authentication, which is legal.
//
// A HALF-SET pair is refused PER PAIR, and refused rather than ignored: falling back from a
// half-set `NATS_SIPD_*` to the shared pair would hand this process the operator identity and hide
// the typo behind a working connection, which is the failure this check exists to prevent. It is
// collected into `problems` rather than returned so one startup message carries every
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
