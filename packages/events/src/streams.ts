import { isSubjectToken, SUBJECT_ROOTS, subjectFilterFor, SubjectTokenError } from "./subjects";
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
	QUEUES_STREAM,
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

export const KV_BUCKETS: readonly KvBucketDefinition[] = [
	REGISTRATIONS_KV,
	CHANNELS_KV,
	PRESENCE_KV,
	AGENT_STATE_KV,
	ROUTING_CACHE_KV,
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
	/** `presence`: `<orgId>.<extensionId>`. */
	presence(orgId: string, extensionId: string): string {
		return `${assertKeyToken("orgId", orgId)}.${assertKeyToken("extensionId", extensionId)}`;
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
} as const;

/** Re-exported so a bootstrap can log exactly what it applied without importing two modules. */
export const STREAM_SUBJECT_ROOTS = SUBJECT_ROOTS;
