import { z } from "zod/v4";
import {
	QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES,
	QUEUE_STRATEGIES,
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
	/** 0 disables the cap and callers wait indefinitely. */
	maxWaitSeconds: resettable(z.int().min(0).max(86_400)),
	/** Ejects callers this fast when no agent is logged in at all. 0 disables. */
	maxWaitNoAgentSeconds: resettable(z.int().min(0).max(86_400)),
	wrapUpSeconds: resettable(z.int().min(0).max(3600)),
	announcePositionEnabled: z.boolean().optional(),
	announceFrequencySeconds: resettable(z.int().min(5).max(3600)),
	/** A caller who hung up may keep their place if they call back inside the discard window. */
	abandonedResumeAllowed: z.boolean().optional(),
	discardAbandonedAfterSeconds: resettable(z.int().min(0).max(86_400)),
	tierRulesApply: z.boolean().optional(),
	tierRuleWaitSeconds: resettable(z.int().min(0).max(3600)),
	tierRuleNoAgentNoWait: z.boolean().optional(),
	recordEnabled: z.boolean().optional(),
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
		// Only checked when the PATCH restates the contact kind: that is the only case where the body
		// says enough to check. A PATCH that touches neither leaves whatever the row already had.
		const patch = value as ReachableInput;
		if (patch.contactKind !== undefined) {
			assertReachable(patch, context);
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
});

export const updateQueueTierDto = patchOf(createQueueTierDto);
