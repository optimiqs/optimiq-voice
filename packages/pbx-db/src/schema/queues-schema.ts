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
		/**
		 * Whether an agent leaving wrap-up must have chosen one of {@link queueDispositionCode}.
		 *
		 * "Must" is softer than it sounds, and deliberately: the wrap-up deadline still ends the
		 * after-call work with `unset` recorded, because the alternative — holding a seat out of
		 * distribution until somebody clicks — is a queue that empties itself every time an agent
		 * walks away from their desk. What `required` buys is the console insisting, the code being
		 * asked for before the timer runs out, and `unset` in the report meaning "nobody answered the
		 * question" rather than "this queue does not ask it".
		 *
		 * A queue with no disposition codes at all ignores this: there is nothing to pick.
		 */
		dispositionRequired: boolean("disposition_required").notNull().default(false),
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
		/**
		 * RONA — redirect on no answer.
		 *
		 * OFF is the behaviour every queue had before this column: an agent who rings out is put back
		 * in the pool with `noAnswerDelaySeconds` of penalty and is benched only once their
		 * consecutive count reaches `queue_agent.max_no_answer`. That is `mod_callcenter`'s model and
		 * it is the right one for a queue whose agents are at their desks all day.
		 *
		 * ON is the contact-centre model: ONE unanswered offer takes the agent off the floor
		 * immediately, `unavailable` with reason `rona`, and they stay there until a human presses
		 * Resume. The caller is retrieved and offered to the next agent either way — that part is not
		 * new — but the agent who missed them stops being offered anything at all, which is the point:
		 * an empty chair that keeps its turn in the rotation costs every subsequent caller a full ring
		 * timeout, and a supervisor watching the wallboard cannot see the difference between "nobody
		 * has called" and "three people's phones are ringing into an empty room".
		 *
		 * It does not replace `max_no_answer`; it short-circuits it. With RONA on, the count never
		 * gets a chance to reach the ceiling.
		 */
		ronaEnabled: boolean("rona_enabled").notNull().default(false),
		/**
		 * The post-call survey: whether a caller whose agent hangs up is offered the questions in
		 * {@link queueSurveyQuestion}.
		 *
		 * Only the AGENT's hangup leads here, and only on an ANSWERED call. A caller who abandoned the
		 * line, timed out into voicemail or pressed the exit key has already told us what they think of
		 * the wait; asking them to rate an agent they never reached would put noise in the only place
		 * the scores are read. A caller who hangs up first is gone and cannot be asked at all.
		 */
		surveyEnabled: boolean("survey_enabled").notNull().default(false),
		/** "Please stay on the line to rate this call." Played once, before the first question. */
		surveyIntroPromptId: uuidEntityId("survey_intro_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
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
		 * Pause the tap while a caller on this queue is typing digits — the same PCI-DSS 3.4 reflex
		 * the extension carries, armed here because a payments queue is the more natural unit of it.
		 *
		 * A queue is where the tenant already decided "these calls are card calls", and every agent
		 * who ever takes one is a tier member rather than a desk somebody remembered to configure.
		 * Setting it on the queue therefore covers the agents added next month, which per-extension
		 * arming does not.
		 *
		 * `not null default false` for the reason `record_policy` beside it is not nullable: this is
		 * a behaviour with a correct off state, and off is what every queue did before the column.
		 */
		recordAutoPauseOnDtmf: boolean("record_auto_pause_on_dtmf").notNull().default(false),
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
		 * Virtual hold: whether a waiting caller may be offered a callback and keep their place.
		 *
		 * Default OFF, and the reason is the one {@link queue.abandonedResumeAllowed} gives — the held
		 * place is keyed by CALLER NUMBER, so a queue whose callers share a switchboard number would
		 * call one person back and hand another their place. The two features write the SAME
		 * tombstone (`queueResumeTombstoneSchema`); the only difference is who dials, which is why a
		 * caller who rings back before the system reaches them simply claims their own token.
		 */
		callbackEnabled: boolean("callback_enabled").notNull().default(false),
		/**
		 * The digit that accepts the offer. NULL means the offer is announced and cannot be taken,
		 * which is only useful with a prompt that tells the caller to do something else.
		 *
		 * Same one-character rule, same database check and the same reason as {@link queue.exitKey}:
		 * the engine compares it against a `DtmfEvent.digit` with `===`. It may not BE the exit key —
		 * the compiler drops the callback's claim on the digit when it is, because leaving the queue
		 * is the more destructive reading of a keypress.
		 */
		callbackKey: text("callback_key"),
		/** Seconds of waiting after which the offer plays unprompted. 0 means only on the key. */
		callbackOfferAfterSeconds: integer("callback_offer_after_seconds").notNull().default(0),
		/** "Press 1 to keep your place and we will call you back." */
		callbackOfferPromptId: uuidEntityId("callback_offer_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		/** "Thank you — we will call you on this number." Played once the place is held. */
		callbackConfirmPromptId: uuidEntityId("callback_confirm_prompt_id").references(
			() => prompt.id,
			{ onDelete: "set null" },
		),
		/** Attempts before the held place is given up. */
		callbackMaxAttempts: integer("callback_max_attempts").notNull().default(3),
		/** Seconds between a failed attempt and the next. */
		callbackRetryDelaySeconds: integer("callback_retry_delay_seconds").notNull().default(300),
		/** Seconds the held place survives at all, across every attempt. */
		callbackExpiresAfterSeconds: integer("callback_expires_after_seconds").notNull().default(3600),
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
		/** The same shape rule, for the same reason, on the callback's accept digit. */
		check(
			"queue_callback_key_shape_check",
			sql`callback_key is null or callback_key ~ '^[0-9*#A-D]$'`,
		),
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

/**
 * The wrap-up vocabulary one queue offers: "sale", "callback booked", "wrong number".
 *
 * ## Why a table and not an enum or a jsonb array
 *
 * Because the list is the tenant's and it changes on a Tuesday afternoon. An enum would put a
 * migration between a supervisor and a new outcome code; a `text[]` on `queue` would make "how many
 * calls closed as `escalated` last month" a query over an array and would give the code no stable
 * identity, so renaming a label would orphan every report that had already been run. A row has an
 * id, and {@link queueCallDisposition} points at it — the label may be reworded without rewriting
 * history.
 *
 * `code` is the machine-readable half and is unique per queue; `label` is what the agent reads. The
 * two are separate for the same reason they are separate everywhere else on this platform: an
 * operator who renames "Sale" to "Closed — won" has not created a new outcome.
 *
 * `unset` is NOT a row here and must not be created as one. It is what the wrap-up deadline records
 * when nobody chose, and reserving it in the database would let a tenant configure a code whose
 * meaning is "the system gave up".
 */
export const queueDispositionCode = pgTable.withRLS(
	"queue_disposition_code",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueId: uuidEntityId("queue_id")
			.notNull()
			.references(() => queue.id, { onDelete: "cascade" }),
		/** Machine-readable, stable, unique within the queue. Reports group by this. */
		code: text("code").notNull(),
		/** What the agent console shows. Free to change without breaking a report. */
		label: text("label").notNull(),
		/** Order in the console's list. Lowest first; ties fall back to the code. */
		position: integer("position").notNull().default(1),
		/** A retired code stays for the history that references it and stops being offered. */
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_disposition_code_queue_code_key").on(
			table.organizationId,
			table.queueId,
			table.code,
		),
		index("queue_disposition_code_organization_queue_idx").on(
			table.organizationId,
			table.queueId,
			table.position,
		),
		/**
		 * The reserved word, refused in the database rather than only in the DTO: `unset` is what the
		 * engine writes when the wrap-up deadline passed with nobody choosing, and a tenant-defined
		 * code spelled the same way would make "nobody answered the question" and "the agent picked
		 * the code called unset" the same row in every report.
		 */
		check("queue_disposition_code_reserved_check", sql`code <> 'unset'`),
		check("queue_disposition_code_shape_check", sql`code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
		tenantIsolationPolicy("queue_disposition_code"),
	],
);

/**
 * What an agent picked after a queue call — one row per (call, agent).
 *
 * ## Why it is here and not only on the CDR leg
 *
 * It is on both, and each copy answers a different question. `call_legs.queue_disposition_code` is
 * the reporting copy: it lives beside the wait, the talk time and the outcome, so a supervisor's
 * "show me every call that closed as `escalated` and took over four minutes" is one scan of one
 * ledger. This row is the OPERATIONAL copy — it is what the agent console reads back to show what
 * they chose, it carries the `queue_disposition_code` row id (which the ledger cannot, because the
 * ledger holds no `pbx-db` ids beyond the two refs it already has), and it is written first.
 *
 * Written first matters. The disposition is chosen seconds-to-minutes after the leg row was
 * inserted, so the ledger copy is an UPDATE on a row that may still be in flight through the CDR
 * consumer. This table is the durable write; the ledger update is best-effort and idempotent.
 *
 * `codeId` is null exactly when `code` is `unset` — the deadline passed and nobody chose.
 */
export const queueCallDisposition = pgTable.withRLS(
	"queue_call_disposition",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueId: uuidEntityId("queue_id")
			.notNull()
			.references(() => queue.id, { onDelete: "cascade" }),
		queueAgentId: uuidEntityId("queue_agent_id")
			.notNull()
			.references(() => queueAgent.id, { onDelete: "cascade" }),
		/** The call this closes out. A plain uuid: the CDR lives in another database. */
		callId: uuidEntityId("call_id").notNull(),
		/** The chosen row, or NULL when the wrap-up deadline chose for them. */
		codeId: uuidEntityId("code_id").references(() => queueDispositionCode.id, {
			onDelete: "set null",
		}),
		/**
		 * The code AS IT WAS at the moment of choosing — `unset` when nobody did.
		 *
		 * Denormalised on purpose. `codeId` can go to NULL when a supervisor deletes a retired code,
		 * and a history that answered "which code was this?" with a dangling reference would lose the
		 * only fact the row exists to record.
		 */
		code: text("code").notNull(),
		/** Whether the agent chose it, or the deadline did. Separates intent from expiry. */
		auto: boolean("auto").notNull().default(false),
		...auditTimestampColumns(),
	},
	(table) => [
		/** One disposition per (call, agent). A second submission overwrites; it does not append. */
		uniqueIndex("queue_call_disposition_call_agent_key").on(
			table.organizationId,
			table.callId,
			table.queueAgentId,
		),
		index("queue_call_disposition_organization_queue_idx").on(
			table.organizationId,
			table.queueId,
			table.createdAt.desc(),
		),
		index("queue_call_disposition_organization_agent_idx").on(
			table.organizationId,
			table.queueAgentId,
			table.createdAt.desc(),
		),
		tenantIsolationPolicy("queue_call_disposition"),
	],
);

/** The reserved code the wrap-up deadline records when the agent chose nothing. */
export const QUEUE_DISPOSITION_UNSET = "unset";

/**
 * A skill this agent has, and how good they are at it.
 *
 * ## The scale, and why it is 1-5 and not 0-100
 *
 * Because a supervisor has to be able to set it from a dropdown without inventing a rubric, and
 * because the routing only ever asks two questions of it: "does this agent clear the bar?" and "who
 * clears it by the most?". A hundred-point scale answers both no better and invites a floor
 * manager to spend an afternoon deciding whether somebody is a 72 or a 74.
 *
 * `skill` is a free-text tag rather than a foreign key to a skills table. There is no second fact
 * about a skill worth storing — no description, no parent, no expiry — so a table would be a join
 * that exists to hold a string. The shape check keeps the vocabulary from fragmenting into
 * `spanish`, `Spanish` and `spanish `, which is the one failure mode free text actually has here.
 */
export const QUEUE_SKILL_LEVEL_MIN = 1;
export const QUEUE_SKILL_LEVEL_MAX = 5;

export const queueAgentSkill = pgTable.withRLS(
	"queue_agent_skill",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueAgentId: uuidEntityId("queue_agent_id")
			.notNull()
			.references(() => queueAgent.id, { onDelete: "cascade" }),
		skill: text("skill").notNull(),
		level: integer("level").notNull().default(QUEUE_SKILL_LEVEL_MIN),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_agent_skill_agent_skill_key").on(
			table.organizationId,
			table.queueAgentId,
			table.skill,
		),
		index("queue_agent_skill_organization_skill_idx").on(table.organizationId, table.skill),
		check("queue_agent_skill_shape_check", sql`skill ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
		check(
			"queue_agent_skill_level_range_check",
			sql.raw(
				`level between ${String(QUEUE_SKILL_LEVEL_MIN)} and ${String(QUEUE_SKILL_LEVEL_MAX)}`,
			),
		),
		tenantIsolationPolicy("queue_agent_skill"),
	],
);

/**
 * A skill a queue's callers need, and how long the queue insists on it.
 *
 * ## Relaxation is the whole feature
 *
 * A requirement with no relaxation is a filter, and a filter on a small team is a caller who waits
 * for the one German speaker to come back from lunch while four idle agents watch. So every
 * requirement carries `relaxAfterSeconds`: after that much waiting the bar drops by one level, and
 * it keeps dropping on each further interval until it reaches zero and the requirement stops
 * excluding anybody. What survives the relaxation is the ORDER — an agent who still meets the
 * original bar is offered the call before one who only meets the relaxed one, for as long as they
 * are free.
 *
 * `0` disables relaxation and means the requirement is absolute: the caller waits for a qualified
 * agent or times out. That is the right setting for a regulated skill (a licensed adviser) and the
 * wrong one for a preference, which is why it is per requirement and not per queue.
 */
export const queueSkillRequirement = pgTable.withRLS(
	"queue_skill_requirement",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueId: uuidEntityId("queue_id")
			.notNull()
			.references(() => queue.id, { onDelete: "cascade" }),
		skill: text("skill").notNull(),
		/** The level an agent must reach to be offered a caller who has just arrived. */
		minLevel: integer("min_level").notNull().default(QUEUE_SKILL_LEVEL_MIN),
		/** Seconds of waiting per one-level drop in the bar. 0 never relaxes. */
		relaxAfterSeconds: integer("relax_after_seconds").notNull().default(0),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_skill_requirement_queue_skill_key").on(
			table.organizationId,
			table.queueId,
			table.skill,
		),
		check("queue_skill_requirement_shape_check", sql`skill ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
		check(
			"queue_skill_requirement_level_range_check",
			sql.raw(
				`min_level between ${String(QUEUE_SKILL_LEVEL_MIN)} and ${String(QUEUE_SKILL_LEVEL_MAX)}`,
			),
		),
		check("queue_skill_requirement_relax_range_check", sql`relax_after_seconds between 0 and 3600`),
		tenantIsolationPolicy("queue_skill_requirement"),
	],
);

/** A survey is at most this many questions long. Three keypresses is the attention a caller has. */
export const QUEUE_SURVEY_MAX_QUESTIONS = 3;
export const QUEUE_SURVEY_MIN_ANSWER = 1;
export const QUEUE_SURVEY_MAX_ANSWER = 5;

/**
 * One question of a post-call survey: a prompt, and a keypress between 1 and 5.
 *
 * The answer range is fixed rather than configurable. A survey whose scales differ per question —
 * one out of five here, one out of ten there — produces a report nobody can average, and the
 * platform would then owe a per-question scale to every reader of the results. One scale, stated
 * once, and a question that needs a different one is a question for a different channel.
 */
export const queueSurveyQuestion = pgTable.withRLS(
	"queue_survey_question",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueId: uuidEntityId("queue_id")
			.notNull()
			.references(() => queue.id, { onDelete: "cascade" }),
		/** 1, 2 or 3 — the order they are asked in, and the identity a report groups by. */
		position: integer("position").notNull(),
		/** "Press 1 to 5 to rate how well we answered your question." */
		promptId: uuidEntityId("prompt_id").references(() => prompt.id, { onDelete: "set null" }),
		/** For the console and the report. The caller never hears it. */
		label: text("label").notNull(),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_survey_question_queue_position_key").on(
			table.organizationId,
			table.queueId,
			table.position,
		),
		check(
			"queue_survey_question_position_range_check",
			sql.raw(`position between 1 and ${String(QUEUE_SURVEY_MAX_QUESTIONS)}`),
		),
		tenantIsolationPolicy("queue_survey_question"),
	],
);

/**
 * What one caller pressed, for one question, on one call.
 *
 * Append-only in practice and unique per (call, question): a caller who presses twice inside the
 * gather has given one answer, and the engine writes once per question when the gather settles. A
 * question the caller hung up before reaching simply has no row, which is the honest encoding —
 * a stored zero would average into the score as a bad rating rather than as an absence.
 */
export const queueSurveyResponse = pgTable.withRLS(
	"queue_survey_response",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		queueId: uuidEntityId("queue_id")
			.notNull()
			.references(() => queue.id, { onDelete: "cascade" }),
		questionId: uuidEntityId("question_id")
			.notNull()
			.references(() => queueSurveyQuestion.id, { onDelete: "cascade" }),
		/** The call that was surveyed. A plain uuid: the CDR lives in another database. */
		callId: uuidEntityId("call_id").notNull(),
		/** The agent whose call this rates, when the queue distributed it to one. */
		queueAgentId: uuidEntityId("queue_agent_id").references(() => queueAgent.id, {
			onDelete: "set null",
		}),
		/** The digit, 1 to 5. */
		answer: integer("answer").notNull(),
		answeredAt: utcTimestamp("answered_at").notNull(),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("queue_survey_response_call_question_key").on(
			table.organizationId,
			table.callId,
			table.questionId,
		),
		index("queue_survey_response_organization_queue_idx").on(
			table.organizationId,
			table.queueId,
			table.answeredAt.desc(),
		),
		index("queue_survey_response_organization_agent_idx").on(
			table.organizationId,
			table.queueAgentId,
			table.answeredAt.desc(),
		),
		check(
			"queue_survey_response_answer_range_check",
			sql.raw(
				`answer between ${String(QUEUE_SURVEY_MIN_ANSWER)} and ${String(QUEUE_SURVEY_MAX_ANSWER)}`,
			),
		),
		tenantIsolationPolicy("queue_survey_response"),
	],
);
