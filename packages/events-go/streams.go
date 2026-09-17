package events

import (
	"strings"
	"time"
)

// JetStream stream and KV bucket definitions — the Go mirror of packages/events/src/streams.ts.
//
// Everything here is plain data: it can be asserted in a test, diffed in review, and handed to
// nats.go without this package importing a client. Durations are time.Duration (the TypeScript
// definitions carry the same values in milliseconds; the parity test checks both ends agree).
//
// Most streams are live-state feeds and discard old messages, since a newer event supersedes an
// older one. CDR, AUDIT and VOICEMAIL are ledgers and discard NEW instead: they refuse the write so
// the publisher gets an error it can retry and alert on, rather than losing billing, compliance or
// a caller's message under load.

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

// CallsStream carries the channel/bridge/DTMF/record feed. High volume, short life: anything that
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

// SIPStream carries SIP dialog lifecycle from apps/sipd.
//
// Separate from REGISTRATIONS because the two differ by two orders of magnitude in volume and are
// kept for different reasons: a `registered` is presence, while a `dialog.terminated` is CDR
// evidence carrying the only real Q.850 cause this platform sees. Seven days answers "what happened
// to that call", asked this week with a CDR row in hand.
var SIPStream = StreamDefinition{
	Name:              "SIP",
	Description:       "SIP dialog lifecycle from apps/sipd (sipd-invite-design §3.3, §10.2).",
	Subjects:          []string{AllSIPDialogsFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            7 * 24 * time.Hour,
	MaxMsgs:           Unlimited,
	MaxBytes:          4 * gib,
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

// VoicemailStream carries mailbox facts on their way to pbx-db, plus the derived MWI counts. It
// discards new for the reason CDR and AUDIT do: a dropped message.left is a recording the user will
// never see.
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
// Live-state facts, not a ledger, so it discards old. Two days is long enough to answer "why did
// that call go quiet?" on Monday about a Friday, and short enough that a media plane under sustained
// failure cannot fill a disk with its own complaints.
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

// TrunksStream carries carrier reachability transitions on their way to the trunk.status* columns.
//
// Modelled on RegistrationsStream: the persisted row is the eventually-consistent view and this is
// the transition log behind it. Seven days rather than registration's 24 hours, because the producer
// publishes changes rather than qualify ticks, so the stream is nearly empty at any retention.
var TrunksStream = StreamDefinition{
	Name:              "TRUNKS",
	Description:       "Carrier trunk status transitions consumed durably by the pbx writer (audit 4.5).",
	Subjects:          []string{AllTrunksFilter()},
	Retention:         RetentionLimits,
	Storage:           StorageFile,
	Discard:           DiscardOld,
	MaxAge:            7 * 24 * time.Hour,
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

// SecurityStream carries what the platform noticed: toll-fraud detections and their auto-actions.
//
// Thirty days rather than the audit stream's four hundred: a fraud signal is actionable while the
// incident is open and after that the audit row the same detector wrote is the durable record.
// DiscardOld for the reason every alert stream carries it — a stream that refuses new messages when
// it fills is a detector that goes quiet during the attack that filled it.
var SecurityStream = StreamDefinition{
	Name:              "SECURITY",
	Description:       "Control-plane security signals: toll-fraud detections and their auto-actions.",
	Subjects:          []string{AllSecurityFilter()},
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

// MessagingStream carries SMS/MMS inbound and delivery-receipt events for apps/api's durable inbox
// writer. Thirty days, like VOICEMAIL and CDR: how far back an inbox fan-out can be rebuilt from the
// log alone. DiscardNew because a delivery receipt or an inbound message must never be dropped for
// a newer one.
var MessagingStream = StreamDefinition{
	Name:              "MESSAGING",
	Description:       "SMS/MMS inbound and delivery-receipt events consumed durably by apps/api.",
	Subjects:          []string{AllMessagingFilter()},
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
	SIPStream,
	QueuesStream,
	VoicemailStream,
	MediaStream,
	TrunksStream,
	CDRStream,
	SecurityStream,
	AuditStream,
	ProvisionStream,
	MessagingStream,
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
// The one-hour TTL is a backstop, not the expiry mechanism: the registrar deletes a binding when its
// granted Expires lapses (see apps/sipd). It is longer than any sane Expires: header, so a
// refreshing device never disappears, and short enough that a dead registrar's rows self-heal.
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
// Not organization-scoped, because the organization is what it answers: an inbound INVITE arrives
// from a carrier with a dialled number and no idea whose it is.
//
// TTL zero, because this is configuration rather than live state — an expiring entry would stop an
// inbound call to a valid DID from resolving to a tenant, an outage produced by a timer. The
// authority is phone_number in pbx-db; this is a derived, rebuildable read model.
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
// The routing artifact deliberately carries a queue's routing configuration and no agents, so moving
// somebody between queues does not force a recompile. The engine still needs the roster at call time
// without a pbx-db handle, so this is the derived read model: written by apps/api inside the unit of
// work that changes a tier, read and watched by apps/engine.
//
// TTL zero for the reason DIDIndexKV's is — an expiring entry is a queue that suddenly has no agents
// and ejects every caller. Agent availability is the live half and lives in AgentStateKV, which does
// have a TTL, because a stale "available" self-corrects and a stale roster does not.
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
// The invariant: two calls can never occupy one orbit. An in-process map cannot hold that across
// instances, so the claim is taken with a KV create that fails when the key already exists, before
// any media moves — a failed create is the other instance winning, not an error to retry blindly.
//
// The TTL is a backstop; the record's own expiresAt is what a reaper reads, because server-side
// expiry cannot distinguish "the owner stopped heartbeating" from "written a while ago and still
// correct".
//
// Nothing in Go writes this bucket — park is an engine (ARI) operation — but it is declared here so
// both halves of the backbone create the same buckets.
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
// Every engine talks to the same media server, so a bridge created by one is addressable by another;
// the missing piece is agreement on WHICH bridge id a room uses, since two instances each minting
// their own splits the room in two. The first joiner creates the claim carrying its bridge id, and a
// joiner that loses the create joins the winner's bridge. The member count moves under
// compare-and-set, which is what makes maxMembers a real cap rather than a per-instance one.
//
// Like ParkClaimsKV, declared but not written from Go.
var ConferenceClaimsKV = KVBucketDefinition{
	Name:         "conference-claims",
	Description:  "Conference room -> agreed bridge id and leased instance contributions.",
	TTL:          15 * time.Minute,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 8 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// SharedLineStateKV holds which appearance has seized a shared line, across engine instances.
//
// One appearance seizes the line at a time, taken the same way a park orbit is: the answering
// appearance creates the key, and a loser reads the winner and lights its lamp remote-active. The
// TTL matches the other claim buckets so a crashed holder's line frees for the next seizure.
//
// Like ParkClaimsKV and ConferenceClaimsKV, declared but not written from Go.
var SharedLineStateKV = KVBucketDefinition{
	Name:         "shared-line-state",
	Description:  "Shared-line seizure ownership across engine instances, taken under compare-and-set.",
	TTL:          15 * time.Minute,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 4 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// MediaSessionsKV maps an RTP session to the mediad instance that holds it.
//
// rpc.media.v1.* is served by a queue group, which is right for allocate-session and wrong for every
// command after it: a session's sockets and relay goroutines live on exactly one instance. Without
// this directory a mediad handed a foreign bridge-sessions could not tell "never existed" from
// "belongs to somebody else", which need different recoveries.
//
// A directory, not a claim: nothing races for a media session, so there is no expiresAt and no
// heartbeat. The six-hour TTL is a backstop matching ChannelsKV; the real cleanup is release-session
// deleting the key, which is part of the wire contract.
var MediaOwnersKV = KVBucketDefinition{
	Name:        "media-owners",
	Description: "Call placement and media resource ownership, with atomic first-owner claims.",
	TTL:         6 * time.Hour, History: 1, Storage: StorageFile,
	MaxValueSize: 1024, MaxBytes: 128 * mib, NumReplicas: 1,
}

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

// QueueWaitingKV holds one queue's leased waiting line and its abandoned-resume tombstones.
//
// One key per queue holding the whole line, because a position is a RANK and so is not answerable
// from one caller's own row — an in-process count gives each engine only the callers it holds.
// Caller priority and abandoned-resume need the same whole-line view. Every write is a
// compare-and-set against the revision it read.
//
// Entries carry their own expiresAt, because a single-key record cannot have per-caller server-side
// expiry and a crashed engine that left its callers in the line would inflate every survivor's
// position. The six-hour TTL matches ChannelsKV.
var QueueWaitingKV = KVBucketDefinition{
	Name:         "queue-waiting",
	Description:  "Queue -> the leased waiting line and abandoned-resume tombstones, under CAS.",
	TTL:          6 * time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 256 * 1024,
	MaxBytes:     256 * mib,
	NumReplicas:  1,
}

// SIPDialogsKV maps a SIP dialog to the sipd instance that holds it, under a heartbeated lease.
//
// A claim rather than a directory, unlike MediaSessionsKV: what races here is a reaper against a
// corpse. A dialog's sockets, timers and CSeq are local to one process, so a dead sipd's calls
// cannot be failed over — but the engine must still learn they ended, or it holds channels forever
// and writes no CDR. The record therefore carries a lease its owner heartbeats, and a surviving
// instance that finds an expired claim publishes dialog.terminated{reason: "instance-lost"} on the
// dead owner's behalf. Reaping, not failover.
//
// Not organization-scoped, because a survivor sweeping a dead peer's claims has no org to prefix
// with. The six-hour TTL is a backstop; the record's own expiresAt is what a reaper reads.
var SIPDialogsKV = KVBucketDefinition{
	Name:         "sip-dialogs",
	Description:  "SIP dialog -> owning sipd instance, under a heartbeated lease, for reaping.",
	TTL:          6 * time.Hour,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 4 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// SIPInstancesKV maps a sipd instance to a liveness lease it renews every few seconds.
//
// SIPDialogsKV's reaper is a SURVIVING sipd sweeping a dead peer, which a single-instance edge does
// not have: when the only sipd dies its calls stay live in the engine with audio still flowing and
// the phone's BYE is answered 481 by the process that replaced it. This bucket is what lets the
// engine notice on its own — one key per process, so it watches a handful of keys rather than every
// dialog on the fleet.
//
// The TTL IS the lease here, the opposite of SIPDialogsKV: a record nobody renewed is a dead
// process, so there is no long-lived correct value that server-side expiry could wrongly reap, and
// a watcher learns of a death from the delete the server publishes. Not organization-scoped: a
// process belongs to no tenant.
var SIPInstancesKV = KVBucketDefinition{
	Name:         "sip-instances",
	Description:  "sipd instance -> liveness lease, so the engine can end legs whose edge died.",
	TTL:          15 * time.Second,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 1024,
	MaxBytes:     8 * mib,
	NumReplicas:  1,
}

// EngineInstancesKV maps an engine instance to a liveness lease it renews every few seconds.
//
// The channel ownership lease already names an owner and an expiry, but it is ninety seconds wide
// because it is renewed by a heartbeat that rewrites every live channel on the replica. Between an
// engine being SIGKILLed and its calls being adopted there is therefore up to a minute and a half in
// which media still flows, the dialog still stands, and no process holds an aggregate — so a BYE in
// that window ends nothing and the call is never billed. One key per process closes that window, the
// same shape SIPInstancesKV uses for the edge.
//
// The TTL IS the lease, as in SIPInstancesKV. Not organization-scoped: a process belongs to no
// tenant.
var EngineInstancesKV = KVBucketDefinition{
	Name:         "engine-instances",
	Description:  "engine instance -> liveness lease, so a survivor can adopt a dead replica's calls.",
	TTL:          15 * time.Second,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 1024,
	MaxBytes:     8 * mib,
	NumReplicas:  1,
}

// TrunksKV holds the carrier directory this process dials and registers against.
//
// A derived read model written by apps/api from the trunk table, on the same seam did-index and
// queue-membership occupy: apps/sipd holds no pbx-db handle, and the routing artifact cannot carry
// it either because plan-walker substitutes a trunk's NAME into a dial template and a name is not
// dialable. Read at boot and watched, so a trunk edited in the admin UI reaches the registration FSM
// without a restart.
//
// Org-scoped, unlike SIPACLKV below, because sipd originates on behalf of a tenant the engine has
// already named. TTL zero because it is configuration. The secret is not in here; the value carries
// a handle into the secret manager, exactly as the column does.
var TrunksKV = KVBucketDefinition{
	Name:         "trunks",
	Description:  "Trunk -> its dialable SIP configuration, for the edge's outbound and registration.",
	TTL:          0,
	History:      1,
	Storage:      StorageFile,
	MaxValueSize: 8 * 1024,
	MaxBytes:     128 * mib,
	NumReplicas:  1,
}

// SIPACLKV holds the source networks this edge accepts unauthenticated traffic from.
//
// sip_acl_entry is organization-scoped and the reader is not: an INVITE from a carrier carries a
// source address and nothing else. Same problem as did-index, same answer — a derived,
// non-org-scoped bucket written by apps/api from the table.
//
// Watched and compiled into an in-process longest-prefix match, never read per INVITE: a get per
// INVITE would be a broker round trip inside a SIP transaction on the one code path an attacker
// controls the rate of. Evaluation is lowest priority first, ties broken by the most specific
// prefix, first match wins; an address matching nothing is refused.
//
// TTL zero: an expiring allow entry fails a legitimate carrier while nobody changed anything, and an
// expiring DENY entry fails OPEN — a security boundary evaporating on a timer.
var SIPACLKV = KVBucketDefinition{
	Name:         "sip-acl",
	Description:  "Source network -> tenant, scope and action, for the SIP edge's trunk admission.",
	TTL:          0,
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
	SharedLineStateKV,
	MediaSessionsKV,
	MediaOwnersKV,
	QueueWaitingKV,
	SIPDialogsKV,
	SIPInstancesKV,
	EngineInstancesKV,
	TrunksKV,
	SIPACLKV,
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

// KV keys follow the same rule as subjects: never concatenate one at a call site.

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

// PresenceKVKey builds the presence key <orgId>.<extensionNumber> — the dialable number, not the
// extension row id.
//
// The number, because it is what both ends already hold: a provisioning template writes a BLF key as
// a number so a phone SUBSCRIBEs to sip:<number>@<domain>, and a channel snapshot carries a
// destination number so the engine aggregates over numbers too.
func PresenceKVKey(orgID, extensionNumber string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	extension, err := token("extensionNumber", extensionNumber)
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
// Per queue and not per (queue, agent): "the lowest tier with an available agent" is not answerable
// from one agent's row, so a per-agent key would mean a range read per queued caller and a
// partially-applied write would produce a roster the control plane never held.
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

// QueueWaitingKVKey builds the queue-waiting key <orgId>.<queueId>: one entry per queue, holding its
// whole line.
//
// Deliberately the same key shape as QueueMembershipKVKey, in a different bucket: the roster and the
// line are per-queue facts with different writers, lifetimes and TTLs, so "everything about queue X"
// is two point gets on one key string.
func QueueWaitingKVKey(orgID, queueID string) (string, error) {
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
// Not organization-scoped, for the same reason as DIDIndexKVKey: a mediad handed a bridge-sessions
// carrying two session ids has no org to scope a lookup with. The org travels in the value.
func MediaSessionKVKey(sessionID string) (string, error) {
	return token("sessionId", sessionID)
}

// SIPDialogKVKey builds the sip-dialogs key: the leg id, and nothing else.
//
// Not organization-scoped, for the reason MediaSessionKVKey gives, plus one specific to this bucket:
// the reader that matters most is a surviving sipd sweeping a dead peer's claims, and it has neither
// the org nor any way to guess it. The org travels in the value.
func SIPDialogKVKey(legID string) (string, error) {
	return token("legId", legID)
}

// SIPInstanceKVKey builds the sip-instances key: the sipd instance id, and nothing else.
//
// Not organization-scoped for a simpler reason than SIPDialogKVKey's: a process belongs to no
// tenant.
func SIPInstanceKVKey(instanceID string) (string, error) {
	return token("instanceId", instanceID)
}

// EngineInstanceKVKey builds the engine-instances key: the engine instance id, and nothing else.
//
// Not organization-scoped, for the same reason as SIPInstanceKVKey: a process belongs to no tenant.
func EngineInstanceKVKey(instanceID string) (string, error) {
	return token("instanceId", instanceID)
}

// TrunkKVKey builds the trunks key <orgId>.<trunkId>: one entry per trunk, holding its whole
// dialable configuration.
func TrunkKVKey(orgID, trunkID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	trunk, err := token("trunkId", trunkID)
	if err != nil {
		return "", err
	}
	return org + "." + trunk, nil
}

// SIPACLKVKey builds the sip-acl key: <orgId>.<scope>.<network>, with the network's ".", "/" and
// ":" folded to "-".
//
// The key is sip_acl_entry's unique index — (organization_id, scope, network) — spelled as tokens,
// so two tenants naming one CIDR cannot contend for one key. The edge still WATCHES the whole
// bucket and evaluates by network, because an arriving packet carries a source address and nothing
// else; the organization is in the key for the writer's benefit.
//
// The network is the only part needing a transformation: none of a CIDR's dots, slash or colons
// survives as a KV key token, so all three fold to "-". IPv6 folds too, since sip_acl_entry.network
// is a PostgreSQL cidr. Writer and reader go through this one function, which is what makes them
// agree.
//
// The result stays readable — "<org>.trunk.203-0-113-0-24", "<org>.registration.2001-db8---32",
// where the run of three dashes is the "::" — because an operator debugging a refused carrier reads
// these keys with `nats kv ls`. The fold need not be injective over arbitrary strings: the only
// inputs are values PostgreSQL's cidr type already normalised. It deliberately does not normalise
// the network itself.
func SIPACLKVKey(orgID, scope, network string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	scopeToken, err := token("scope", scope)
	if err != nil {
		return "", err
	}
	folded := strings.NewReplacer(".", "-", "/", "-", ":", "-").Replace(strings.TrimSpace(network))
	networkToken, err := token("network", folded)
	if err != nil {
		return "", err
	}
	return org + "." + scopeToken + "." + networkToken, nil
}
