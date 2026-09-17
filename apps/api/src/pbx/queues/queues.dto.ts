import { z } from "zod/v4";
import {
	QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES,
	QUEUE_DISPOSITION_UNSET,
	QUEUE_PRIORITY_MAX,
	QUEUE_PRIORITY_MIN,
	QUEUE_SKILL_LEVEL_MAX,
	QUEUE_SKILL_LEVEL_MIN,
	QUEUE_STRATEGIES,
	QUEUE_SURVEY_MAX_QUESTIONS,
	RECORD_POLICIES,
} from "@optimiq-voice/pbx-db";
import {
	dialableString,
	displayName,
	internalNumber,
	namedDestinationShape,
	patchOf,
	resettable,
} from "../shared/dto";

/**
 * Queues, agents and tiers.
 *
 * Every numeric knob here is `notNull().default(n)` in the schema, so each is declared
 * {@link resettable}: `null` puts it back to the server default rather than clearing it to NULL,
 * which is what a form's "Use default" control means and the only reading the column permits. See
 * `shared/dto.ts`.
 */
export const createQueueDto = z.strictObject({
	name: displayName,
	/** Optional internal number so staff can dial the queue directly. */
	extensionNumber: internalNumber.nullish(),
	strategy: z.enum(QUEUE_STRATEGIES).optional(),
	mohClassId: z.uuid().nullish(),
	greetingPromptId: z.uuid().nullish(),
	announcePromptId: z.uuid().nullish(),
	/** Played to the agent alone on answer, before the caller is connected. `null` clears it. */
	agentWhisperPromptId: z.uuid().nullish(),
	/** 0 disables the cap and callers wait indefinitely. */
	maxWaitSeconds: resettable(z.int().min(0).max(86_400)),
	/** Ejects callers this fast when no agent is logged in at all. 0 disables. */
	maxWaitNoAgentSeconds: resettable(z.int().min(0).max(86_400)),
	wrapUpSeconds: resettable(z.int().min(0).max(3600)),
	/**
	 * Whether the console insists on a wrap-up code before the agent goes back on the floor.
	 *
	 * A queue with no {@link createQueueDispositionCodeDto} rows ignores it — there is nothing to
	 * pick — and the wrap-up deadline still ends the after-call work with `unset` recorded either
	 * way. See `packages/pbx-db`'s `queue.disposition_required` for why "must" is the softer word.
	 */
	dispositionRequired: z.boolean().optional(),
	/** ONE unanswered offer benches the agent until a human resumes them. Off is `max_no_answer`. */
	ronaEnabled: z.boolean().optional(),
	/** Whether the caller is offered the questions after the AGENT hangs up on an answered call. */
	surveyEnabled: z.boolean().optional(),
	/** "Please stay on the line to rate this call." Played once, before the first question. */
	surveyIntroPromptId: z.uuid().nullish(),
	announcePositionEnabled: z.boolean().optional(),
	announceFrequencySeconds: resettable(z.int().min(5).max(3600)),
	/** A caller who hung up may keep their place if they call back inside the discard window. */
	abandonedResumeAllowed: z.boolean().optional(),
	discardAbandonedAfterSeconds: resettable(z.int().min(0).max(86_400)),
	tierRulesApply: z.boolean().optional(),
	tierRuleWaitSeconds: resettable(z.int().min(0).max(3600)),
	tierRuleNoAgentNoWait: z.boolean().optional(),
	/**
	 * When the engine records what this queue distributes — the same vocabulary `extension` and
	 * `trunk` carry, which replaced a `recordEnabled` boolean no runtime honoured.
	 *
	 * NOT `resettable`, unlike the numeric knobs above: this is an enum whose "off" value is a real
	 * member (`none`) rather than a server default somebody might want to fall back to. A form's
	 * "do not record" is `none`, which the column can say for itself.
	 */
	recordPolicy: z.enum(RECORD_POLICIES).optional(),
	/**
	 * The queue's copy of the extension's PCI auto-pause flag, and a separate field rather than an
	 * inherited one because a queue recording is started by the queue: an agent taking a payment on
	 * a queue call is the case this exists for, and their extension's own answer is about the calls
	 * they place, not the ones distributed to them.
	 */
	recordAutoPauseOnDtmf: z.boolean().optional(),
	/**
	 * The single DTMF digit a waiting caller may press to leave. `null` removes it.
	 *
	 * Upper-cased before validation so a tenant who types `d` gets the DTMF `D` rather than a
	 * rejected form — the engine compares this against a digit with `===`, so the two spellings are
	 * not equivalent anywhere below this line.
	 */
	exitKey: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[0-9*#A-D]$/u, "An exit key must be a single DTMF digit (0-9, *, #, A-D).")
		.nullish(),
	...namedDestinationShape("exit"),
	/**
	 * Virtual hold — a waiting caller keeps their place and the platform calls them back.
	 *
	 * The accept key takes the same shape as {@link exitKey} and for the same reason. It may not BE
	 * the exit key; the compiler drops the callback's claim on the digit when it is, with a
	 * `queue-callback-unusable` warning, because leaving the queue is the more destructive reading of
	 * a keypress.
	 */
	callbackEnabled: z.boolean().optional(),
	callbackKey: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[0-9*#A-D]$/u, "A callback key must be a single DTMF digit (0-9, *, #, A-D).")
		.nullish(),
	/** 0 means the offer is never announced and the caller reaches it only by pressing the key. */
	callbackOfferAfterSeconds: resettable(z.int().min(0).max(86_400)),
	callbackOfferPromptId: z.uuid().nullish(),
	callbackConfirmPromptId: z.uuid().nullish(),
	callbackMaxAttempts: resettable(z.int().min(1).max(10)),
	callbackRetryDelaySeconds: resettable(z.int().min(30).max(86_400)),
	callbackExpiresAfterSeconds: resettable(z.int().min(60).max(604_800)),
	/** Higher dequeues first. An IVR may override it per entry through the destination's args. */
	defaultPriority: resettable(z.int().min(QUEUE_PRIORITY_MIN).max(QUEUE_PRIORITY_MAX)),
	...namedDestinationShape("timeout"),
	enabled: z.boolean().optional(),
});

export const updateQueueDto = patchOf(createQueueDto);

/**
 * An agent.
 *
 * `statusChangedAt` is absent on purpose: it is stamped when `status` moves, and a form that could
 * backdate it would make every wallboard's "on this call for 12 minutes" a number the agent chose.
 * `status` itself is writable because a supervisor forcing an agent out of a queue is a real
 * operation — it is what `queues.manage-agents` grants.
 */
const queueAgentShape = {
	name: displayName,
	/** `user.id` in the auth database. A plain uuid: there are no cross-database foreign keys. */
	userId: z.uuid().nullish(),
	contactKind: z.enum(QUEUE_AGENT_CONTACT_KINDS).optional(),
	extensionId: z.uuid().nullish(),
	/** Dial string when `contactKind` is `external`. */
	contact: dialableString.nullish(),
	status: z.enum(QUEUE_AGENT_STATUSES).optional(),
	wrapUpSeconds: resettable(z.int().min(0).max(3600)),
	maxNoAnswer: resettable(z.int().min(1).max(100)),
	noAnswerDelaySeconds: resettable(z.int().min(0).max(3600)),
	busyDelaySeconds: resettable(z.int().min(0).max(3600)),
	rejectDelaySeconds: resettable(z.int().min(0).max(3600)),
	enabled: z.boolean().optional(),
};

export const createQueueAgentDto = z.strictObject(queueAgentShape).superRefine((value, context) => {
	assertReachable(value, context);
});

export const updateQueueAgentDto = patchOf(z.strictObject(queueAgentShape)).superRefine(
	(value, context) => {
		// A PATCH that touches none of the three leaves whatever the row already had, so there is
		// nothing to check. When the kind is restated the body says enough on its own.
		const patch = value as ReachableInput;
		if (patch.contactKind !== undefined) {
			assertReachable(patch, context);
			return;
		}
		// The kind is unstated but the patch CLEARS the field the row is reached through, and states
		// nothing to reach it by instead. `PATCH { "extensionId": null }` used to pass here and save,
		// after which the projection drops the agent as `no-extension` and the only symptom is a
		// supervisor noticing one person stopped getting calls. Restating `contactKind` is the way to
		// say "this seat is external now", and it is the case above.
		if (patch.extensionId === null && !patch.contact) {
			context.addIssue({
				code: "custom",
				path: ["extensionId"],
				message:
					"Clearing the extension leaves the agent unreachable. Set contactKind to external " +
					"and give the number to dial.",
			});
		}
		if (patch.contact === null && !patch.extensionId) {
			context.addIssue({
				code: "custom",
				path: ["contact"],
				message:
					"Clearing the dial string leaves the agent unreachable. Set contactKind to extension " +
					"and give the extension the call is offered to.",
			});
		}
	},
);

interface ReachableInput {
	readonly contactKind?: string | undefined;
	readonly extensionId?: string | null | undefined;
	readonly contact?: string | null | undefined;
}

/**
 * An agent the engine cannot dial is a seat that silently never rings.
 *
 * The schema cannot express this — `contact_kind` decides which of two nullable columns is the
 * live one — so the pair is checked here, where the error lands on the control the user was
 * editing rather than surfacing as a queue that mysteriously times out.
 */
function assertReachable(value: ReachableInput, context: z.RefinementCtx): void {
	const kind = value.contactKind ?? "extension";
	if (kind === "extension" && !value.extensionId) {
		context.addIssue({
			code: "custom",
			path: ["extensionId"],
			message: "An extension-backed agent needs the extension the call is offered to.",
		});
	}
	if (kind === "external" && !value.contact) {
		context.addIssue({
			code: "custom",
			path: ["contact"],
			message: "An external agent needs the number to dial.",
		});
	}
}

/**
 * A membership: which agent serves this queue, at which ring level and in what order within it.
 *
 * The queue comes from the path, so it is not in the body — the same rule every other child
 * collection follows, and the reason a tier cannot be moved between queues by editing it.
 */
export const createQueueTierDto = z.strictObject({
	queueAgentId: z.uuid(),
	/** Lower levels are offered the call first; every agent at a level is tried before the next. */
	level: resettable(z.int().min(1).max(100)),
	/** Order within the level, which `top-down` and `round-robin` walk in. */
	position: resettable(z.int().min(1).max(1000)),
	/**
	 * Played to the AGENT alone when a call distributed by THIS tier reaches them, in place of the
	 * queue's `agentWhisperPromptId`. `null` clears it and the queue's whisper takes over again.
	 *
	 * Writable here rather than on the queue because it is a fact about the tier — an escalation cue
	 * for a level that is only reached after the one below it could not take the call. It is
	 * therefore behind `queues.manage-agents` like everything else on this DTO, which is the right
	 * gate: whoever staffs the levels is whoever knows what each level should be told.
	 */
	announcePromptId: z.uuid().nullish(),
});

export const updateQueueTierDto = patchOf(createQueueTierDto);

/**
 * A tag in the skill vocabulary — `spanish`, `tier2`, `mortgage-advice`.
 *
 * Lower-cased before validation for the reason {@link createQueueDto}'s exit key is upper-cased:
 * the tag is compared with `===` on the call path, matching a seat's skills against a queue's
 * requirements, and `Spanish` and `spanish` are not equivalent anywhere below this line. The
 * database carries the same regex as a check constraint, so a value that got past this would be
 * refused there instead of quietly fragmenting the vocabulary.
 */
const skillTag = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[a-z0-9][a-z0-9_-]{0,62}$/u,
		"must start with a letter or digit and contain only lower-case letters, digits, _ and -",
	);

/**
 * One wrap-up code a queue offers: `sale`, `escalated`, `wrong-number`.
 *
 * The queue comes from the path, so it is not in the body — the rule every child collection here
 * follows, and the reason a code cannot be moved between queues by editing it.
 *
 * `code` is lower-cased on the way in like {@link skillTag} and for the same reason: reports group
 * by it and the CDR leg stores it verbatim, so two spellings would be two outcomes. `unset` is
 * refused here as well as by the database check, because the error a form can attach to a field is
 * more use than a 500 carrying a constraint name — it is what the wrap-up deadline records when
 * nobody chose, and a tenant-defined code spelled the same way would make "nobody answered the
 * question" and "the agent picked the code called unset" one row in every report.
 *
 * A retired code is `enabled: false` rather than deleted: {@link queueCallDisposition} points at it
 * and the history is what the vocabulary exists for. Deleting one is allowed and sets those rows'
 * `code_id` to NULL — the denormalised `code` on them survives, which is why that column exists.
 */
export const createQueueDispositionCodeDto = z.strictObject({
	code: skillTag.refine(
		(value) => value !== QUEUE_DISPOSITION_UNSET,
		`"${QUEUE_DISPOSITION_UNSET}" is reserved for the code the wrap-up deadline records when nobody chose.`,
	),
	label: displayName,
	/** Order in the console's list. Lowest first; ties fall back to the code. */
	position: resettable(z.int().min(0).max(1000)),
	enabled: z.boolean().optional(),
});

export const updateQueueDispositionCodeDto = patchOf(createQueueDispositionCodeDto);

/**
 * One skill this queue's callers need, and how fast it stops insisting.
 *
 * `relaxAfterSeconds` is the seconds of waiting that buy a one-level drop in `minLevel`; `0` never
 * relaxes and makes the requirement absolute, which is right for a regulated skill and wrong for a
 * preference. That is why it is per requirement rather than a queue-wide switch — see
 * `packages/pbx-db`'s `queueSkillRequirement` for the argument that relaxation IS the feature.
 */
export const createQueueSkillRequirementDto = z.strictObject({
	skill: skillTag,
	minLevel: resettable(z.int().min(QUEUE_SKILL_LEVEL_MIN).max(QUEUE_SKILL_LEVEL_MAX)),
	relaxAfterSeconds: resettable(z.int().min(0).max(3600)),
});

export const updateQueueSkillRequirementDto = patchOf(createQueueSkillRequirementDto);

/**
 * One post-call survey question: where it comes, what the caller hears, what the report calls it.
 *
 * `position` is required and NOT {@link resettable}, unlike every other ordinal on this surface.
 * The column has a default the schema does not give it, because 1-2-3 is the question's identity —
 * a report groups by it, and a second question that silently landed on the same position as the
 * first would be refused by the unique index rather than placed. So the caller says which one this
 * is, and {@link QUEUE_SURVEY_MAX_QUESTIONS} is the ceiling: three keypresses is the attention a
 * caller has, and the bound is stated in the database too.
 *
 * The answer scale is fixed at 1-5 platform-wide and is deliberately not settable here — see
 * `packages/pbx-db`'s `queueSurveyQuestion` for why a per-question scale produces a report nobody
 * can average.
 */
export const createQueueSurveyQuestionDto = z.strictObject({
	position: z.int().min(1).max(QUEUE_SURVEY_MAX_QUESTIONS),
	/** "Press 1 to 5 to rate how well we answered your question." `null` leaves it silent. */
	promptId: z.uuid().nullish(),
	/** For the console and the report. The caller never hears it. */
	label: displayName,
});

export const updateQueueSurveyQuestionDto = patchOf(createQueueSurveyQuestionDto);

/**
 * One skill an AGENT has, and how good they are at it.
 *
 * Hung off the agent and not off a tier, because a skill is a property of the person: the same
 * agent carries `spanish: 4` into every queue they staff, and a copy per membership would be a
 * second value somebody has to keep in step. It rides onto the roster on the SEAT for exactly that
 * reason — see `queue-membership.projection.ts`.
 *
 * Behind `queues.manage-agents` rather than `queues.write`, which is the same split the tiers make:
 * whoever staffs the floor is whoever knows what each person can do, and re-pointing a queue's
 * overflow at an external number is a different job.
 */
export const createQueueAgentSkillDto = z.strictObject({
	skill: skillTag,
	level: resettable(z.int().min(QUEUE_SKILL_LEVEL_MIN).max(QUEUE_SKILL_LEVEL_MAX)),
});

export const updateQueueAgentSkillDto = patchOf(createQueueAgentSkillDto);

/**
 * The wrap-up code an agent picked for the call they are finishing.
 *
 * `callId` is in the body rather than the path because the console reads it off the agent's own
 * `agent-state` entry (`dispositionCallId`) and echoes it back — it is not a resource this API
 * serves, it is the call the agent is closing out, and naming it explicitly is what makes a late
 * submission for the PREVIOUS call refusable rather than silently attributed to the current one.
 *
 * `code` is the `queue_disposition_code.code` and is validated against the queue's enabled
 * vocabulary in the service, where the queue is known. Shaped here so a typo is a 400 with a field
 * on it, and lower-cased for the reason {@link skillTag} is.
 */
export const submitQueueDispositionDto = z.strictObject({
	callId: z.uuid(),
	code: skillTag,
});

/**
 * `POST /queues/:queueId/live/:callId/supervise` — how the supervisor wants to listen in.
 *
 * Three modes and no fourth: silent monitoring, whispering to the agent, and joining the call. They
 * are the three the `*0` feature code's DTMF escalation offers, and a mode this API accepted that
 * the engine could not reach would be a promise the platform cannot keep.
 */
export const superviseCallDto = z.strictObject({
	mode: z.enum(["monitor", "whisper", "barge"]),
});
