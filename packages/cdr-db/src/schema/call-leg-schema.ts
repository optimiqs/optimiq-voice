import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgPolicy,
	pgTable,
	primaryKey,
	smallint,
	text,
} from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	tenantOrganizationScope,
	utcTimestamp,
	uuidEntityId,
	uuidV7EntityId,
} from "@optimiq-voice/db";
import { HANGUP_CAUSES, type HangupCause } from "@optimiq-voice/telephony";
import { cdrTenantContext } from "../cdr-context";
import {
	CALL_DESTINATION_TYPES,
	CALL_DIRECTIONS,
	CALL_DISPOSITIONS,
	CALL_LEG_SIDES,
	HANGUP_SIDES,
	QUEUE_OUTCOMES,
	TRANSCRIPTION_STATUSES,
	type CallDestinationType,
	type CallDirection,
	type CallDisposition,
	type CallLegSide,
	type HangupSide,
	type QueueOutcome,
	type TranscriptionStatus,
} from "./enums";

/** `check (col in ('a','b'))` from an `as const` tuple, quoted safely for DDL. */
function inTuple(column: string, values: readonly string[]): ReturnType<typeof sql.raw> {
	return sql.raw(`"${column}" in (${values.map((value) => `'${value}'`).join(", ")})`);
}

const tenantScope = tenantOrganizationScope(cdrTenantContext);

/**
 * `call_legs` — THE CDR table. One row per channel leg; a call is the set of rows sharing
 * `call_id` (A-leg plus every B-leg the engine originated for it).
 *
 * ## Partitioning (drift note — read before editing)
 *
 * The live table is `PARTITION BY RANGE (started_at)` with monthly partitions plus a catch-all
 * default. Drizzle 1.0-rc.4 has no way to declare a partitioned table, so this definition is the
 * LOGICAL shape only and the `PARTITION BY` clause is hand-written into the baseline migration.
 * Two consequences the schema encodes on purpose:
 *
 * 1. The primary key is `(id, started_at)`, not `id`. PostgreSQL requires every unique
 *    constraint on a partitioned table to contain the partition key. Declaring the composite key
 *    here is what keeps `drizzle-kit generate` reporting `no_changes` against the live database.
 * 2. Every index is non-unique for the same reason; uniqueness is enforced by the composite PK.
 *
 * Everything drizzle-kit cannot see (the `PARTITION BY` clause, the partitions themselves, the
 * `cdr_ensure_monthly_partition` / `cdr_drop_partitions_before` functions, the role grants) is
 * pinned by `partitions.spec.ts` and `cdr-partitioning.integration.spec.ts` instead of by the
 * snapshot. See `src/partitions.ts` for the ensure/drop contract.
 *
 * ## Append-only
 *
 * The tenant role holds SELECT + INSERT and exactly two policies; it has no UPDATE or DELETE
 * privilege at all, so a compromised reporting path cannot rewrite billing history. Late-arriving
 * fields (`recording_key`, `mos`, `transcription_status`) are written by the CDR writer through
 * `withCdrWriterScope`, which runs as the schema owner and forces an `organization_id` predicate.
 */
export const callLegs = pgTable.withRLS(
	"call_legs",
	{
		id: uuidV7EntityId("id").notNull(),
		organizationId: tenantOrganizationIdColumn(),

		/** Correlates every leg of one logical call. Generated on the A-leg. */
		callId: uuidEntityId("call_id").notNull(),
		leg: text("leg").$type<CallLegSide>().notNull(),
		/** The leg that originated this one; null on an A-leg. */
		originatingLegId: uuidEntityId("originating_leg_id"),
		/** The leg this one was bridged to, when a bridge was established. */
		bridgeLegId: uuidEntityId("bridge_leg_id"),
		/**
		 * Another CALL this one continues. Null on every leg that continues nothing.
		 *
		 * The two columns above relate legs INSIDE one `call_id`, which is every relationship this
		 * ledger had until virtual hold. A queue callback is a different kind of fact: the platform
		 * rings a customer back minutes after their first call ended, and that is unambiguously a new
		 * call — it has its own answer, its own billing and its own trunk — so reusing the original
		 * `call_id` would put two disjoint conversations under one row's worth of totals and make
		 * every duration in the ledger a sum over time the customer was not on the phone.
		 *
		 * So the link is a column and not a reuse. Deliberately NOT a foreign key and deliberately
		 * not indexed as unique: the call it names may have been retained out from under this one,
		 * and several callbacks can settle one wait.
		 */
		relatedCallId: uuidEntityId("related_call_id"),

		direction: text("direction").$type<CallDirection>().notNull(),
		sipCallId: text("sip_call_id"),

		fromNumber: text("from_number").notNull(),
		fromName: text("from_name"),
		toNumber: text("to_number").notNull(),

		/** What the routing decision resolved to, and the pbx-db entity it resolved to. */
		destinationType: text("destination_type").$type<CallDestinationType>().notNull(),
		destinationRef: uuidEntityId("destination_ref"),

		/** Named routing namespace the leg executed in (the FreeSWITCH "context" security boundary). */
		routingContext: text("routing_context"),
		/** Voice application / autopilot assistant that handled the leg. */
		applicationRef: uuidEntityId("application_ref"),
		/**
		 * The queue this leg reached, and what happened to the caller in it.
		 *
		 * `queue_ref` predates the rest by a wave and was never written by anything — the routing
		 * walk set `destination_type = 'queue'` and `destination_ref = <queueId>` and stopped there,
		 * which is enough to find a queue's calls and not enough to report on them. The three columns
		 * below are what turn "this call went to a queue" into a service-level answer, and the writer
		 * now fills all four.
		 *
		 * All four are nullable and stay NULL on every leg that never touched a queue, which is most
		 * of them. That is the domain rather than an omission: a `queue_wait_ms` of 0 on a direct
		 * extension call would be a zero that every average then includes, and an average hold time
		 * computed over a tenant's whole traffic is wrong in a direction nobody notices.
		 */
		queueRef: uuidEntityId("queue_ref"),
		/** Joining the line to leaving it. Excludes the agent's ring time — see the event schema. */
		queueWaitMs: integer("queue_wait_ms"),
		queueOutcome: text("queue_outcome").$type<QueueOutcome>(),
		/**
		 * The `queue_agent` who took the call. Set only when `queue_outcome = 'answered'`.
		 *
		 * A queue-agent row id and NOT a user id: this database holds no user ids at all, and this
		 * column does not change that. Which person sat in that seat is resolvable through
		 * `queue_agent` in `pbx-db` by whoever is allowed to see it.
		 */
		queueAgentRef: uuidEntityId("queue_agent_ref"),
		/**
		 * Which authorisation code opened the outbound route this call took.
		 *
		 * Two columns and not one, and NEITHER of them is the digits. A PIN on an outbound route is a
		 * spending control, so the question the ledger has to answer is "who authorised this call to
		 * Paraguay" — and the answer a tenant recognises is the ordinal and the label they typed into
		 * a form ("code 3, the night desk"), not a secret. Storing the code itself would make this
		 * table the best place on the platform to go looking for one to reuse, which is the entire
		 * reason `pin_set_entry` stores a scrypt digest and never the plaintext upstream kept.
		 *
		 * The LABEL is denormalised rather than joined, for the reason `account_code` is a text column:
		 * this database holds no `pin_set` rows to join against, and a label that changed in `pbx-db`
		 * six months after the call must not retroactively rewrite what the call record says.
		 *
		 * Null on every call that took no gated route, which is nearly all of them.
		 */
		authPinOrdinal: integer("auth_pin_ordinal"),
		authPinLabel: text("auth_pin_label"),
		/**
		 * What the carrier said about the calling number's attestation, on an inbound trunk leg.
		 *
		 * Visibility only. Nothing here was signed by this platform and nothing here was verified by
		 * it: the carrier verifies and states the outcome in `P-Asserted-Identity`, `verstat` and
		 * `Identity` headers, and the SIP edge carries the claim forward. These columns are therefore
		 * never an authorisation — no routing decision reads them, and a `tn-validation-failed` call
		 * is on the ledger because it was placed, not because it was allowed.
		 *
		 * They are on the ledger and not in a log because of WHEN the question is asked: "was the
		 * number on this call attested" comes up months later, about a call somebody has already
		 * found, in a dispute or a traceback — `orig_id` is the originating provider's opaque call
		 * identifier and is exactly what a traceback is keyed on. A log with a retention window
		 * cannot answer that.
		 *
		 * `sip_verstat` is free text on purpose: the parameter is carrier-writable, and an
		 * unrecognised value must reach a record rather than fail an INVITE. The `Identity` JWS
		 * itself is deliberately not stored — multi-kilobyte, unverified here, and a field nobody
		 * checks that looks like proof is worse than no field.
		 *
		 * Null on every internal leg and on every trunk call that arrived without the headers, which
		 * is most of them.
		 */
		sipAttestation: text("sip_attestation"),
		sipVerstat: text("sip_verstat"),
		sipOrigId: text("sip_orig_id"),
		ivrRef: uuidEntityId("ivr_ref"),
		ringGroupRef: uuidEntityId("ring_group_ref"),
		/** Billing tag carried from the extension or trunk. */
		accountCode: text("account_code"),

		/** Partition key. Never nullable, never updated. */
		startedAt: utcTimestamp("started_at").notNull(),
		answeredAt: utcTimestamp("answered_at"),
		endedAt: utcTimestamp("ended_at"),

		/** Wall-clock leg length. */
		durationMs: integer("duration_ms").notNull().default(0),
		/** Billable length: answer → hangup. Zero on unanswered legs. */
		billsecMs: integer("billsec_ms").notNull().default(0),
		/** Post-dial delay: origination → first progress. */
		pddMs: integer("pdd_ms"),

		hangupCause: text("hangup_cause").$type<HangupCause>().notNull().default("NONE"),
		/**
		 * Numeric Q.850 / extended code. Kept alongside the name so a carrier cause we do not name
		 * still survives the round trip (name falls back to `NORMAL_UNSPECIFIED`).
		 */
		hangupCauseCode: smallint("hangup_cause_code").notNull().default(0),
		hangupSide: text("hangup_side").$type<HangupSide>(),
		disposition: text("disposition").$type<CallDisposition>().notNull(),

		readCodec: text("read_codec"),
		writeCodec: text("write_codec"),
		remoteMediaAddress: text("remote_media_address"),

		/** Media quality, reported on hangup. Late-arriving on legs the media plane reports async. */
		mos: numeric("mos", { precision: 4, scale: 2, mode: "number" }),
		jitterMs: numeric("jitter_ms", { precision: 8, scale: 2, mode: "number" }),
		packetLossPct: numeric("packet_loss_pct", { precision: 5, scale: 2, mode: "number" }),

		/** S3 object key; joins to `recordings.object_key`. Null until a recording is finalized. */
		recordingKey: text("recording_key"),
		transcriptionStatus: text("transcription_status")
			.$type<TranscriptionStatus>()
			.notNull()
			.default("none"),

		/**
		 * Everything the ~90-column FusionPBX CDR carried that does not earn a column: channel
		 * variables, call-flow array, per-queue satellite block, conference block, SIP disposition.
		 */
		raw: jsonb("raw")
			.notNull()
			.default(sql`'{}'::jsonb`),

		createdAt: auditTimestampColumns().createdAt,
	},
	(table) => [
		primaryKey({ name: "call_legs_pkey", columns: [table.id, table.startedAt] }),

		// Reporting default: one organization's legs, newest first.
		index("call_legs_organization_started_idx").on(
			table.organizationId,
			table.startedAt.desc().nullsLast(),
		),
		// Leg correlation: assemble a whole call from any leg.
		index("call_legs_call_idx").on(table.callId),
		// Sparse: the column is null on all but the callback legs, so the index is the size of the
		// feature rather than of the table.
		index("call_legs_related_call_idx")
			.on(table.relatedCallId)
			.where(sql`${table.relatedCallId} is not null`),
		index("call_legs_organization_from_idx").on(table.organizationId, table.fromNumber),
		index("call_legs_organization_to_idx").on(table.organizationId, table.toNumber),
		// Recording browser + retention sweep only ever look at legs that produced media.
		index("call_legs_recording_idx")
			.on(table.organizationId, table.startedAt.desc().nullsLast())
			.where(sql`recording_key is not null`),

		check("call_legs_leg_check", inTuple("leg", CALL_LEG_SIDES)),
		check("call_legs_direction_check", inTuple("direction", CALL_DIRECTIONS)),
		check("call_legs_destination_type_check", inTuple("destination_type", CALL_DESTINATION_TYPES)),
		check("call_legs_hangup_cause_check", inTuple("hangup_cause", HANGUP_CAUSES)),
		// Nullable columns need no `is null` branch: `null in (...)` is UNKNOWN, which a CHECK accepts.
		check("call_legs_hangup_side_check", inTuple("hangup_side", HANGUP_SIDES)),
		check("call_legs_disposition_check", inTuple("disposition", CALL_DISPOSITIONS)),
		check(
			"call_legs_transcription_status_check",
			inTuple("transcription_status", TRANSCRIPTION_STATUSES),
		),
		check("call_legs_duration_check", sql`"duration_ms" >= 0 and "billsec_ms" >= 0`),
		check("call_legs_queue_outcome_check", inTuple("queue_outcome", QUEUE_OUTCOMES)),
		check("call_legs_queue_wait_check", sql`"queue_wait_ms" is null or "queue_wait_ms" >= 0`),
		/**
		 * The index the queue-statistics query runs on.
		 *
		 * Partial, on `queue_outcome is not null`, for the reason `call_legs_recording_idx` is partial
		 * on `recording_key is not null`: the rows it serves are a small fraction of a tenant's
		 * traffic, and an index over every leg would be paid for on every insert by every call that
		 * never went near a queue. The column order is the query's: one organization, one queue, a
		 * time window — which is also what lets the planner prune partitions before it reads a page.
		 */
		index("call_legs_queue_idx")
			.on(table.organizationId, table.queueRef, table.startedAt.desc().nullsLast())
			.where(sql`queue_outcome is not null`),
		/**
		 * The index the per-AGENT statistics query runs on.
		 *
		 * A second partial index over the queue traffic and not a reuse of `call_legs_queue_idx`,
		 * which is the kind of duplication worth justifying rather than assuming. The agent report's
		 * predicate is `queue_agent_ref is not null` — a strict subset of the queue index's rows,
		 * since only an ANSWERED queue leg names a seat — and its second key is the agent. On the
		 * queue index the agent is not a key at all, so "how did this one agent do today" would be a
		 * scan of every queued call in the window; here it is a seek. It also carries the window
		 * function's ordering column in the right place, which is what keeps the `lead()` over an
		 * agent's calls from needing a sort per partition.
		 *
		 * The insert cost is paid only by legs an agent answered, which on any real tenant is a small
		 * fraction of the ledger — the same argument `call_legs_recording_idx` and the queue index
		 * both make, and the reason neither of them is a full index.
		 */
		index("call_legs_queue_agent_idx")
			.on(table.organizationId, table.queueAgentRef, table.startedAt.desc().nullsLast())
			.where(sql`queue_agent_ref is not null`),

		// Append-only ledger: SELECT + INSERT, two policies, no UPDATE/DELETE for the tenant role.
		pgPolicy("call_legs_tenant_select", {
			for: "select",
			to: cdrTenantContext.role,
			using: tenantScope,
		}),
		pgPolicy("call_legs_tenant_insert", {
			for: "insert",
			to: cdrTenantContext.role,
			withCheck: tenantScope,
		}),
	],
);

export type CallLegRow = typeof callLegs.$inferSelect;
export type NewCallLegRow = typeof callLegs.$inferInsert;
