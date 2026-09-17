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
		 * The wrap-up code the agent chose for this call — `sale`, `escalated`, `unset`.
		 *
		 * The CODE and not the `queue_disposition_code` row id, for the reason `pin_label` beside it
		 * is a label and not a foreign key: this database holds no `pbx-db` ids beyond the two refs
		 * above, and a code reworded or retired in `pbx-db` six months later must not retroactively
		 * rewrite what this call closed as. `pbx-db`'s `queue_call_disposition` keeps the id and is
		 * the operational copy the console reads back; this is the reporting copy, and it is here so
		 * that "every call that closed as escalated and took over four minutes" is one scan of one
		 * ledger rather than a join across two databases.
		 *
		 * `unset` is a real value and means the wrap-up deadline passed with nobody choosing. NULL
		 * means the queue asks no such question, or the leg never touched a queue at all — which is
		 * most legs. The two are not the same fact and a default would have merged them.
		 *
		 * Written by an UPDATE after the leg row exists, and best-effort: the durable write is the
		 * `pbx-db` row. A leg still in flight through the CDR consumer when the agent picks a code
		 * simply keeps its NULL, and the report reads `unset`-like rather than wrong.
		 */
		queueDispositionCode: text("queue_disposition_code"),
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
		/**
		 * What THIS platform decided the outbound call was entitled to assert, and what backed it.
		 *
		 * The mirror image of the three columns above, and the distinction is the entire point of
		 * having both. `sip_attestation` is what somebody else SAID about an inbound call and is
		 * visibility only. `expected_attestation` is what we DECIDED about an outbound one — the
		 * April 2026 FNPRM makes that decision the end-user provider's regardless of who holds the
		 * signing certificate, so the reasoning has to be on our ledger and not only in the carrier's.
		 *
		 * `caller_id_right_to_use` is the fact the level was derived from: `owned` (a DID this
		 * platform assigned, which is the A criterion), `verified` (an external number with a
		 * documented verification, which is B), or NULL for a number nobody vouched for, which is C.
		 * Two columns rather than one because an enforcement inquiry asks both questions — "what did
		 * you assert" and "on what basis" — and a level with no basis recorded is the answer that
		 * makes the inquiry longer.
		 *
		 * NULL on every inbound leg and on every leg written before the decision seam existed. No
		 * check constraint, for the same reason the three columns above carry none: this table is
		 * append-only and partitioned, a rejected insert is a call record that is simply gone, and a
		 * value a newer engine writes into an older schema during a rolling deploy must reach a row
		 * and read as unknown later rather than lose the leg.
		 */
		expectedAttestation: text("expected_attestation"),
		callerIdRightToUse: text("caller_id_right_to_use"),
		/**
		 * The trunk the leg used, and the signalling peer at the other end of it.
		 *
		 * Both exist for the traceback, and neither is derivable from what was already here. A
		 * traceback request names a number and a time window and asks who handed the call over; the
		 * answer is a trunk and an IP, and until these columns existed answering it meant correlating
		 * the ledger against sipd's logs by `sip_call_id` inside whatever retention window those logs
		 * happened to have. The 24-hour clock is not a forensics budget.
		 *
		 * `trunk_ref` is a `pbx-db` id and, like every other `*_ref` on this table, is not a foreign
		 * key — this database holds no `pbx-db` rows to point at. `signaling_address` is text and not
		 * `inet` because it carries a port as often as not and because a malformed value from a peer
		 * must reach a row rather than fail the insert.
		 */
		trunkRef: uuidEntityId("trunk_ref"),
		signalingAddress: text("signaling_address"),
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

		/**
		 * The consent outcome for this leg, flattened out of the record `recordings.consent` holds
		 * whole.
		 *
		 * Flattened here and not `jsonb`, because the two tables are asked different questions. A
		 * recording is looked at one at a time and its consent read whole; legs are aggregated —
		 * "how many calls last quarter were recorded after a declined consent", which is a `where`
		 * over millions of partitioned rows and wants a column, not a `->>`.
		 *
		 * And it lives on the leg even when no recording does: a `declined` outcome means the tap
		 * never opened, so there is no `recordings` row to carry it, and the ONLY durable trace that
		 * the tenant asked and the caller said no is this leg. Dropping it would make a refusal
		 * indistinguishable from a call nobody tried to record.
		 *
		 * No check constraints on any of the four, deliberately, and unlike every other value domain
		 * on this table. `call_legs` is append-only and partitioned: a write that fails is a call
		 * record that is simply gone, with no reconciliation path back to a hangup that happened
		 * once. A consent outcome this build has never heard of — added by a newer engine writing
		 * into an older schema during a rolling deploy — must reach a row and be read as unknown
		 * later, rather than reject the whole leg. The vocabulary is enforced where it can be
		 * enforced safely: on the configuration columns in `pbx-db`, and in the event schema.
		 */
		recordingConsent: text("recording_consent"),
		/** How the outcome was reached: announcement, keypress, or none. See above for why untyped. */
		recordingConsentMethod: text("recording_consent_method"),
		/** When the outcome was decided, which is at recording-start and not at leg write. */
		recordingConsentAt: utcTimestamp("recording_consent_at"),
		/**
		 * The jurisdictions that forced all-party treatment on this call, as ISO 3166-2 / `EU`
		 * strings. `jsonb` rather than `text[]`: it is a short list read whole with the row, and it
		 * is the one of the four that is genuinely open-ended.
		 */
		recordingConsentRegions: jsonb("recording_consent_regions").$type<string[]>(),
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

		/**
		 * The three indexes a traceback runs on, and the only ones on this table that do NOT lead
		 * with `organization_id`.
		 *
		 * That is the whole reason they exist. Every other index here is shaped around a tenant
		 * asking about its own calls, and the question an Industry Traceback Group request asks is
		 * the opposite one: "who, anywhere on this platform, placed a call to +1-212-555-0100 between
		 * 14:00 and 15:00 last Tuesday?" — asked by a platform operator who is not inside any tenant
		 * and cannot be. Against `call_legs_organization_to_idx` that degrades to a scan of every
		 * partition in the window; leading on the number instead makes it a seek per partition, with
		 * `started_at` second so the range narrows inside the bucket without a sort.
		 *
		 * The FCC has already enforced this clock — a September 2025 group order against twelve
		 * providers who certified a 24-hour traceback response and missed it — which is the argument
		 * for paying the insert cost on every leg rather than making these partial. There is no
		 * predicate that would make them smaller anyway: a traceback can name any number on the
		 * platform, so the rows they must serve are all of them.
		 *
		 * `call_legs_trunk_idx` IS partial, because it can be: only a leg that crossed a carrier
		 * names a trunk, and "which calls came in over this trunk" is asked about the handover point
		 * rather than about a tenant.
		 */
		index("call_legs_traceback_to_idx").on(table.toNumber, table.startedAt.desc().nullsLast()),
		index("call_legs_traceback_from_idx").on(table.fromNumber, table.startedAt.desc().nullsLast()),
		index("call_legs_trunk_idx")
			.on(table.trunkRef, table.startedAt.desc().nullsLast())
			.where(sql`trunk_ref is not null`),

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
