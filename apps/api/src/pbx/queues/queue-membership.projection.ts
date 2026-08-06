import { queueMembershipSchema } from "@optimiq-voice/events/schemas";
import type { QueueMembership, QueueMembershipAgent } from "@optimiq-voice/events/schemas";

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
	readonly wrapUpSeconds: number;
	readonly maxNoAnswer: number;
	readonly noAnswerDelaySeconds: number;
	readonly busyDelaySeconds: number;
	readonly rejectDelaySeconds: number;
	readonly enabled: boolean;
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
		level: tier.level,
		position: tier.position,
		wrapUpSeconds: tier.wrapUpSeconds,
		maxNoAnswer: tier.maxNoAnswer,
		noAnswerDelaySeconds: tier.noAnswerDelaySeconds,
		busyDelaySeconds: tier.busyDelaySeconds,
		rejectDelaySeconds: tier.rejectDelaySeconds,
		enabled: tier.enabled,
	};
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
