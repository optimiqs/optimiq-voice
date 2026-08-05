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
import { cdrTenantContext } from "../cdr-context";
import { HANGUP_CAUSES } from "../hangup-causes";
import {
	CALL_DESTINATION_TYPES,
	CALL_DIRECTIONS,
	CALL_DISPOSITIONS,
	CALL_LEG_SIDES,
	HANGUP_SIDES,
	TRANSCRIPTION_STATUSES,
	type CallDestinationType,
	type CallDirection,
	type CallDisposition,
	type CallLegSide,
	type HangupSide,
	type TranscriptionStatus,
} from "./enums";
import type { HangupCause } from "../hangup-causes";

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
		queueRef: uuidEntityId("queue_ref"),
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
