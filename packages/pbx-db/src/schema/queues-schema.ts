import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, namedDestinationColumns } from "./columns";
import { extension, type RecordPolicy } from "./extensions-schema";
import { mohClass, prompt } from "./media-schema";

/**
 * Queues / ACD, modelled on `mod_callcenter`. FusionPBX's queue table has ~40 columns; the ones
 * dropped here are either UI-only (`record_template`) or superseded by the prompt library — the
 * exit-key SOUND paths among them, because an exit key's announcement is a `prompt` row like every
 * other piece of audio on this platform, reached through the destination it points at. Agent
 * *presence* is live state in NATS KV — `queue_agent.status` is the persisted last-known value so a
 * wallboard can render before the KV watch warms up.
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

/**
 * The caller-priority scale, shared by the queue's default and by an IVR's per-entry override.
 *
 * 0-1000 because that is what `queue.caller.joined` already published on
 * (`queueCallerJoinedDataSchema.priority`) back when the engine had nothing to put there and
 * reported a constant 0. Reusing the event's range rather than inventing a second one means a
 * wallboard never has to rescale, and 0 keeps meaning exactly what it meant before: unprioritised.
 *
 * Higher wins. That direction is the one every `mod_callcenter` deployment and every FusionPBX
 * import already assumes, and inverting it here would silently reverse every migrated queue.
 */
export const QUEUE_PRIORITY_MIN = 0;
export const QUEUE_PRIORITY_MAX = 1000;

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
		/**
		 * Whisper-on-answer: played to the ANSWERING AGENT alone, before the caller is bridged in.
		 *
		 * The announcement that tells an agent which queue the call came from — "Sales" — in the
		 * second between them lifting the handset and saying hello. An agent staffing four queues
		 * otherwise has to guess which script to open with, and guessing wrong in front of the
		 * customer is the failure this exists to prevent.
		 *
		 * It is played to the agent leg ALONE and the caller hears nothing, which is the whole point:
		 * a caller who heard "call from Sales queue" would be listening to the agent's cue sheet, and
		 * the illusion that they reached a person rather than a routing table would be over. That is
		 * why this is a separate column from `greetingPromptId` and `announcePromptId`, both of which
		 * play to the caller — same media library, opposite side of the bridge.
		 *
		 * `set null` on delete, like every other prompt reference here: deleting a prompt should cost
		 * a queue its whisper, not cost the tenant the queue.
		 */
		agentWhisperPromptId: uuidEntityId("agent_whisper_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		maxWaitSeconds: integer("max_wait_seconds").notNull().default(0),
		/** Eject callers this fast when no agent is logged in at all. 0 disables. */
		maxWaitNoAgentSeconds: integer("max_wait_no_agent_seconds").notNull().default(0),
		wrapUpSeconds: integer("wrap_up_seconds").notNull().default(10),
		announcePositionEnabled: boolean("announce_position_enabled").notNull().default(false),
		announceFrequencySeconds: integer("announce_frequency_seconds").notNull().default(60),
		/**
		 * A caller who hung up may keep their place if they call back within this window.
		 *
		 * Default OFF, and it should stay off for most queues: the promise is keyed by CALLER NUMBER
		 * (see `queueResumeTombstoneSchema`), so a switchboard, a call box or any shared line that
		 * presents one number for many people would hand the second caller the first one's place. On a
		 * queue whose callers are individuals it is the difference between "I lost my place because
		 * the train went into a tunnel" and not.
		 */
		abandonedResumeAllowed: boolean("abandoned_resume_allowed").notNull().default(false),
		/** How long the abandoned caller's place is held for them. Also the tombstone's TTL. */
		discardAbandonedAfterSeconds: integer("discard_abandoned_after_seconds").notNull().default(60),
		tierRulesApply: boolean("tier_rules_apply").notNull().default(true),
		tierRuleWaitSeconds: integer("tier_rule_wait_seconds").notNull().default(30),
		tierRuleNoAgentNoWait: boolean("tier_rule_no_agent_no_wait").notNull().default(false),
		/**
		 * When the engine records a call this queue distributed — the SAME vocabulary `extension`
		 * and `trunk` already use, not a second boolean.
		 *
		 * This replaced a `record_enabled` boolean that no runtime honoured (the engine read it only
		 * to write a note on the walk saying it did not). A boolean would have had to grow into this
		 * enum the moment anybody asked "record the agent's outbound callbacks too?", and two spellings
		 * of one policy is how a tenant ends up with a queue that records and an extension that does
		 * not for reasons nobody can reconstruct.
		 *
		 * A queued call is INBOUND from the queue's point of view whichever direction the leg that
		 * reached the queue was travelling: the caller waited and an agent took them. So `inbound` and
		 * `all` both record here, `outbound` never does, and `on-demand` means the agent starts it by
		 * hand with the record-toggle feature code. The recording begins at the ANSWER, not at the
		 * join, because the hold music is not evidence of anything and recording it would put every
		 * abandoned call in the retention bucket.
		 */
		recordPolicy: text("record_policy").$type<RecordPolicy>().notNull().default("none"),
		/**
		 * The single DTMF digit a WAITING caller may press to leave the line — `mod_callcenter`'s
		 * exit key, and FusionPBX's `queue_exit_key_*`.
		 *
		 * One character, because that is the whole feature: a caller who has been on hold for four
		 * minutes is not going to type a string, and a multi-digit code would need an inter-digit
		 * timeout running underneath the hold music for the entire wait. NULL disables it, which is
		 * what every queue did before this column existed.
		 *
		 * The destination trio below is where they go. It is a full trio rather than a hard-wired
		 * "voicemail" because the useful answers differ per tenant: an overflow queue, the operator,
		 * a callback IVR, and — most often — the queue's own voicemail box.
		 */
		exitKey: text("exit_key"),
		/** Taken when a waiting caller presses {@link queue.exitKey}. */
		...namedDestinationColumns("exit"),
		/**
		 * The priority every caller entering this queue starts with, unless the destination that sent
		 * them overrode it (`destination_data.args.priority` on a `queue` destination — an IVR option
		 * saying "press 2 if you are a platinum customer" is exactly that).
		 *
		 * Higher dequeues first. See {@link QUEUE_PRIORITY_MIN} for the scale and
		 * `apps/engine/src/queue/queue-waiting.ts` for the starvation stance that comes with it.
		 */
		defaultPriority: integer("default_priority").notNull().default(QUEUE_PRIORITY_MIN),
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
		destinationCheck("queue", "exit", true),
		/**
		 * One digit, and one of the sixteen a phone can actually send.
		 *
		 * Enforced in the database rather than only in the DTO because the engine compares this
		 * against a `DtmfEvent.digit` with `===`: a row holding `"1 "` or `"one"` would produce a
		 * queue whose exit key silently never fires, and the operator would have configured a feature
		 * that does nothing. A NULL passes — that is how the column spells "disabled".
		 */
		check("queue_exit_key_shape_check", sql`exit_key is null or exit_key ~ '^[0-9*#A-D]$'`),
		check(
			"queue_default_priority_range_check",
			sql.raw(
				`default_priority between ${String(QUEUE_PRIORITY_MIN)} and ${String(QUEUE_PRIORITY_MAX)}`,
			),
		),
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
		/**
		 * Played to the AGENT alone when a call distributed by THIS tier reaches them, in place of the
		 * queue's `agent_whisper_prompt_id`.
		 *
		 * ## What FusionPBX means by a tier, and what it does not
		 *
		 * Worth being exact, because the name invites a wrong assumption. In `mod_callcenter` — and in
		 * FusionPBX's `v_call_center_tiers`, which is a thin wrapper over it — a tier is nothing but
		 * `(agent, queue, level, position)`. It carries no media of its own. The announcements
		 * FusionPBX ships are the QUEUE's (`queue-announce-sound`, played to the caller) and the
		 * AGENT's status prompts; there has never been a per-tier sound file anywhere in that lineage.
		 *
		 * So this column is ours, and it is worth saying so rather than implying a parity gap that
		 * never existed. What makes it earn its place is what a level already means here: level 2 is
		 * reached only after `tier_rule_wait_seconds` has elapsed with level 1 unable to take the call.
		 * An agent on that level therefore knows something about the call the moment their phone
		 * rings — it escalated — and that is exactly the kind of fact the W6 whisper machinery exists to
		 * put in their ear before they say hello. "Overflow from Sales, this caller has already waited"
		 * is a different opening than "Sales".
		 *
		 * NULL — the normal state — falls back to the queue's whisper, so a tenant who never touches
		 * this gets precisely the behaviour they had before the column existed.
		 */
		announcePromptId: uuidEntityId("announce_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
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
