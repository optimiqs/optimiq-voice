import { queue, queueAgent, queueTier } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Queues, the agents who answer them, and the tiers that connect the two.
 *
 * ## Why the agent is not nested under the queue
 *
 * `queue_agent` carries no `queue_id`: an agent is an organization-level person with a contact
 * method, a wrap-up time and a no-answer penalty, and `queue_tier` is the many-to-many that says
 * which queues they serve and at what ring level. Mounting agents at `/queues/:id/agents` would
 * therefore be a lie about the schema — the same agent appears under three queues, and "delete the
 * agent under queue A" would have to mean "remove one tier", which is a different operation from
 * "this person has left". So agents are their own top-level resource and tiers are the queue's
 * child collection, which is exactly what the tables say.
 *
 * ## What recompiles and what does not
 *
 * `queue` is a routing input (`affectsRouting("queue")`) — it is a destination and it has a timeout
 * branch — so every write to it recompiles. `queue_agent` and `queue_tier` are NOT: the compiler
 * emits a queue node with its strategy and announcements, and agent membership is live state the
 * engine reads at dial time. `packages/routing` records that decision, and following it here is why
 * logging an agent in does not evict the tenant's routing artifact.
 */
export const QUEUE_RESOURCE: PbxResource = {
	kind: "queue",
	tableName: "queue",
	table: queue,
	searchColumns: [queue.name, queue.extensionNumber],
	orderBy: [queue.name, queue.id],
	enabledColumn: queue.enabled,
	/** Taken when `maxWaitSeconds` or `maxWaitNoAgentSeconds` expires. */
	destinations: [{ prefix: "timeout", required: false }],
	destinationType: "queue",
};

export const QUEUE_AGENT_RESOURCE: PbxResource = {
	kind: "queue-agent",
	tableName: "queue_agent",
	table: queueAgent,
	searchColumns: [queueAgent.name, queueAgent.contact],
	orderBy: [queueAgent.name, queueAgent.id],
	enabledColumn: queueAgent.enabled,
	destinations: [],
	// Nothing may point at an agent as a destination: a call is offered to a queue, and the queue
	// picks the agent. A destination that named one directly would bypass the strategy.
	destinationType: null,
	// `queue_tier.queue_agent_id` is `on delete cascade` and stays that way: deleting an agent is
	// "this person has left", and leaving them in three queues they can never answer is worse than
	// removing the memberships with them.
};

export const QUEUE_TIER_RESOURCE: PbxChildResource = {
	kind: "queue-tier",
	tableName: "queue_tier",
	table: queueTier,
	searchColumns: [],
	/** `level` is the ring tier, `position` orders agents within it — both are routing policy. */
	orderBy: [queueTier.level, queueTier.position, queueTier.id],
	destinations: [],
	destinationType: null,
	parentColumn: queueTier.queueId,
	parentKind: "queue",
	parentTable: queue,
	// No `ordinalColumn`: a tier's place is `(level, position)`, which the caller sets explicitly
	// because it decides who is offered the call first. It is not a drag handle over one list.
};
