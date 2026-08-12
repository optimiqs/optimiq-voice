import {
	didIndexToken,
	isSubjectToken,
	SUBJECT_ROOTS,
	subjectFilterFor,
	SubjectTokenError,
} from "./subjects";
import type { JetStreamManager, KvOptions, StreamConfig, StreamUpdateConfig } from "nats";

/**
 * JetStream stream and KV bucket definitions — DECLARATIVE CONFIG, plus the idempotent appliers.
 *
 * Spec: `plans/optimiq-voice-master-plan.md` §3.5.
 *
 * Everything here is a plain object: it can be asserted in a pure spec, diffed in review, and
 * later emitted as Go structs alongside the schemas. `ensureStreams` / `ensureKvBuckets` take an
 * ALREADY-CONNECTED `JetStreamManager` and apply the definitions. This package opens no
 * connections, owns no client, and wraps no publish/subscribe call — applications use the NestJS
 * NATS transport for events and RPC, and the raw `nats` JetStream API where durable consumers or
 * KV are genuinely needed.
 *
 * The policy fields are string-literal unions rather than the `nats` enums so that a definition
 * is inspectable JSON; the appliers cast once at the boundary (`nats` types them as string enums,
 * which literals are not assignable to).
 *
 * ## Why `discard: new` on CDR and AUDIT
 *
 * Every other stream is a live-state feed: if it overflows, dropping the oldest event is correct
 * because a newer one supersedes it. CDR and AUDIT are ledgers — billing and compliance. A silent
 * `discard: old` there would delete revenue and audit history under load, so those two refuse the
 * WRITE instead: the publisher gets an error it can retry, alert and page on.
 */

const NANOS_PER_MILLI = 1_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** JetStream expresses every duration in nanoseconds; every definition here is in millis. */
export function millisToNanos(millis: number): number {
	return Math.round(millis * NANOS_PER_MILLI);
}

/** Inverse of {@link millisToNanos}, for reading a live stream config back. */
export function nanosToMillis(nanos: number): number {
	return Math.round(nanos / NANOS_PER_MILLI);
}

export type RetentionPolicyName = "limits" | "interest" | "workqueue";
export type StorageTypeName = "file" | "memory";
export type DiscardPolicyName = "old" | "new";

/** A JetStream stream, described in units a human reads (millis and bytes). */
export interface StreamDefinition {
	readonly name: string;
	readonly description: string;
	readonly subjects: readonly string[];
	readonly retention: RetentionPolicyName;
	readonly storage: StorageTypeName;
	readonly discard: DiscardPolicyName;
	/** 0 = unlimited. */
	readonly maxAgeMs: number;
	/** -1 = unlimited. */
	readonly maxMsgs: number;
	/** -1 = unlimited. */
	readonly maxBytes: number;
	/** -1 = unlimited. Per-subject cap; `calls.evt.v1.<org>.<call>.<event>` is one subject. */
	readonly maxMsgsPerSubject: number;
	/** `Nats-Msg-Id` dedupe horizon: a repeat of the same id inside it is suppressed. */
	readonly duplicateWindowMs: number;
	readonly numReplicas: number;
}

/**
 * `CALLS` — the channel/bridge/DTMF/record feed. High volume, short life: it exists so the engine
 * can be restarted and rebuilt, and so live-state consumers (WS fan-out, wallboards) can catch
 * up. Anything that must survive is written to Postgres by a durable consumer.
 */
export const CALLS_STREAM: StreamDefinition = {
	name: "CALLS",
	description: "Channel lifecycle events per call leg (plan §3.5, §4.2).",
	subjects: [subjectFilterFor.allCalls()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 72 * HOUR_MS,
	maxMsgs: -1,
	maxBytes: 8 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/**
 * `REGISTRATIONS` — registrar edge transitions. The TRUTH for "who is registered" is the
 * `registrations` KV bucket; this stream is the audit/notification trail behind it.
 */
export const REGISTRATIONS_STREAM: StreamDefinition = {
	name: "REGISTRATIONS",
	description: "SIP registrar register/unregister/expire transitions (plan §3.5).",
	subjects: [subjectFilterFor.allRegistrations()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 24 * HOUR_MS,
	maxMsgs: -1,
	maxBytes: 1 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/**
 * `SIP` — SIP dialog lifecycle from the signalling edge (`apps/sipd`).
 *
 * A NEW stream rather than an extension of `REGISTRATIONS`, and the two facts that decide it are
 * volume and purpose. Registration transitions and dialog lifecycle differ by two orders of
 * magnitude — a phone re-registers every few minutes, a busy tenant sets up thousands of calls an
 * hour — and they are kept for different reasons: a `registered` is presence, and a
 * `dialog.terminated` is CDR EVIDENCE carrying the only real Q.850 cause this platform ever sees.
 * `streams.ts` already models one stream per family, and this is a family.
 *
 * ## `discard: old`, and why this is not CDR
 *
 * The stream is the transition log behind live state, not the ledger. The engine reads this family
 * on a CORE subscription for the reason it reads `media.evt.v1.>` that way — it wants a leg torn
 * down NOW and must not pay for an ack round trip on the call path — and the durable record of what
 * a call cost is `cdr.leg.v1`, which does discard `new` precisely because losing one is losing
 * money. Losing a dialog event costs the answer to "why did that call fail", which is worth keeping
 * and is not worth blocking a publisher for.
 *
 * ## Seven days
 *
 * Longer than `MEDIA`'s two and shorter than `VOICEMAIL`'s thirty. The question this stream answers
 * is "what happened to that call" — asked by a support desk with a CDR row in front of them, about
 * a call from this week — and a week covers "it happened last Friday" reported on a Thursday.
 */
export const SIP_STREAM: StreamDefinition = {
	name: "SIP",
	description: "SIP dialog lifecycle from apps/sipd (sipd-invite-design §3.3, §10.2).",
	subjects: [subjectFilterFor.allSipDialogs()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 7 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 4 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/** `QUEUES` — ACD caller/agent events. Kept a week so wallboards and reports can backfill. */
export const QUEUES_STREAM: StreamDefinition = {
	name: "QUEUES",
	description: "Queue caller and agent-state events (plan §3.5).",
	subjects: [subjectFilterFor.allQueues()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 7 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 2 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/**
 * `VOICEMAIL` — mailbox facts on their way to `pbx-db`, plus the derived MWI counts.
 *
 * `discard: new` for the same reason as CDR and AUDIT: a `message.left` that the broker silently
 * dropped is a message a caller recorded and a user will never see, which is indistinguishable from
 * the system losing their voicemail — because it is. The publisher gets an error it can retry on.
 *
 * 30 days matches CDR: it is how far back a mailbox can be rebuilt from the log alone.
 */
export const VOICEMAIL_STREAM: StreamDefinition = {
	name: "VOICEMAIL",
	description: "Voicemail message and MWI events consumed durably by the pbx writer (plan §3.5).",
	subjects: [subjectFilterFor.allVoicemail()],
	retention: "limits",
	storage: "file",
	discard: "new",
	maxAgeMs: 30 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 2 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 10 * MINUTE_MS,
	numReplicas: 1,
};

/**
 * `MEDIA` — the media plane's session lifecycle (`apps/mediad`).
 *
 * `discard: old` and a short window, unlike CDR: these are live-state facts about calls, not a
 * ledger. What they are kept for is the question asked minutes or hours later — "why did that call
 * go quiet?" — which is answered from `session.rtp-timeout` and a `session.ended` reason, and which
 * nobody asks about a call from last week without a CDR in front of them anyway.
 *
 * Two days, matching nothing else on purpose: long enough to cover a weekend's worth of "it
 * happened on Friday afternoon" reports, short enough that a media plane under sustained failure
 * cannot fill a disk with its own complaints.
 */
export const MEDIA_STREAM: StreamDefinition = {
	name: "MEDIA",
	description: "Media-plane RTP session lifecycle from apps/mediad (plan §3.4, mediad-design §4).",
	subjects: [subjectFilterFor.allMedia()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 2 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 1 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/**
 * `TRUNKS` — carrier reachability transitions on their way to the `trunk.status*` columns.
 *
 * Modelled on `REGISTRATIONS`, because it is the same kind of stream one hop out: the edge's
 * verdict on whether a peer answers, where the persisted row is the eventually-consistent view and
 * the stream is the transition log behind it. `discard: old` for the same reason too — a newer
 * status supersedes a lost one, and the durable writer only ever wants the latest truth per trunk.
 *
 * 7 days rather than registration's 24 hours: a trunk transition is RARE (the producer publishes
 * changes, not qualify ticks), so the stream is nearly empty at any retention, and a week is what
 * lets "when did carrier-a start flapping?" be answered on Monday about a weekend.
 */
export const TRUNKS_STREAM: StreamDefinition = {
	name: "TRUNKS",
	description: "Carrier trunk status transitions consumed durably by the pbx writer (audit 4.5).",
	subjects: [subjectFilterFor.allTrunks()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 7 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 1 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/**
 * `CDR` — per-leg call records on their way to `cdr-db`. "Replay = rebuild": the 30-day window is
 * how far back the CDR table can be reconstructed from the log alone. A wider `duplicate_window`
 * than the rest because a crash-looping writer may retry the same leg minutes later.
 */
export const CDR_STREAM: StreamDefinition = {
	name: "CDR",
	description: "Per-leg CDR writes consumed durably by the cdr-db writer (plan §3.5).",
	subjects: [subjectFilterFor.allCdrLegs()],
	retention: "limits",
	storage: "file",
	discard: "new",
	maxAgeMs: 30 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 16 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 10 * MINUTE_MS,
	numReplicas: 1,
};

/** `AUDIT` — who changed what. Compliance retention; never discards old messages. */
export const AUDIT_STREAM: StreamDefinition = {
	name: "AUDIT",
	description: "Control-plane audit trail (plan §3.5, §5 T1 audit log).",
	subjects: [subjectFilterFor.allAudit()],
	retention: "limits",
	storage: "file",
	discard: "new",
	maxAgeMs: 400 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 16 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/** `PROVISION` — device provisioning attempts; feeds the security view of the MAC endpoint. */
export const PROVISION_STREAM: StreamDefinition = {
	name: "PROVISION",
	description: "Device provisioning request/render/reject events (plan §3.5, §4.1.7).",
	subjects: [subjectFilterFor.allProvision()],
	retention: "limits",
	storage: "file",
	discard: "old",
	maxAgeMs: 30 * DAY_MS,
	maxMsgs: -1,
	maxBytes: 1 * GIB,
	maxMsgsPerSubject: -1,
	duplicateWindowMs: 2 * MINUTE_MS,
	numReplicas: 1,
};

/** Every stream the backbone owns, in apply order. */
export const EVENT_STREAMS: readonly StreamDefinition[] = [
	CALLS_STREAM,
	REGISTRATIONS_STREAM,
	SIP_STREAM,
	QUEUES_STREAM,
	VOICEMAIL_STREAM,
	MEDIA_STREAM,
	TRUNKS_STREAM,
	CDR_STREAM,
	AUDIT_STREAM,
	PROVISION_STREAM,
];

/** Returns a copy of `definition` with a production replica count (3 or 5). */
export function withReplicas(definition: StreamDefinition, numReplicas: number): StreamDefinition {
	if (!Number.isInteger(numReplicas) || numReplicas < 1 || numReplicas > 5) {
		throw new RangeError(`numReplicas must be an integer in 1..5, received ${numReplicas}.`);
	}
	return { ...definition, numReplicas };
}

/** The JetStream wire config for a definition: snake_case names, nanosecond durations. */
export interface StreamConfigInput {
	readonly name: string;
	readonly description: string;
	readonly subjects: string[];
	readonly retention: RetentionPolicyName;
	readonly storage: StorageTypeName;
	readonly discard: DiscardPolicyName;
	readonly max_age: number;
	readonly max_msgs: number;
	readonly max_bytes: number;
	readonly max_msgs_per_subject: number;
	readonly duplicate_window: number;
	readonly num_replicas: number;
}

/** Translates a definition into the JetStream wire config. */
export function streamConfigFor(definition: StreamDefinition): StreamConfigInput {
	return {
		name: definition.name,
		description: definition.description,
		subjects: [...definition.subjects],
		retention: definition.retention,
		storage: definition.storage,
		discard: definition.discard,
		max_age: millisToNanos(definition.maxAgeMs),
		max_msgs: definition.maxMsgs,
		max_bytes: definition.maxBytes,
		max_msgs_per_subject: definition.maxMsgsPerSubject,
		duplicate_window: millisToNanos(definition.duplicateWindowMs),
		num_replicas: definition.numReplicas,
	};
}

/**
 * The same config minus `name`, which JetStream takes as a separate argument on update and
 * rejects inside the body.
 */
export function streamUpdateConfigFor(
	definition: StreamDefinition,
): Omit<StreamConfigInput, "name"> {
	const { name, ...updatable } = streamConfigFor(definition);
	void name;
	return updatable;
}

/** What `ensureStreams` did to one stream. */
export type EnsureAction = "created" | "updated" | "unchanged";

export interface EnsureStreamOutcome {
	readonly name: string;
	readonly action: EnsureAction;
}

/**
 * Raised when a live stream differs from its definition in a field JetStream cannot alter after
 * creation. Recreating it would delete messages, so this is always a human decision.
 */
export class StreamDefinitionConflictError extends Error {
	readonly stream: string;
	readonly field: string;
	readonly live: string;
	readonly desired: string;

	constructor(stream: string, field: string, live: string, desired: string) {
		super(
			`Stream ${stream} has immutable field ${field}=${live} but the definition requires ` +
				`${desired}. JetStream cannot change this in place — migrate deliberately ` +
				"(mirror to a new stream, cut consumers over, delete the old one).",
		);
		this.name = "StreamDefinitionConflictError";
		this.stream = stream;
		this.field = field;
		this.live = live;
		this.desired = desired;
	}
}

/** The subset of a live stream config `ensureStreams` reconciles. */
export interface StreamConfigSnapshot {
	readonly name?: string;
	readonly description?: string;
	readonly subjects?: readonly string[];
	readonly retention?: string;
	readonly storage?: string;
	readonly discard?: string;
	readonly max_age?: number;
	readonly max_msgs?: number;
	readonly max_bytes?: number;
	readonly max_msgs_per_subject?: number;
	readonly duplicate_window?: number;
	readonly num_replicas?: number;
}

/** Recognises the "stream not found" API error across client and server versions. */
export function isStreamNotFoundError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const apiError = (error as { api_error?: { err_code?: number; code?: number } }).api_error;
	if (apiError?.err_code === 10059 || apiError?.code === 404) {
		return true;
	}
	return /not found/i.test(String((error as { message?: unknown }).message ?? ""));
}

function sameSubjects(live: readonly string[] | undefined, desired: readonly string[]): boolean {
	const liveSorted = [...(live ?? [])].sort();
	const desiredSorted = [...desired].sort();
	return (
		liveSorted.length === desiredSorted.length &&
		liveSorted.every((value, index) => value === desiredSorted[index])
	);
}

/** Pure diff between a live config and a desired one. Exported so it can be spec-tested. */
export function streamNeedsUpdate(live: StreamConfigSnapshot, desired: StreamConfigInput): boolean {
	return (
		!sameSubjects(live.subjects, desired.subjects) ||
		live.description !== desired.description ||
		live.discard !== desired.discard ||
		live.max_age !== desired.max_age ||
		live.max_msgs !== desired.max_msgs ||
		live.max_bytes !== desired.max_bytes ||
		live.max_msgs_per_subject !== desired.max_msgs_per_subject ||
		live.duplicate_window !== desired.duplicate_window ||
		live.num_replicas !== desired.num_replicas
	);
}

/** Asserts the fields JetStream cannot change in place. Exported for the same reason. */
export function assertStreamCompatible(
	name: string,
	live: StreamConfigSnapshot,
	desired: StreamConfigInput,
): void {
	if (live.retention !== undefined && live.retention !== desired.retention) {
		throw new StreamDefinitionConflictError(name, "retention", live.retention, desired.retention);
	}
	if (live.storage !== undefined && live.storage !== desired.storage) {
		throw new StreamDefinitionConflictError(name, "storage", live.storage, desired.storage);
	}
}

/**
 * Creates or reconciles every stream against an already-connected `JetStreamManager`.
 *
 * Idempotent: a second run over an unchanged broker returns `unchanged` for every stream and
 * issues no writes, so this is safe in a service bootstrap or a one-shot migration job.
 */
export async function ensureStreams(
	manager: JetStreamManager,
	definitions: readonly StreamDefinition[] = EVENT_STREAMS,
): Promise<readonly EnsureStreamOutcome[]> {
	const outcomes: EnsureStreamOutcome[] = [];

	for (const definition of definitions) {
		const desired = streamConfigFor(definition);
		let live: StreamConfigSnapshot | undefined;

		try {
			live = (await manager.streams.info(definition.name)).config;
		} catch (error) {
			if (!isStreamNotFoundError(error)) {
				throw error;
			}
		}

		if (live === undefined) {
			// `nats` types the policy fields as string enums; our definitions use the equivalent
			// literals so they stay plain data. This is the single conversion point.
			await manager.streams.add(desired as unknown as Partial<StreamConfig>);
			outcomes.push({ name: definition.name, action: "created" });
			continue;
		}

		assertStreamCompatible(definition.name, live, desired);

		if (!streamNeedsUpdate(live, desired)) {
			outcomes.push({ name: definition.name, action: "unchanged" });
			continue;
		}

		await manager.streams.update(
			definition.name,
			streamUpdateConfigFor(definition) as unknown as Partial<StreamUpdateConfig>,
		);
		outcomes.push({ name: definition.name, action: "updated" });
	}

	return outcomes;
}

// ---------------------------------------------------------------------------------------------
// KV buckets — ephemeral truth
// ---------------------------------------------------------------------------------------------

/**
 * A JetStream KV bucket. These hold LIVE state, never history: the streams above are the
 * replayable log, a bucket is the current value with a TTL that guarantees a crashed writer's
 * entries evaporate instead of lying forever.
 */
export interface KvBucketDefinition {
	readonly name: string;
	readonly description: string;
	/** Server-side expiry per key, in millis. 0 = never expire. */
	readonly ttlMs: number;
	/** Revisions kept per key. 1 everywhere: these are values, not logs. */
	readonly history: number;
	readonly storage: StorageTypeName;
	readonly maxValueSizeBytes: number;
	readonly maxBytes: number;
	readonly numReplicas: number;
}

/**
 * `registrations` — AOR → contact bindings, the location service `sipd` and the engine read
 * before routing to a device. TTL is one hour: longer than any sane `Expires:` header, so a
 * refreshing device never disappears, short enough that a dead registrar's rows self-heal.
 */
export const REGISTRATIONS_KV: KvBucketDefinition = {
	name: "registrations",
	description: "AOR -> contact bindings (plan §3.5).",
	ttlMs: 1 * HOUR_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 8 * 1024,
	maxBytes: 256 * MIB,
	numReplicas: 1,
};

/**
 * `channels` — live channel state so another engine instance can take over a drain or a crash.
 * TTL 6h covers the longest realistic call; a leaked entry cannot outlive a shift.
 */
export const CHANNELS_KV: KvBucketDefinition = {
	name: "channels",
	description: "Live channel state for engine failover and drain (plan §3.5).",
	ttlMs: 6 * HOUR_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 32 * 1024,
	maxBytes: 1 * GIB,
	numReplicas: 1,
};

/** `presence` — BLF/device state. Pure derived state, refreshed constantly; memory-backed. */
export const PRESENCE_KV: KvBucketDefinition = {
	name: "presence",
	description: "BLF / device presence aggregation (plan §3.5).",
	ttlMs: 5 * MINUTE_MS,
	history: 1,
	storage: "memory",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/** `agent-state` — ACD agent status. Survives a restart (a shift outlives a deploy). */
export const AGENT_STATE_KV: KvBucketDefinition = {
	name: "agent-state",
	description: "ACD agent availability/wrap-up state (plan §3.5).",
	ttlMs: 12 * HOUR_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `routing-cache` — compiled routing artifacts keyed for invalidation (the FusionPBX cache-key
 * contract, done properly). The TTL is a backstop only: correctness comes from the compiler
 * deleting keys on save, never from expiry.
 */
export const ROUTING_CACHE_KV: KvBucketDefinition = {
	name: "routing-cache",
	description: "Compiled routing artifacts, invalidated by key on save (plan §3.5, §3.1.3).",
	ttlMs: 1 * HOUR_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 1 * MIB,
	maxBytes: 1 * GIB,
	numReplicas: 1,
};

/**
 * `did-index` — DID → owning organization. THE multi-tenant inbound lookup.
 *
 * An inbound INVITE arrives from a carrier carrying a dialled number and no idea whose it is. Every
 * other bucket here is keyed by organization first, because every other reader already knows the
 * tenant; this one exists precisely because the reader does not, so its key is the DID alone (see
 * `kvKeyFor.didIndex`).
 *
 * ## Why the TTL is zero
 *
 * Every other bucket holds LIVE state whose staleness is self-correcting: a registration refreshes,
 * a channel ends, an artifact recompiles. This holds CONFIGURATION, and an expiring entry means an
 * inbound call to a perfectly valid DID stops resolving to a tenant and is rejected with
 * `INVALID_PROFILE` — an outage produced by a timer rather than by a change. The entry is written
 * when the number is configured and deleted when it is released; nothing else may remove it.
 *
 * ## What it is NOT
 *
 * It is not the authority on who owns a DID — `phone_number` in `pbx-db` is, and a global unique
 * index there is what makes two tenants claiming one number impossible. This bucket is a derived
 * read model, rebuildable at any time from the database by `apps/api`'s
 * `scripts/rebuild-did-index.ts`.
 */
export const DID_INDEX_KV: KvBucketDefinition = {
	name: "did-index",
	description: "DID (E.164 digits) -> owning organization, for inbound tenant attribution.",
	// 0 = never expire. Read the note above before changing this.
	ttlMs: 0,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 256 * MIB,
	numReplicas: 1,
};

/**
 * `queue-membership` — queue → its ordered tiers, and how to dial each agent in them.
 *
 * ## Why the engine cannot read this from the database
 *
 * A queue node in the routing artifact carries the queue's *routing* configuration — strategy,
 * timeouts, prompts, the timeout branch — because that is what the compiler has. It carries no
 * agents, and it should not: tiers change when a supervisor moves somebody between queues, which is
 * not a routing change and must not force a recompile of every route in the tenant.
 *
 * So the engine needs the membership at call time, from a process that holds no `pbx-db` handle and
 * must not grow one (a database on the call path is the thing this architecture spends its budget
 * avoiding). That leaves two seams: an RPC per queued caller, or a derived read model. This is the
 * read model, and it is the same shape as {@link DID_INDEX_KV} for the same reasons — written by
 * `apps/api` inside the unit of work that changes a tier or an agent, read (and watched) by the
 * engine.
 *
 * ## What is in the value and why
 *
 * The tiers (`level`, `position`), each agent's dial string, and the DISTRIBUTION parameters that
 * live on the `queue` / `queue_agent` rows rather than in the artifact: `wrapUpSeconds`,
 * `maxNoAnswer`, the no-answer/busy/reject penalty delays, and the three `tier_rule_*` columns. They
 * are here rather than in the plan node because they change with membership, not with routing — see
 * `queueMembershipSchema`.
 *
 * ## Why the TTL is zero
 *
 * Same argument as `did-index`: this is CONFIGURATION, not live state. An expiring entry means a
 * queue that suddenly has no agents and ejects every caller to its timeout branch — an outage
 * produced by a timer rather than by a change. Agent AVAILABILITY is the live half and lives in
 * {@link AGENT_STATE_KV}, which does have a TTL, because a stale "available" self-corrects and a
 * stale roster does not.
 */
export const QUEUE_MEMBERSHIP_KV: KvBucketDefinition = {
	name: "queue-membership",
	description: "Queue -> ordered tiers with agent dial strings, for ACD distribution.",
	// 0 = never expire. Read the note above before changing this.
	ttlMs: 0,
	history: 1,
	storage: "file",
	// A queue with 200 agents at ~300 bytes each, with headroom. `queue_tier` has no hard cap, but
	// a roster that does not fit here is one no distribution strategy could ring fairly anyway.
	maxValueSizeBytes: 128 * 1024,
	maxBytes: 256 * MIB,
	numReplicas: 1,
};

/**
 * `park-claims` — which engine instance owns which orbit slot.
 *
 * ## The invariant this exists for
 *
 * **Two calls can never occupy one orbit.** A colleague is told "she is on 401"; they dial 401 and
 * must reach exactly that caller. An in-process map holds that within one engine and says nothing
 * across two, so a second instance behind the same media server hands out 401 again and the person
 * who dials it reaches whichever of the two the switch happened to give them.
 *
 * The claim is therefore taken HERE, with `create` — the KV operation that fails when the key
 * already exists — before any media moves. A failed create is not an error to retry blindly: it is
 * the other instance winning, and the parker moves to the next free slot or is told the lot is full.
 *
 * ## Why the TTL is short, and what the heartbeat is for
 *
 * An instance that dies mid-call leaves its claims behind, and a slot nobody can release is a slot
 * permanently removed from the lot. So a claim carries the owning instance and an expiry, the owner
 * re-writes it on a heartbeat for as long as the call is parked, and a claim past its expiry is
 * REAPABLE by anybody. Fifteen minutes is longer than any heartbeat interval by two orders of
 * magnitude and short enough that a crashed instance's lot is usable again before the next shift.
 *
 * The bucket TTL is the backstop; the record's own `expiresAt` is what a reaper reads, because
 * server-side expiry cannot distinguish "the owner stopped heartbeating" from "the value was
 * written a long time ago and is still correct".
 */
export const PARK_CLAIMS_KV: KvBucketDefinition = {
	name: "park-claims",
	description: "Orbit-slot ownership across engine instances, taken under compare-and-set.",
	ttlMs: 15 * MINUTE_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `conference-claims` — the agreed bridge id for a room, and who is in it.
 *
 * ## Why this fixes a split rather than merely detecting one
 *
 * Unlike a parked call, a conference is repairable across instances: every engine talks to the SAME
 * media server, so a bridge created by instance A is addressable by instance B. The only thing that
 * was missing was agreement on WHICH bridge id room `3001` uses. Two instances each minting their
 * own is exactly how a room splits in two, with everybody hearing music and nobody hearing each
 * other — a failure that reads as a media bug and is not one.
 *
 * So the first joiner `create`s the claim carrying its bridge id; a joiner who loses the create
 * reads the winner's id and joins THAT bridge. The room is one room again.
 *
 * ## Per-instance membership lives here too, and that is what makes `maxMembers` real
 *
 * A cap enforced per instance is not a cap. Each instance contributes its count, moderator presence,
 * and expiry under compare-and-set. Totals come from unexpired contributions, so the twenty-first
 * participant is refused wherever they land while a crashed instance's seats are eventually freed.
 *
 * TTL matches `park-claims` for the same reason — a crashed instance's room must not survive it.
 */
export const CONFERENCE_CLAIMS_KV: KvBucketDefinition = {
	name: "conference-claims",
	description: "Conference room -> agreed bridge id and leased instance contributions.",
	ttlMs: 15 * MINUTE_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 8 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `shared-line-state` — which appearance has seized a shared line, across engine instances.
 *
 * ## The invariant this exists for
 *
 * **A shared line is seized by one appearance at a time.** When the boss's desk answers the call on
 * the shared line, the assistant's key must go busy — otherwise the assistant grabs a call that is
 * already someone's. That is the same exclusivity a park orbit needs, and it is taken the same way:
 * the answering appearance `create`s this key, and an appearance that loses the create reads the
 * winner off the value and lights its lamp remote-active rather than joining the call. An in-process
 * map holds that within one engine and says nothing across two, so the claim lives HERE.
 *
 * ## Why the TTL matches the claim buckets
 *
 * Fifteen minutes, like `park-claims` and `conference-claims`, for the same reason: a crashed
 * instance that held a line must not keep it seized forever. The owner heartbeats for as long as the
 * call is up; a claim past its `expiresAt` with no heartbeat is reapable, so a dead holder's line
 * frees for the next seizure. The record's own `expiresAt` is what a reaper reads; the bucket TTL is
 * the backstop.
 */
export const SHARED_LINE_STATE_KV: KvBucketDefinition = {
	name: "shared-line-state",
	description:
		"Shared-line seizure ownership across engine instances, taken under compare-and-set.",
	ttlMs: 15 * MINUTE_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `media-sessions` — which `mediad` instance holds which RTP session.
 *
 * The full argument for its existence, its shape and its key is on
 * {@link import("./schemas/live-state").mediaSessionDirectoryEntrySchema}. In short: `rpc.media.v1.*`
 * is queue-grouped, so NATS picks any instance, and every command after the allocate has to reach
 * the ONE instance whose sockets the session is bound to.
 *
 * ## Why the TTL is six hours
 *
 * The same number as `channels`, for the same reason: a media session lives exactly as long as a
 * call leg, and six hours covers the longest realistic one while guaranteeing a crashed instance's
 * entries cannot outlive a shift. The TTL is a BACKSTOP — the real cleanup is `release-session`
 * deleting the key, which is part of the wire contract precisely because a directory entry that
 * outlives its session is an instance name the engine keeps routing dead commands to.
 */
export const MEDIA_SESSIONS_KV: KvBucketDefinition = {
	name: "media-sessions",
	description: "RTP session -> owning mediad instance, for per-instance command routing.",
	ttlMs: 6 * HOUR_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `queue-waiting` — who is in one queue's line, right now, across every engine instance.
 *
 * ## The problem it exists for
 *
 * "You are caller number four" was a lie in a cluster. The count came from an in-process map
 * (`QueuePositions`), so with three engines behind one media server each of them counted only the
 * callers it happened to be holding and every one of them announced a number that was too small.
 * Three separate features turned out to need the same missing fact:
 *
 * 1. **Position**, which is that fact directly.
 * 2. **Priority**, which is meaningless without it — "higher priority dequeues first" is a statement
 *    about an ORDER, and an order needs everybody in it. Two instances each ordering their own half
 *    of the line will happily serve a normal caller ahead of a VIP.
 * 3. **Abandoned-resume**, which needs the line to remember a caller who is no longer on it.
 *
 * ## One key per queue, holding the whole line
 *
 * The same decision as {@link QUEUE_MEMBERSHIP_KV} and for a stronger version of the same reason.
 * Position is not answerable from one caller's own row — it is a RANK, so a reader needs every row
 * at once — and a per-caller key would make each announcement a range read plus N gets, while a
 * partially-applied multi-key write would produce a line that no engine ever held. One key makes the
 * line atomic, the read a point get, and the write a compare-and-set against a revision.
 *
 * The cost is contention: every join, leave and lease renewal on a busy queue writes one key. That
 * is bounded by design — renewals are throttled to a fraction of the lease, joins and leaves happen
 * at human speed, and a lost CAS is retried against the newer value rather than being an error. It
 * is the same trade `queue-membership` makes and it is the right way round: a queue with fifty
 * people waiting has fifty writes a minute, not fifty a second.
 *
 * ## Why entries carry a lease, and why the bucket TTL cannot replace it
 *
 * The record is one key, so per-caller server-side expiry is not available: a crashed engine would
 * otherwise leave its callers in the line for ever, and every survivor would be told they were
 * further back than they are — the exact failure this bucket exists to fix, inverted. So each entry
 * carries an `expiresAt` that its owning session pushes forward while the caller is really still
 * waiting, exactly as a park claim does, and any writer prunes entries past theirs on its way past.
 * The bucket TTL is a backstop for the whole record, nothing more.
 *
 * ## Why it has a TTL at all, unlike the two configuration buckets
 *
 * Because it is LIVE STATE and its staleness self-corrects: a line nobody is joining is a line that
 * should evaporate. Six hours matches {@link CHANNELS_KV} for the same reason — it is longer than
 * any call and shorter than a shift, so a crashed instance's residue cannot outlive the day.
 */
export const QUEUE_WAITING_KV: KvBucketDefinition = {
	name: "queue-waiting",
	description: "Queue -> the leased waiting line and abandoned-resume tombstones, under CAS.",
	ttlMs: 6 * HOUR_MS,
	history: 1,
	storage: "file",
	// A line of 500 at ~200 bytes each plus as many tombstones, with headroom. `queueWaitingRecord`
	// caps both arrays below that, so the cap is enforced by the writer rather than discovered as a
	// rejected write in the middle of an incident.
	maxValueSizeBytes: 256 * 1024,
	maxBytes: 256 * MIB,
	numReplicas: 1,
};

/**
 * `sip-dialogs` — which `sipd` instance holds which SIP dialog, under a heartbeated lease.
 *
 * ## A CLAIM, not a directory — and that is where it diverges from `media-sessions`
 *
 * `plans/mediad-design.md` §6.3 argues that the media directory needs no `expiresAt` because
 * "nothing races for a media session". Something races here: **a dead owner's dialogs must be reaped
 * by somebody.** A dialog's transaction state, its retransmission timers and its socket are all
 * local (§6.1), so a crashed `sipd` is N dropped calls and there is no failover that could change
 * that. What there IS, is a survivor who can notice: a `sipd` that finds an expired claim it does
 * not own publishes `dialog.terminated{reason: "instance-lost"}` on the dead owner's behalf, and the
 * engine writes a CDR from a `leg-ended` it would otherwise never have received. Without this
 * bucket, a rescheduled pod's calls are channels the engine holds for ever and rows nobody bills.
 *
 * **The directory's job is reaping, not failover.** Worth stating plainly, because the alternative
 * is discovering it during an incident.
 *
 * ## Not organization-scoped
 *
 * The THIRD exception after `did-index` and `media-sessions`, for the identical reason: the reader
 * does not know the tenant. An engine reconciling a `legId` from a `leg-ended`, or a second `sipd`
 * reaping a dead peer, has no org to prefix with. The org travels in the value.
 *
 * ## One writer
 *
 * `sipd` writes it; the engine reads it. The temptation is to let the engine write its own instance
 * id into the same record so the REFER path could find the owning ENGINE — and it should be refused,
 * because two writers on one key is a compare-and-set protocol nobody needs. The engine's half comes
 * for free anyway: `kvKeyFor.channel(orgId, callId, legId)` is a direct get against `channels`, so
 * an instance that finds a live entry it does not itself hold already knows the difference between
 * "this call ended" and "ask my neighbour" — which is what finally lets
 * `SIP_TRANSFER_REFUSAL_REASONS.wrong_instance` be raised truthfully for the first time.
 *
 * ## Why the TTL is six hours and the record still carries `expiresAt`
 *
 * Six matches `channels` and `media-sessions`: a dialog lives exactly as long as a call leg. The
 * bucket TTL is the BACKSTOP; the record's own lease is what a reaper reads, because server-side
 * expiry cannot distinguish "the owner stopped heartbeating" from "the value was written a long time
 * ago and is still correct" — the same argument `PARK_CLAIMS_KV` makes.
 */
export const SIP_DIALOGS_KV: KvBucketDefinition = {
	name: "sip-dialogs",
	description: "SIP dialog -> owning sipd instance, under a heartbeated lease, for reaping.",
	ttlMs: 6 * HOUR_MS,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `trunks` — the carrier directory the SIP edge dials and registers against.
 *
 * ## Why the edge cannot read this from the database
 *
 * The same seam `queue-membership` and `did-index` occupy, one process further out. `apps/sipd` is
 * Go, holds no `pbx-db` handle and must not grow one — a database on the INVITE path is the thing
 * this architecture spends its budget avoiding, and the INVITE path is the one code path an attacker
 * controls the rate of. Nor can the routing artifact carry it: `plan-walker` substitutes a trunk's
 * NAME into a dial template, and a name is not dialable. The row holds `sipProxy`, `outboundProxy`,
 * `authUser`, `sipSecretRef`, `transport` and `registerExpiresSeconds`, and every one of those is
 * needed to place one INVITE.
 *
 * So: a derived read model, written by `apps/api` from the `trunk` table and rebuildable from it,
 * exactly as `did-index.publisher.ts` writes its bucket. `sipd` reads it at boot and WATCHES it, so
 * a trunk edited in the admin UI reaches the registration FSM without a restart — which is what
 * replaces the `SIPD_TRUNK_ACL` environment variable that could only be changed by redeploying.
 *
 * ## Org-scoped, unlike its sibling below
 *
 * `sipd` originates on behalf of a tenant the engine has already named, so the reader DOES know the
 * organization here — the ordinary case, and the ordinary key shape. The ACL bucket is the one that
 * cannot be, because an inbound packet arrives before anybody knows whose it is.
 *
 * ## Why the TTL is zero
 *
 * CONFIGURATION, not live state — the same argument as `did-index` and `queue-membership`. An
 * expiring entry means an outbound call to a perfectly valid trunk stops resolving, which is an
 * outage produced by a timer rather than by a change. Live trunk REACHABILITY is the other half and
 * travels as `trunk.evt.v1.…status.changed`, which is an event precisely because it changes.
 *
 * **The secret is not in here.** `sipSecretRef` is a handle into the secret manager, exactly as it is
 * in the column, and the value it names never lands in the broker.
 */
export const TRUNKS_KV: KvBucketDefinition = {
	name: "trunks",
	description: "Trunk -> its dialable SIP configuration, for the edge's outbound and registration.",
	// 0 = never expire. Read the note above before changing this.
	ttlMs: 0,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 8 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

/**
 * `sip-acl` — the source networks the SIP edge accepts unauthenticated traffic from.
 *
 * ## The boundary this is
 *
 * The first slice where an unauthenticated stranger can send this platform a packet that costs it
 * work. `sip_acl_entry` already has the right shape in `pbx-db` — a native PostgreSQL `cidr`, an
 * `action`, a `priority` and a `scope` whose values are described in that schema as "the
 * anti-toll-fraud boundary" — and it is organization-scoped, which is exactly the problem: **the
 * reader does not know the organization.** Same problem as `did-index`, same answer.
 *
 * ## Not org-scoped, and WATCHED rather than read
 *
 * The fourth non-org-scoped bucket. Its key is a network token, because a network is what an
 * arriving packet has; the tenant, the scope and the action travel in the value.
 *
 * And `sipd` compiles the entries into an in-process longest-prefix match at boot and on every
 * watch update, rather than doing a KV get per INVITE. A get per INVITE is a broker round trip
 * INSIDE a SIP transaction on the one code path whose rate an attacker chooses — the cheapest
 * denial of service available against this design, bought for nothing.
 *
 * ## Why the TTL is zero
 *
 * The strongest version of the `did-index` argument. An expiring ACL entry does not fail closed in
 * any useful sense — it fails a legitimate carrier's calls while nobody changed anything — and an
 * expiring `deny` entry fails OPEN, which is a security boundary evaporating on a timer. Entries are
 * written when configured and deleted when removed; nothing else may remove one.
 */
export const SIP_ACL_KV: KvBucketDefinition = {
	name: "sip-acl",
	description: "Source network -> tenant, scope and action, for the SIP edge's trunk admission.",
	// 0 = never expire. Read the note above before changing this — an expiring `deny` fails OPEN.
	ttlMs: 0,
	history: 1,
	storage: "file",
	maxValueSizeBytes: 4 * 1024,
	maxBytes: 128 * MIB,
	numReplicas: 1,
};

export const KV_BUCKETS: readonly KvBucketDefinition[] = [
	REGISTRATIONS_KV,
	CHANNELS_KV,
	PRESENCE_KV,
	AGENT_STATE_KV,
	ROUTING_CACHE_KV,
	DID_INDEX_KV,
	QUEUE_MEMBERSHIP_KV,
	PARK_CLAIMS_KV,
	CONFERENCE_CLAIMS_KV,
	SHARED_LINE_STATE_KV,
	MEDIA_SESSIONS_KV,
	QUEUE_WAITING_KV,
	SIP_DIALOGS_KV,
	TRUNKS_KV,
	SIP_ACL_KV,
];

/** The KV wire options for a bucket definition. */
export interface KvOptionsInput {
	readonly description: string;
	readonly ttl: number;
	readonly history: number;
	readonly storage: StorageTypeName;
	readonly replicas: number;
	readonly max_bytes: number;
	readonly maxValueSize: number;
}

/** Translates a bucket definition into the KV wire options. */
export function kvOptionsFor(definition: KvBucketDefinition): KvOptionsInput {
	return {
		description: definition.description,
		ttl: definition.ttlMs,
		history: definition.history,
		storage: definition.storage,
		replicas: definition.numReplicas,
		max_bytes: definition.maxBytes,
		maxValueSize: definition.maxValueSizeBytes,
	};
}

export interface EnsureKvOutcome {
	readonly name: string;
	readonly created: boolean;
}

/**
 * Opens (creating if absent) every KV bucket, using the JetStream client the manager was built
 * from. Idempotent — the KV view API binds to an existing bucket rather than failing.
 *
 * Note the asymmetry with {@link ensureStreams}: the KV view API does not reconcile an existing
 * bucket's limits. Changing a bucket's TTL or storage is a deliberate migration (drain, delete,
 * recreate), not something a boot should do behind an operator's back.
 */
export async function ensureKvBuckets(
	manager: JetStreamManager,
	definitions: readonly KvBucketDefinition[] = KV_BUCKETS,
): Promise<readonly EnsureKvOutcome[]> {
	const jetstream = manager.jetstream();
	const outcomes: EnsureKvOutcome[] = [];

	for (const definition of definitions) {
		let created = false;
		try {
			// `KV_<bucket>` is the backing stream. Its absence is how we report "created".
			await manager.streams.info(`KV_${definition.name}`);
		} catch (error) {
			if (!isStreamNotFoundError(error)) {
				throw error;
			}
			created = true;
		}
		await jetstream.views.kv(definition.name, kvOptionsFor(definition) as Partial<KvOptions>);
		outcomes.push({ name: definition.name, created });
	}

	return outcomes;
}

// ---------------------------------------------------------------------------------------------
// KV keys — the same "never concatenate at a call site" rule as subjects
// ---------------------------------------------------------------------------------------------

function assertKeyToken(role: string, value: string): string {
	if (!isSubjectToken(value)) {
		throw new SubjectTokenError(role, value);
	}
	return value;
}

/** Builders for every KV key this backbone defines. Org-scoped first, always. */
export const kvKeyFor = {
	/** `registrations`: `<orgId>.<aorHash>` — see `aorSubjectToken`. */
	registration(orgId: string, aorHash: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("aorHash", aorHash)}`;
	},
	/** `channels`: `<orgId>.<callId>.<legId>` — a call's legs share a prefix for range reads. */
	channel(orgId: string, callId: string, legId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("callId", callId)}.${assertKeyToken("legId", legId)}`;
	},
	/**
	 * `presence`: `<orgId>.<extensionNumber>` — the dialable number, not the `extension` row id.
	 *
	 * The number because it is what both ends of this bucket already hold: every provisioning
	 * template writes a BLF key as a number, so a phone SUBSCRIBEs to `sip:<number>@<domain>` and
	 * `sipd` reads a number off the Request-URI; and a `ChannelSnapshot` carries
	 * `profile.destinationNumber`, so the engine aggregates over numbers too. A row-id key would put
	 * a lookup on the path of every NOTIFY purely to translate an identifier the wire never carries.
	 * See `extensionPresenceSchema` for the full argument and what it costs at renumbering time.
	 */
	presence(orgId: string, extensionNumber: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("extensionNumber", extensionNumber)}`;
	},
	/** `agent-state`: `<orgId>.<agentId>` — an agent has one state across every queue. */
	agentState(orgId: string, agentId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("agentId", agentId)}`;
	},
	/**
	 * `routing-cache`: `<orgId>.<artifact>[.<discriminator>]`. The artifact name IS the
	 * invalidation unit — the compiler deletes `<orgId>.inbound.*` when a DID route changes.
	 */
	routingCache(orgId: string, artifact: string, discriminator?: string): string {
		const base = `${assertKeyToken("orgId", orgId)}.${assertKeyToken("artifact", artifact)}`;
		return discriminator === undefined
			? base
			: `${base}.${assertKeyToken("discriminator", discriminator)}`;
	},
	/**
	 * `did-index`: the DID's digits, and nothing else.
	 *
	 * The ONE key in this file that is not organization-scoped, because the organization is what it
	 * answers. Normalization goes through {@link didIndexToken} so the control plane writing a
	 * stored `+441632960111` and the engine reading a dialled `441632960111` land on one key.
	 */
	didIndex(did: string): string {
		return assertKeyToken("did", didIndexToken(did));
	},
	/**
	 * `queue-membership`: `<orgId>.<queueId>` — one entry per queue, holding its whole roster.
	 *
	 * Per QUEUE and not per (queue, agent), deliberately. Distribution has to consider the tiers
	 * TOGETHER — "the lowest level with an available agent" is not answerable from one agent's row —
	 * so a per-agent key would mean a range read per queued caller, and a partially-applied write
	 * would produce a roster the control plane never held. One key makes the roster atomic and the
	 * read a point get.
	 */
	queueMembership(orgId: string, queueId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("queueId", queueId)}`;
	},
	/**
	 * `queue-waiting`: `<orgId>.<queueId>` — one entry per queue, holding its whole line.
	 *
	 * Deliberately the same key SHAPE as {@link kvKeyFor.queueMembership}, in a different bucket.
	 * The roster and the line are both per-queue facts with different writers, different lifetimes
	 * and different TTLs, and a reader that wanted "everything about queue X" gets it from two point
	 * gets on one key string rather than from a join.
	 *
	 * Not keyed per waiting CALLER, for the reason on {@link QUEUE_WAITING_KV}: a position is a rank
	 * over the whole line, so a per-caller key would turn every announcement into a range read and
	 * would let a half-applied write produce an order nobody ever held.
	 */
	queueWaiting(orgId: string, queueId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("queueId", queueId)}`;
	},
	/**
	 * `park-claims`: `<orgId>.<parkLotId>.<slot>` — the ORBIT is the key, because the orbit is what
	 * has to be exclusive.
	 *
	 * Not keyed by the parked channel: two instances racing for slot 401 must collide, and a
	 * channel-keyed claim would let both of them succeed and then discover the conflict at retrieval
	 * time, which is a caller reaching the wrong person rather than a park being refused.
	 *
	 * The lot prefixes the slot so an operator (or a reaper) can range-read one lot, and because slot
	 * numbers are only unique within a lot.
	 */
	parkClaim(orgId: string, parkLotId: string, slot: number): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("parkLotId", parkLotId)}.${assertKeyToken("slot", String(slot))}`;
	},
	/**
	 * `conference-claims`: `<orgId>.<conferenceId>` — one entry per room.
	 *
	 * By the room's ID and not its dialled number: a tenant may renumber `3001` while people are in
	 * it, and a key that moved underneath a live room would strand everybody already inside on a
	 * bridge nobody can find again.
	 */
	conferenceClaim(orgId: string, conferenceId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("conferenceId", conferenceId)}`;
	},
	/**
	 * `shared-line-state`: `<orgId>.<sharedLineId>` — one entry per shared line.
	 *
	 * By the line's id and not its dialled number, for the reason the conference claim gives: a
	 * tenant may renumber a shared line while a call is up on it, and a key that moved underneath a
	 * live seizure would strand the holders on a claim nobody can find again.
	 */
	sharedLineState(orgId: string, sharedLineId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("sharedLineId", sharedLineId)}`;
	},
	/**
	 * `media-sessions`: the session id, and nothing else.
	 *
	 * The second key in this file that is not organization-scoped, and for the same reason as
	 * {@link kvKeyFor.didIndex}: the reader does not know the tenant. A `mediad` instance handed a
	 * `bridge-sessions` carrying two session ids has no org to scope a lookup with, and threading
	 * one onto every media command purely so the key could be prefixed would be shaping the wire
	 * around a key format. The org travels in the VALUE.
	 */
	mediaSession(sessionId: string): string {
		return assertKeyToken("sessionId", sessionId);
	},
	/**
	 * `sip-dialogs`: the leg id, and nothing else.
	 *
	 * The THIRD non-org-scoped key here, for the same reason as {@link kvKeyFor.mediaSession} — and
	 * for one more that is specific to this bucket: the reader that matters most is a SURVIVING
	 * `sipd` sweeping a dead peer's claims, and it has neither the org nor any way to guess it. The
	 * org travels in the value. See {@link SIP_DIALOGS_KV}.
	 */
	sipDialog(legId: string): string {
		return assertKeyToken("legId", legId);
	},
	/**
	 * `trunks`: `<orgId>.<trunkId>` — one entry per trunk, holding its whole dialable configuration.
	 *
	 * Org-scoped, because the edge originates on behalf of a tenant the engine has already named, and
	 * because an operator answering "what does this tenant dial out over?" should get it from one
	 * range read.
	 */
	trunk(orgId: string, trunkId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("trunkId", trunkId)}`;
	},
	/**
	 * `sip-acl`: the network, with `.`, `/` and `:` folded to `-`.
	 *
	 * The FOURTH non-org-scoped key, and the only one whose key needs a transformation at all. A CIDR
	 * is `203.0.113.0/24` or `2001:db8::/32`, and none of the dots, the slash or the colons survives
	 * as a KV key token — dots would silently become four tokens, and neither `/` nor `:` is in
	 * `TOKEN_PATTERN` at all. **All three separators fold, not just the v4 pair**: `sip_acl_entry.network`
	 * is a PostgreSQL `cidr`, which holds IPv6 as readily as IPv4, and a folder that handled only v4
	 * would throw on the first IPv6 carrier — at write time in the control plane, or at boot in the
	 * edge, both of which are worse places to find out than here.
	 *
	 * Both writers (the control plane, from the stored `cidr`) and the reader (the edge, at boot and
	 * on watch) go through this one function, which is what makes the two agree.
	 *
	 * The result stays readable by inspection — `203-0-113-0-24`, `2001-db8---32`, where the run of
	 * three dashes is the `::` — which matters because an operator debugging a refused carrier reads
	 * these keys with `nats kv ls`. The mapping is not injective over ARBITRARY strings, and does not
	 * need to be: the only inputs are values PostgreSQL's `cidr` type already accepted and normalised,
	 * and no two distinct normalised CIDRs fold to the same key. This deliberately does NOT normalise
	 * the network itself — a second normaliser here would be a second opinion about what a network is.
	 *
	 * @throws {SubjectTokenError} when the value contains no usable characters.
	 */
	sipAcl(network: string): string {
		const folded = network.trim().replaceAll(/[./:]/gu, "-");
		return assertKeyToken("network", folded);
	},
} as const;

/** Re-exported so a bootstrap can log exactly what it applied without importing two modules. */
export const STREAM_SUBJECT_ROOTS = SUBJECT_ROOTS;
