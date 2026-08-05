import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, namedDestinationColumns } from "./columns";
import { extension } from "./extensions-schema";
import { mohClass, prompt } from "./media-schema";

/**
 * Queues / ACD, modelled on `mod_callcenter`. FusionPBX's queue table has ~40 columns; the ones
 * dropped here are either UI-only (`record_template`, exit-key sound paths) or superseded by the
 * prompt library. Agent *presence* is live state in NATS KV — `queue_agent.status` is the
 * persisted last-known value so a wallboard can render before the KV watch warms up.
 */

export const QUEUE_STRATEGIES = [
	"longest-idle",
	"ring-all",
	"round-robin",
	"top-down",
	"sequential",
	"random",
] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];

export const QUEUE_AGENT_STATUSES = [
	"logged-out",
	"available",
	"on-break",
	"on-call",
	"wrap-up",
	"unavailable",
] as const;
export type QueueAgentStatus = (typeof QUEUE_AGENT_STATUSES)[number];

/** How the engine reaches an agent. `extension` is the common case; `external` dials a number. */
export const QUEUE_AGENT_CONTACT_KINDS = ["extension", "external"] as const;
export type QueueAgentContactKind = (typeof QUEUE_AGENT_CONTACT_KINDS)[number];

export const queue = pgTable.withRLS(
	"queue",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		extensionNumber: text("extension_number"),
		strategy: text("strategy").$type<QueueStrategy>().notNull().default("longest-idle"),
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "set null",
		}),
		greetingPromptId: uuidEntityId("greeting_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		announcePromptId: uuidEntityId("announce_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		maxWaitSeconds: integer("max_wait_seconds").notNull().default(0),
		/** Eject callers this fast when no agent is logged in at all. 0 disables. */
		maxWaitNoAgentSeconds: integer("max_wait_no_agent_seconds").notNull().default(0),
		wrapUpSeconds: integer("wrap_up_seconds").notNull().default(10),
		announcePositionEnabled: boolean("announce_position_enabled").notNull().default(false),
		announceFrequencySeconds: integer("announce_frequency_seconds").notNull().default(60),
		/** A caller who hung up may keep their place if they call back within this window. */
		abandonedResumeAllowed: boolean("abandoned_resume_allowed").notNull().default(false),
		discardAbandonedAfterSeconds: integer("discard_abandoned_after_seconds").notNull().default(60),
		tierRulesApply: boolean("tier_rules_apply").notNull().default(true),
		tierRuleWaitSeconds: integer("tier_rule_wait_seconds").notNull().default(30),
		tierRuleNoAgentNoWait: boolean("tier_rule_no_agent_no_wait").notNull().default(false),
		recordEnabled: boolean("record_enabled").notNull().default(false),
		/** Taken on `maxWaitSeconds` / `maxWaitNoAgentSeconds` expiry. */
		...namedDestinationColumns("timeout"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("queue_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		index("queue_organization_enabled_idx").on(table.organizationId, table.enabled),
		destinationCheck("queue", "timeout", true),
		tenantIsolationPolicy("queue"),
	],
);

export const queueAgent = pgTable.withRLS(
	"queue_agent",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/** `user.id` in the auth database. Plain UUID: no cross-database foreign keys. */
		userId: uuidEntityId("user_id"),
		contactKind: text("contact_kind").$type<QueueAgentContactKind>().notNull().default("extension"),
		extensionId: uuidEntityId("extension_id").references(() => extension.id, {
			onDelete: "set null",
		}),
		/** Dial string when `contactKind = "external"`. */
		contact: text("contact"),
		status: text("status").$type<QueueAgentStatus>().notNull().default("logged-out"),
		statusChangedAt: utcTimestamp("status_changed_at"),
		wrapUpSeconds: integer("wrap_up_seconds").notNull().default(10),
		maxNoAnswer: integer("max_no_answer").notNull().default(3),
		noAnswerDelaySeconds: integer("no_answer_delay_seconds").notNull().default(30),
		busyDelaySeconds: integer("busy_delay_seconds").notNull().default(60),
		rejectDelaySeconds: integer("reject_delay_seconds").notNull().default(60),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_agent_organization_name_key").on(table.organizationId, table.name),
		index("queue_agent_organization_status_idx").on(table.organizationId, table.status),
		index("queue_agent_organization_user_idx").on(table.organizationId, table.userId),
		index("queue_agent_organization_extension_idx").on(table.organizationId, table.extensionId),
		tenantIsolationPolicy("queue_agent"),
	],
);

/** Agent × queue membership. `level` is the ring tier; `position` orders agents within a tier. */
export const queueTier = pgTable.withRLS(
	"queue_tier",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueId: uuidEntityId("queue_id")
			.notNull()
			.references(() => queue.id, { onDelete: "cascade" }),
		queueAgentId: uuidEntityId("queue_agent_id")
			.notNull()
			.references(() => queueAgent.id, { onDelete: "cascade" }),
		level: integer("level").notNull().default(1),
		position: integer("position").notNull().default(1),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_tier_organization_queue_agent_key").on(
			table.organizationId,
			table.queueId,
			table.queueAgentId,
		),
		index("queue_tier_organization_queue_level_idx").on(
			table.organizationId,
			table.queueId,
			table.level,
			table.position,
		),
		index("queue_tier_organization_agent_idx").on(table.organizationId, table.queueAgentId),
		tenantIsolationPolicy("queue_tier"),
	],
);
