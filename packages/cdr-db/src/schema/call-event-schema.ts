import { sql } from "drizzle-orm";
import { check, index, jsonb, pgPolicy, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import {
	tenantOrganizationIdColumn,
	tenantOrganizationScope,
	utcTimestamp,
	uuidEntityId,
	uuidV7EntityId,
} from "@optimiq-voice/db";
import { cdrTenantContext } from "../cdr-context";
import { CALL_EVENT_TYPES, type CallEventType } from "./enums";

const tenantScope = tenantOrganizationScope(cdrTenantContext);

/**
 * `call_events` — optional per-leg forensic trail behind the CDR.
 *
 * Deliberately lean: the CDR row is the reporting surface and NATS JetStream is the replayable
 * event log, so this table exists only to answer "what happened inside this leg" after the fact.
 * It is partitioned by RANGE on `at` on the same monthly cadence as `call_legs` and dropped by
 * the same retention sweep, so a partition drop retires a month of legs and their events together.
 *
 * No foreign key to `call_legs`: a reference to a partitioned table must target a unique
 * constraint containing the partition key, which would force `(leg_id, leg_started_at)` onto
 * every row and every insert. The engine writes both tables in one transaction instead.
 */
export const callEvents = pgTable.withRLS(
	"call_events",
	{
		id: uuidV7EntityId("id").notNull(),
		organizationId: tenantOrganizationIdColumn(),
		callId: uuidEntityId("call_id").notNull(),
		legId: uuidEntityId("leg_id").notNull(),
		event: text("event").$type<CallEventType>().notNull(),
		/** Partition key: when the event happened on the channel, not when it was ingested. */
		at: utcTimestamp("at").notNull(),
		data: jsonb("data")
			.notNull()
			.default(sql`'{}'::jsonb`),
	},
	(table) => [
		primaryKey({ name: "call_events_pkey", columns: [table.id, table.at] }),

		index("call_events_organization_at_idx").on(table.organizationId, table.at.desc().nullsLast()),
		index("call_events_leg_idx").on(table.legId, table.at),
		index("call_events_call_idx").on(table.callId),

		check(
			"call_events_event_check",
			sql.raw(`"event" in (${CALL_EVENT_TYPES.map((value) => `'${value}'`).join(", ")})`),
		),

		pgPolicy("call_events_tenant_select", {
			for: "select",
			to: cdrTenantContext.role,
			using: tenantScope,
		}),
		pgPolicy("call_events_tenant_insert", {
			for: "insert",
			to: cdrTenantContext.role,
			withCheck: tenantScope,
		}),
	],
);

export type CallEventRow = typeof callEvents.$inferSelect;
export type NewCallEventRow = typeof callEvents.$inferInsert;
