package events

import "time"

// JetStream stream and KV bucket definitions — the Go mirror of packages/events/src/streams.ts.
//
// Everything here is plain data: it can be asserted in a test, diffed in review, and handed to
// nats.go without this package importing a client. Durations are time.Duration (the TypeScript
// definitions carry the same values in milliseconds; the parity test checks both ends agree).
//
// # Why discard-new on CDR and AUDIT
//
// Every other stream is a live-state feed: if it overflows, dropping the oldest event is correct
// because a newer one supersedes it. CDR and AUDIT are ledgers — billing and compliance. A silent
// discard-old there would delete revenue and audit history under load, so those two refuse the
// WRITE instead: the publisher gets an error it can retry, alert and page on.

// RetentionPolicy is a JetStream retention policy name.
type RetentionPolicy string

// JetStream retention policies.
const (
	RetentionLimits    RetentionPolicy = "limits"
	RetentionInterest  RetentionPolicy = "interest"
	RetentionWorkQueue RetentionPolicy = "workqueue"
)

// StorageType is a JetStream storage backend name.
type StorageType string

// JetStream storage backends.
const (
	StorageFile   StorageType = "file"
	StorageMemory StorageType = "memory"
)

// DiscardPolicy says what a full stream does with the next message.
type DiscardPolicy string

// JetStream discard policies.
const (
	// DiscardOld drops the oldest message to make room. Correct for live-state feeds.
	DiscardOld DiscardPolicy = "old"
	// DiscardNew refuses the write. Correct for ledgers, where silent loss is unacceptable.
	DiscardNew DiscardPolicy = "new"
)

// Unlimited is the JetStream sentinel for "no cap" on message and byte counts.
const Unlimited int64 = -1

// StreamDefinition describes one JetStream stream.
type StreamDefinition struct {
	Name        string
	Description string
	Subjects    []string
	Retention   RetentionPolicy
	Storage     StorageType
	Discard     DiscardPolicy
	// MaxAge is 0 for unlimited.
	MaxAge time.Duration
	// MaxMsgs is Unlimited for no cap.
	MaxMsgs int64
	// MaxBytes is Unlimited for no cap.
	MaxBytes int64
	// MaxMsgsPerSubject is Unlimited for no cap. calls.evt.v1.<org>.<call>.<event> is one subject.
	MaxMsgsPerSubject int64
	// DuplicateWindow is the Nats-Msg-Id dedupe horizon: a repeat of the same id inside it is
	// suppressed.
	DuplicateWindow time.Duration
	NumReplicas     int
}

const (
	gib int64 = 1 << 30
	mib int64 = 1 << 20
)

// CallsStream carries the channel/bridge/DTMF/record feed. High volume, short life: it exists so
// the engine can be restarted and rebuilt, and so live-state consumers can catch up. Anything that
// must survive is written to Postgres by a durable consumer.
var CallsStream = StreamDefinition{
	Name:              "CALLS",
	Description:       "Channel lifecycle events per call leg (plan §3.5, §4.2).",
	Subjects:          []string{AllCallsFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            72 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          8 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   2 * time.Minute,
	NumReplicas:       1,
}

// RegistrationsStream carries registrar edge transitions. The TRUTH for "who is registered" is the
// registrations KV bucket; this stream is the audit/notification trail behind it.
var RegistrationsStream = StreamDefinition{
	Name:              "REGISTRATIONS",
	Description:       "SIP registrar register/unregister/expire transitions (plan §3.5).",
	Subjects:          []string{AllRegistrationsFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          1 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   2 * time.Minute,
	NumReplicas:       1,
}

// QueuesStream carries ACD caller/agent events. Kept a week so wallboards and reports can backfill.
var QueuesStream = StreamDefinition{
	Name:              "QUEUES",
	Description:       "Queue caller and agent-state events (plan §3.5).",
	Subjects:          []string{AllQueuesFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            7 * 24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          2 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   2 * time.Minute,
	NumReplicas:       1,
}

// VoicemailStream carries mailbox facts on their way to pbx-db, plus the derived MWI counts.
//
// discard: new for the same reason as CDR and AUDIT: a message.left the broker silently dropped is a
// message a caller recorded and a user will never see, which is indistinguishable from the system
// losing their voicemail — because it is.
var VoicemailStream = StreamDefinition{
	Name:              "VOICEMAIL",
	Description:       "Voicemail message and MWI events consumed durably by the pbx writer (plan §3.5).",
	Subjects:          []string{AllVoicemailFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardNew,
	MaxAge:            30 * 24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          2 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   10 * time.Minute,
	NumReplicas:       1,
}

// MediaStream carries the media plane's RTP session lifecycle from apps/mediad.
//
// discard-old and a short window, unlike CDR: these are live-state facts about calls, not a ledger.
// What they are kept for is the question asked minutes or hours later — "why did that call go
// quiet?" — answered from a session.rtp-timeout and a session.ended reason.
//
// Two days, matching nothing else on purpose: long enough for "it happened on Friday afternoon",
// short enough that a media plane under sustained failure cannot fill a disk with its own
// complaints.
var MediaStream = StreamDefinition{
	Name:              "MEDIA",
	Description:       "Media-plane RTP session lifecycle from apps/mediad (plan §3.4, mediad-design §4).",
	Subjects:          []string{AllMediaFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            48 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          1 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   2 * time.Minute,
	NumReplicas:       1,
}

// CDRStream carries per-leg call records on their way to cdr-db. "Replay = rebuild": the 30-day
// window is how far back the CDR table can be reconstructed from the log alone.
var CDRStream = StreamDefinition{
	Name:              "CDR",
	Description:       "Per-leg CDR writes consumed durably by the cdr-db writer (plan §3.5).",
	Subjects:          []string{AllCDRLegsFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardNew,
	MaxAge:            30 * 24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          16 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   10 * time.Minute,
	NumReplicas:       1,
}

// AuditStream records who changed what. Compliance retention; never discards old messages.
var AuditStream = StreamDefinition{
	Name:              "AUDIT",
	Description:       "Control-plane audit trail (plan §3.5, §5 T1 audit log).",
	Subjects:          []string{AllAuditFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardNew,
	MaxAge:            400 * 24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          16 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   2 * time.Minute,
	NumReplicas:       1,
}

// ProvisionStream records device provisioning attempts; it feeds the security view of the MAC
// endpoint.
var ProvisionStream = StreamDefinition{
	Name:              "PROVISION",
	Description:       "Device provisioning request/render/reject events (plan §3.5, §4.1.7).",
	Subjects:          []string{AllProvisionFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            30 * 24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          1 * gib,
	MaxMsgsPerSubject: Unlimited,
	DuplicateWindow:   2 * time.Minute,
	NumReplicas:       1,
}

// EventStreams lists every stream the backbone owns, in apply order.
var EventStreams = []StreamDefinition{
	CallsStream,
	RegistrationsStream,
	QueuesStream,
	VoicemailStream,
	MediaStream,
	CDRStream,
	AuditStream,
	ProvisionStream,
}

// StreamByName looks a stream definition up by its JetStream name.
func StreamByName(name string) (StreamDefinition, bool) {
	for _, definition := range EventStreams {
		if definition.Name == name {
			return definition, true
		}
	}
	return StreamDefinition{}, false
}

// WithReplicas returns a copy of the definition with a production replica count (1..5).
func (d StreamDefinition) WithReplicas(numReplicas int) StreamDefinition {
	if numReplicas < 1 || numReplicas > 5 {
		panic("numReplicas must be in 1..5")
	}
	d.NumReplicas = numReplicas
	return d
}

// ---------------------------------------------------------------------------------------------
// KV buckets — ephemeral truth
// ---------------------------------------------------------------------------------------------

// KVBucketDefinition describes one JetStream KV bucket. These hold LIVE state, never history: the
// streams above are the replayable log, a bucket is the current value with a TTL that guarantees a
// crashed writer's entries evaporate instead of lying forever.
type KVBucketDefinition struct {
	Name        string
	Description string
	// TTL is the server-side expiry per key. 0 means keys never expire.
	TTL time.Duration
	// History is the number of revisions kept per key. 1 everywhere: these are values, not logs.
	History uint8
	Storage StorageType
	// MaxValueSize caps one entry.
	MaxValueSize int32
	// MaxBytes caps the bucket.
	MaxBytes    int64
	NumReplicas int
}

// RegistrationsKV holds AOR → contact bindings, the location service sipd and the engine read
// before routing to a device.
//
// The TTL is one hour: longer than any sane Expires: header, so a refreshing device never
// disappears, short enough that a dead registrar's rows self-heal. It is a BACKSTOP, not the expiry
// mechanism — the registrar deletes a binding when its granted Expires lapses (see apps/sipd).
var RegistrationsKV = KVBucketDefinition{
	Name:         "registrations",
	Description:  "AOR -> contact bindings (plan §3.5).",
	TTL:          time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 8 * 1024,
	MaxBytes:     256 * mib,
	NumReplicas:  1,
}

// ChannelsKV holds live channel state so another engine instance can take over a drain or a crash.
// TTL 6h covers the longest realistic call; a leaked entry cannot outlive a shift.
var ChannelsKV = KVBucketDefinition{
	Name:         "channels",
	Description:  "Live channel state for engine failover and drain (plan §3.5).",
	TTL:          6 * time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 32 * 1024,
	MaxBytes:     1 * gib,
	NumReplicas:  1,
}

// PresenceKV holds BLF/device state. Pure derived state, refreshed constantly; memory-backed.
var PresenceKV = KVBucketDefinition{
	Name:         "presence",
	Description:  "BLF / device presence aggregation (plan §3.5).",
	TTL:          5 * time.Minute,
	History:      1,
	Storage:      StorageMemory,
	MaxValueSize: 4 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// AgentStateKV holds ACD agent status. Survives a restart (a shift outlives a deploy).
var AgentStateKV = KVBucketDefinition{
	Name:         "agent-state",
	Description:  "ACD agent availability/wrap-up state (plan §3.5).",
	TTL:          12 * time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 4 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// RoutingCacheKV holds compiled routing artifacts keyed for invalidation. The TTL is a backstop
// only: correctness comes from the compiler deleting keys on save, never from expiry.
var RoutingCacheKV = KVBucketDefinition{
	Name:         "routing-cache",
	Description:  "Compiled routing artifacts, invalidated by key on save (plan §3.5, §3.1.3).",
	TTL:          time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: int32(mib),
	MaxBytes:     1 * gib,
	NumReplicas:  1,
}

// DIDIndexKV holds DID → owning organization: THE multi-tenant inbound lookup.
//
// Every other bucket here is keyed by organization first, because every other reader already knows
// the tenant. This one exists precisely because the reader does not — an inbound INVITE arrives from
// a carrier with a dialled number and no idea whose it is — so its key is the DID alone.
//
// The TTL is zero on purpose. Every other bucket holds live state whose staleness self-corrects;
// this holds CONFIGURATION, and an expiring entry means an inbound call to a valid DID stops
// resolving to a tenant — an outage produced by a timer rather than by a change.
//
// It is not the authority on who owns a DID (phone_number in pbx-db is); it is a derived read model,
// rebuildable from the database at any time.
var DIDIndexKV = KVBucketDefinition{
	Name:         "did-index",
	Description:  "DID (E.164 digits) -> owning organization, for inbound tenant attribution.",
	TTL:          0,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 4 * 1024,
	MaxBytes:     256 * mib,
	NumReplicas:  1,
}

// QueueMembershipKV holds queue → its ordered tiers, and how to dial each agent in them.
//
// A queue node in the routing artifact carries the queue's routing configuration and no agents,
// deliberately: tiers change when a supervisor moves somebody between queues, which is not a routing
// change and must not force a recompile. The engine still needs the roster at call time from a
// process that holds no pbx-db handle, so this is the derived read model — written by apps/api
// inside the unit of work that changes a tier, read and watched by apps/engine.
//
// The TTL is zero for the same reason DIDIndexKV's is: this is configuration, not live state. An
// expiring entry means a queue that suddenly has no agents and ejects every caller to its timeout
// branch. Agent AVAILABILITY is the live half and lives in AgentStateKV, which does have a TTL,
// because a stale "available" self-corrects and a stale roster does not.
var QueueMembershipKV = KVBucketDefinition{
	Name:         "queue-membership",
	Description:  "Queue -> ordered tiers with agent dial strings, for ACD distribution.",
	TTL:          0,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 128 * 1024,
	MaxBytes:     256 * mib,
	NumReplicas:  1,
}

// ParkClaimsKV holds which engine instance owns which orbit slot.
//
// The invariant it exists for: two calls can never occupy one orbit. A colleague told "she is on
// 401" must reach exactly that caller. An in-process map holds that within one engine and says
// nothing across two, so a second instance behind the same media server hands out 401 again. The
// claim is therefore taken here, with the KV create that fails when the key already exists, before
// any media moves — a failed create is the other instance winning, not an error to retry blindly.
//
// The TTL is a backstop; the record's own expiresAt is what a reaper reads, because server-side
// expiry cannot distinguish "the owner stopped heartbeating" from "written a while ago and still
// correct". Fifteen minutes is far longer than any heartbeat interval and short enough that a
// crashed instance's lot is usable again before the next shift.
//
// Nothing in Go writes this bucket today — park is an engine (ARI) operation. It is declared here so
// both halves of the backbone create the same buckets, which is what the parity golden pins.
var ParkClaimsKV = KVBucketDefinition{
	Name:         "park-claims",
	Description:  "Orbit-slot ownership across engine instances, taken under compare-and-set.",
	TTL:          15 * time.Minute,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 4 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// ConferenceClaimsKV holds the agreed bridge id for a room, and who is in it.
//
// Unlike a parked call, a conference is repairable across instances: every engine talks to the same
// media server, so a bridge created by one is addressable by another. The only missing piece was
// agreement on WHICH bridge id room 3001 uses — two instances each minting their own is exactly how
// a room splits in two, with everybody hearing music and nobody hearing each other. The first joiner
// creates the claim carrying its bridge id; a joiner that loses the create joins the winner's bridge.
//
// The member count lives in the claim and moves under compare-and-set, which is what makes
// maxMembers a real cap rather than a per-instance one.
//
// Like ParkClaimsKV, declared but not written from Go.
var ConferenceClaimsKV = KVBucketDefinition{
	Name:         "conference-claims",
	Description:  "Conference room -> agreed bridge id and member count, under compare-and-set.",
	TTL:          15 * time.Minute,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 8 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// MediaSessionsKV maps an RTP session to the mediad instance that holds it.
//
// rpc.media.v1.* is served by a QUEUE GROUP, so NATS hands each request to whichever mediad happens
// to be free. That is right for allocate-session — any instance with a free port will do — and
// wrong for every command after it, because a session lives on exactly ONE instance: its sockets
// are bound there and its relay goroutines run there. A bridge-sessions delivered to the neighbour
// has nothing to bridge, and without this directory it could not tell "never existed" from "belongs
// to somebody else", which need different recoveries.
//
// Not a claim: nothing races for a media session, so there is no expiresAt and no heartbeat. The
// six-hour TTL is a backstop matching ChannelsKV (a session lives exactly as long as a call leg);
// the real cleanup is release-session deleting the key, which is part of the wire contract because a
// directory entry that outlives its session is an instance name the engine keeps routing dead
// commands to.
//
// This is the one bucket written from Go and read from both languages.
var MediaSessionsKV = KVBucketDefinition{
	Name:         "media-sessions",
	Description:  "RTP session -> owning mediad instance, for per-instance command routing.",
	TTL:          6 * time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 4 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// KVBuckets lists every bucket the backbone owns, in apply order.
var KVBuckets = []KVBucketDefinition{
	RegistrationsKV,
	ChannelsKV,
	PresenceKV,
	AgentStateKV,
	RoutingCacheKV,
	DIDIndexKV,
	QueueMembershipKV,
	ParkClaimsKV,
	ConferenceClaimsKV,
	MediaSessionsKV,
}

// KVBucketByName looks a bucket definition up by name.
func KVBucketByName(name string) (KVBucketDefinition, bool) {
	for _, definition := range KVBuckets {
		if definition.Name == name {
			return definition, true
		}
	}
	return KVBucketDefinition{}, false
}

// ---------------------------------------------------------------------------------------------
// KV keys — the same "never concatenate at a call site" rule as subjects
// ---------------------------------------------------------------------------------------------

// RegistrationKVKey builds the registrations key <orgId>.<aorHash>.
func RegistrationKVKey(orgID, aorHash string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	hash, err := token("aorHash", aorHash)
	if err != nil {
		return "", err
	}
	return org + "." + hash, nil
}

// ChannelKVKey builds the channels key <orgId>.<callId>.<legId>. A call's legs share a prefix so
// they can be read as a range.
func ChannelKVKey(orgID, callID, legID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	call, err := token("callId", callID)
	if err != nil {
		return "", err
	}
	leg, err := token("legId", legID)
	if err != nil {
		return "", err
	}
	return org + "." + call + "." + leg, nil
}

// PresenceKVKey builds the presence key <orgId>.<extensionId>.
func PresenceKVKey(orgID, extensionID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	extension, err := token("extensionId", extensionID)
	if err != nil {
		return "", err
	}
	return org + "." + extension, nil
}

// AgentStateKVKey builds the agent-state key <orgId>.<agentId>. An agent has one state across
// every queue.
func AgentStateKVKey(orgID, agentID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	agent, err := token("agentId", agentID)
	if err != nil {
		return "", err
	}
	return org + "." + agent, nil
}

// RoutingCacheKVKey builds the routing-cache key <orgId>.<artifact>[.<discriminator>].
//
// The artifact name IS the invalidation unit — the compiler deletes <orgId>.inbound.* when a DID
// route changes. At most one discriminator may be supplied.
func RoutingCacheKVKey(orgID, artifact string, discriminator ...string) (string, error) {
	if len(discriminator) > 1 {
		return "", &SubjectTokenError{Role: "discriminator", Value: "at most one is allowed"}
	}
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	name, err := token("artifact", artifact)
	if err != nil {
		return "", err
	}
	key := org + "." + name
	if len(discriminator) == 1 {
		suffix, err := token("discriminator", discriminator[0])
		if err != nil {
			return "", err
		}
		key += "." + suffix
	}
	return key, nil
}

// DIDIndexKVKey builds the did-index key: the DID's digits, and nothing else.
//
// The ONE key in this file that is not organization-scoped, because the organization is what it
// answers. Normalisation goes through DIDIndexToken so a control plane writing a stored
// "+441632960111" and an engine reading a dialled "441632960111" land on one key.
func DIDIndexKVKey(did string) (string, error) {
	normalized, err := DIDIndexToken(did)
	if err != nil {
		return "", err
	}
	return token("did", normalized)
}

// QueueMembershipKVKey builds the queue-membership key <orgId>.<queueId>: one entry per queue,
// holding its whole roster.
//
// Per queue and not per (queue, agent), deliberately. Distribution has to consider the tiers
// together — "the lowest level with an available agent" is not answerable from one agent's row — so
// a per-agent key would mean a range read per queued caller, and a partially-applied write would
// produce a roster the control plane never held.
func QueueMembershipKVKey(orgID, queueID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	queue, err := token("queueId", queueID)
	if err != nil {
		return "", err
	}
	return org + "." + queue, nil
}

// MediaSessionKVKey builds the media-sessions key: the session id, and nothing else.
//
// The second key here that is not organization-scoped, and for the same reason as DIDIndexKVKey:
// the READER does not know the tenant. A mediad handed a bridge-sessions carrying two session ids
// has no org to scope a lookup with, and threading one onto every media command purely so the key
// could be prefixed would be shaping the wire around a key format. The org travels in the value.
func MediaSessionKVKey(sessionID string) (string, error) {
	return token("sessionId", sessionID)
}
