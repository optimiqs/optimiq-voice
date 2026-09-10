import { queueMembershipSchema } from "@optimiq-voice/events/schemas";
import type {
	QueueAgentSkill,
	QueueDispositionCodeEntry,
	QueueMembership,
	QueueMembershipAgent,
	QueueSkillRequirement,
	QueueSurveyPlan,
} from "@optimiq-voice/events/schemas";

/**
 * The pure half of the `queue-membership` publisher: three tables in, one roster per queue out.
 *
 * Separated from the NATS half so the interesting decisions — how a dial string is derived, what
 * happens to an agent whose extension was deleted, what the engine is told about a disabled seat —
 * are testable without a broker, a database or a Nest container. `queue-membership.publisher.ts`
 * does the reading and the writing and makes none of these decisions.
 */

/** One `queue` row, as far as the roster is concerned. */
export interface QueueRosterQueueRow {
	readonly id: string;
	readonly name: string;
	readonly wrapUpSeconds: number;
	readonly tierRulesApply: boolean;
	readonly tierRuleWaitSeconds: number;
	readonly tierRuleNoAgentNoWait: boolean;
	readonly ronaEnabled: boolean;
	readonly dispositionRequired: boolean;
	readonly surveyEnabled: boolean;
	readonly surveyIntroPromptId: string | null;
}

/** One `queue_disposition_code` row. Disabled codes are filtered out before this. */
export interface QueueRosterDispositionCodeRow {
	readonly queueId: string;
	readonly id: string;
	readonly code: string;
	readonly label: string;
	readonly position: number;
}

/** One `queue_skill_requirement` row. */
export interface QueueRosterSkillRequirementRow {
	readonly queueId: string;
	readonly skill: string;
	readonly minLevel: number;
	readonly relaxAfterSeconds: number;
}

/** One `queue_survey_question` row. Carried only when the queue has the survey switched on. */
export interface QueueRosterSurveyQuestionRow {
	readonly queueId: string;
	readonly id: string;
	readonly position: number;
	readonly promptId: string | null;
	readonly label: string;
}

/** One `queue_agent_skill` row, keyed by the AGENT — it travels on the seat, not on the queue. */
export interface QueueRosterAgentSkillRow {
	readonly queueAgentId: string;
	readonly skill: string;
	readonly level: number;
}

/** One `queue_tier` row joined to its `queue_agent`, plus the agent's extension number. */
export interface QueueRosterTierRow {
	readonly queueId: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly contactKind: string;
	/** `queue_agent.contact` — the dial string for an `external` agent. */
	readonly contact: string | null;
	readonly extensionId: string | null;
	/** `extension.number`, resolved by the join. Null when the agent has no extension. */
	readonly extensionNumber: string | null;
	readonly level: number;
	readonly position: number;
	/** `queue_tier.announce_prompt_id` — the agent-side prompt for THIS tier. */
	readonly announcePromptId: string | null;
	readonly wrapUpSeconds: number;
	readonly maxNoAnswer: number;
	readonly noAnswerDelaySeconds: number;
	readonly busyDelaySeconds: number;
	readonly rejectDelaySeconds: number;
	readonly enabled: boolean;
	/** `queue_agent_skill` for this agent, already ordered. Empty when they have none recorded. */
	readonly skills: readonly QueueAgentSkill[];
}

/** A seat that could not be projected, and why. Reported rather than thrown — see below. */
export interface UnreachableSeat {
	readonly queueId: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly reason: "no-extension" | "no-contact" | "unknown-contact-kind";
}

export interface QueueMembershipProjection {
	readonly memberships: readonly QueueMembership[];
	readonly unreachable: readonly UnreachableSeat[];
}

export interface ProjectionOptions {
	/**
	 * How an extension number becomes something the media server can dial.
	 *
	 * The same template `apps/engine`'s `ENGINE_EXTENSION_DIAL_TEMPLATE` applies, and it has to be,
	 * because the value written here is handed to the media server VERBATIM: the engine does not
	 * re-derive an endpoint from an agent's number, it dials the string the control plane published.
	 * Two templates that disagree would produce a queue whose agents' phones never ring while every
	 * direct call to the same extension works.
	 */
	readonly extensionDialTemplate: string;
	/** Stamped on every roster. Injected so a spec can pin it. */
	readonly now?: Date;
	/** Previous revision per queue id, so the counter advances rather than restarting at 1. */
	readonly previousRevisions?: ReadonlyMap<string, number>;
	/** The enabled wrap-up vocabulary, per queue. Absent for a queue that asks no question. */
	readonly dispositionCodes?: readonly QueueRosterDispositionCodeRow[];
	/** What each queue asks of an agent. Absent for a queue anybody may take callers on. */
	readonly skillRequirements?: readonly QueueRosterSkillRequirementRow[];
	/** The survey questions, per queue. Already narrowed to queues whose survey is on. */
	readonly surveyQuestions?: readonly QueueRosterSurveyQuestionRow[];
}

/** Renders `PJSIP/{number}` (or whatever the deployment configured) for one extension number. */
export function renderExtensionDialString(template: string, number: string): string {
	return template.replaceAll("{number}", number);
}

/**
 * Projects one organization's queues into the rosters the engine distributes against.
 *
 * ## Why `contact` is resolved here and not by the engine
 *
 * `queueMembershipAgentSchema.contact` is a DIAL STRING in the media server's vocabulary, not an
 * extension number, and resolving it is the control plane's job because the control plane is what
 * holds the extension rows. Doing it at write time means the engine dials exactly what it was given
 * rather than re-deriving an endpoint from a number it cannot verify — and it means an agent whose
 * extension was deleted is caught HERE, at the write, instead of as a queue that mysteriously times
 * out at three in the morning.
 *
 * ## Why an unreachable seat is dropped rather than published or thrown
 *
 * A seat with no way to reach it is one the engine would try, fail to originate, and penalise the
 * agent for. Publishing it costs every waiting caller a full ring timeout for a phone that does not
 * exist. But throwing would mean one broken row stops the OTHER agents on the queue from being
 * published at all, which turns a single misconfiguration into a queue that ejects everybody — so
 * it is dropped, reported, and logged by the caller. `queues.dto.ts`'s `assertReachable` is what
 * stops such a row being created in the first place; this is the second line, for rows that became
 * unreachable afterwards (an extension deleted out from under an agent sets `extension_id` to null
 * by `on delete set null`).
 *
 * ## Disabled seats ARE published
 *
 * With `enabled: false`, which the schema documents as "in the roster and never rings". The engine
 * skips them; a wallboard can show them greyed. Dropping them would make "this agent is turned off"
 * and "this agent is not on this queue" indistinguishable to every reader.
 */
export function projectQueueMemberships(
	organizationId: string,
	queues: readonly QueueRosterQueueRow[],
	tiers: readonly QueueRosterTierRow[],
	options: ProjectionOptions,
): QueueMembershipProjection {
	const updatedAt = (options.now ?? new Date()).toISOString();
	const codesByQueue = groupBy(options.dispositionCodes ?? [], (row) => row.queueId);
	const requirementsByQueue = groupBy(options.skillRequirements ?? [], (row) => row.queueId);
	const questionsByQueue = groupBy(options.surveyQuestions ?? [], (row) => row.queueId);
	const unreachable: UnreachableSeat[] = [];
	const byQueue = new Map<string, QueueMembershipAgent[]>();

	for (const tier of tiers) {
		const seat = toSeat(tier, options.extensionDialTemplate);
		if (seat === undefined) {
			unreachable.push({
				queueId: tier.queueId,
				agentId: tier.agentId,
				agentName: tier.agentName,
				reason: reasonFor(tier),
			});
			continue;
		}
		byQueue.set(tier.queueId, [...(byQueue.get(tier.queueId) ?? []), seat]);
	}

	const memberships = queues.map((queue) => {
		// Ordered here rather than relied on from the query, because the ORDER is part of the value
		// the engine reads: `top-down` and `round-robin` walk it, and a roster that arrived in a
		// different order after an unrelated write would silently change who is offered a call first.
		const agents = [...(byQueue.get(queue.id) ?? [])].sort(
			(a, b) => a.level - b.level || a.position - b.position || a.agentId.localeCompare(b.agentId),
		);
		const previous = options.previousRevisions?.get(queue.id) ?? 0;
		return queueMembershipSchema.parse({
			orgId: organizationId,
			queueId: queue.id,
			name: queue.name,
			wrapUpSeconds: queue.wrapUpSeconds,
			tierRulesApply: queue.tierRulesApply,
			tierRuleWaitSeconds: queue.tierRuleWaitSeconds,
			tierRuleNoAgentNoWait: queue.tierRuleNoAgentNoWait,
			// Every field below is OMITTED at its off value rather than written as `false`, `[]` or a
			// `survey` with no questions. That is not tidiness: a queue configured with none of this
			// must publish a roster byte-identical to the one it published before these columns
			// existed, because `isSameRoster` in the publisher compares serialised values and the
			// engine's older readers are keyed off absence. An empty array here would republish every
			// roster in every tenant on the first write after deploy and would make "this queue asks
			// nothing" and "this queue asks for a list that happens to be empty" different bytes.
			...(queue.ronaEnabled ? { ronaEnabled: true } : {}),
			...(queue.dispositionRequired ? { dispositionRequired: true } : {}),
			...dispositionCodesFor(codesByQueue.get(queue.id)),
			...skillRequirementsFor(requirementsByQueue.get(queue.id)),
			...surveyFor(queue, questionsByQueue.get(queue.id)),
			agents,
			updatedAt,
			revision: previous + 1,
		} satisfies QueueMembership);
	});

	return { memberships, unreachable };
}

function toSeat(tier: QueueRosterTierRow, template: string): QueueMembershipAgent | undefined {
	const contact = dialStringFor(tier, template);
	if (contact === undefined) {
		return undefined;
	}
	return {
		agentId: tier.agentId,
		name: tier.agentName,
		contactKind: tier.contactKind === "external" ? "external" : "extension",
		contact,
		...(tier.extensionId === null ? {} : { extensionId: tier.extensionId }),
		...(tier.contactKind !== "extension" || tier.extensionNumber === null
			? {}
			: { extensionNumber: tier.extensionNumber }),
		level: tier.level,
		position: tier.position,
		// `?? undefined`, not `?? null`: `queueMembershipAgentSchema.announcePromptId` is OPTIONAL, and
		// a `null` would be rejected by the parse that guards every roster this file writes. NULL in
		// the column means "this tier has nothing of its own to say", which the engine reads as "fall
		// back to the queue's whisper" — so absent is exactly the right spelling of it.
		...(tier.announcePromptId === null ? {} : { announcePromptId: tier.announcePromptId }),
		wrapUpSeconds: tier.wrapUpSeconds,
		maxNoAnswer: tier.maxNoAnswer,
		noAnswerDelaySeconds: tier.noAnswerDelaySeconds,
		busyDelaySeconds: tier.busyDelaySeconds,
		rejectDelaySeconds: tier.rejectDelaySeconds,
		// Absent rather than `[]` for the reason the queue-level fields above are, and for one more:
		// `queueMembershipAgentSchema.skills` documents absence as "no recorded skills", which a
		// queue with no requirement reaches anyway. An empty array says the same thing in bytes the
		// old readers never saw.
		...(tier.skills.length === 0 ? {} : { skills: [...tier.skills] }),
		enabled: tier.enabled,
	};
}

function dispositionCodesFor(rows: readonly QueueRosterDispositionCodeRow[] | undefined): {
	dispositionCodes?: QueueDispositionCodeEntry[];
} {
	if (rows === undefined || rows.length === 0) {
		return {};
	}
	// Ordered here for the reason the seats are: the console renders this list in the order it
	// arrives, and a vocabulary that reshuffled after an unrelated write would move the button an
	// agent reaches for without looking.
	const codes = [...rows]
		.sort((a, b) => a.position - b.position || a.code.localeCompare(b.code))
		.map((row) => ({ id: row.id, code: row.code, label: row.label, position: row.position }));
	return { dispositionCodes: codes };
}

function skillRequirementsFor(rows: readonly QueueRosterSkillRequirementRow[] | undefined): {
	skillRequirements?: QueueSkillRequirement[];
} {
	if (rows === undefined || rows.length === 0) {
		return {};
	}
	const requirements = [...rows]
		.sort((a, b) => a.skill.localeCompare(b.skill))
		.map((row) => ({
			skill: row.skill,
			minLevel: row.minLevel,
			relaxAfterSeconds: row.relaxAfterSeconds,
		}));
	return { skillRequirements: requirements };
}

/**
 * The survey, when there is one to publish.
 *
 * Both halves are required: the queue's switch AND at least one question. `surveyEnabled` with an
 * empty question list is a queue whose survey would play the intro and hang up, and
 * `queueSurveyPlanSchema` refuses a zero-length `questions` anyway — so the flag alone publishes
 * nothing rather than throwing on the parse that guards every roster this file writes.
 */
function surveyFor(
	queue: QueueRosterQueueRow,
	rows: readonly QueueRosterSurveyQuestionRow[] | undefined,
): { survey?: QueueSurveyPlan } {
	if (!queue.surveyEnabled || rows === undefined || rows.length === 0) {
		return {};
	}
	const questions = [...rows]
		.sort((a, b) => a.position - b.position)
		.map((row) => ({
			id: row.id,
			position: row.position,
			// `?? undefined` and not `?? null`, for the reason `announcePromptId` gives above: the
			// field is optional on the schema and a null would be refused by the parse. A question
			// with no prompt is asked silently by a console that has its label.
			...(row.promptId === null ? {} : { promptId: row.promptId }),
			label: row.label,
		}));
	return {
		survey: {
			...(queue.surveyIntroPromptId === null ? {} : { introPromptId: queue.surveyIntroPromptId }),
			questions,
		},
	};
}

/** One pass, one Map. The alternative is a `.filter` per queue over every child row. */
function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
	const byKey = new Map<string, T[]>();
	for (const row of rows) {
		const bucket = byKey.get(keyOf(row));
		if (bucket === undefined) {
			byKey.set(keyOf(row), [row]);
		} else {
			bucket.push(row);
		}
	}
	return byKey;
}

function dialStringFor(tier: QueueRosterTierRow, template: string): string | undefined {
	if (tier.contactKind === "external") {
		return tier.contact !== null && tier.contact.length > 0 ? tier.contact : undefined;
	}
	if (tier.contactKind !== "extension") {
		return undefined;
	}
	if (tier.extensionNumber === null || tier.extensionNumber.length === 0) {
		return undefined;
	}
	return renderExtensionDialString(template, tier.extensionNumber);
}

function reasonFor(tier: QueueRosterTierRow): UnreachableSeat["reason"] {
	if (tier.contactKind === "external") {
		return "no-contact";
	}
	if (tier.contactKind === "extension") {
		return "no-extension";
	}
	return "unknown-contact-kind";
}
