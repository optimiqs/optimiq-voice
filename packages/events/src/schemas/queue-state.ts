import { z } from "zod";
import { agentStatusSchema } from "./telephony";

/**
 * The two ACD KV VALUE contracts: `queue-membership` and `agent-state`.
 *
 * ## Why these are in `packages/events` and not in either application
 *
 * Both buckets are written by one process and read by another. `queue-membership` is written by
 * `apps/api` when a tier or an agent changes and read by `apps/engine` on every queued caller;
 * `agent-state` is written by BOTH (the API on login/logout/pause, the engine on ring/answer/wrap-up)
 * and read by both plus the wallboard. A shape agreed in a comment across two repositories' worth of
 * code is a shape that drifts, and the failure mode is silent: a roster the engine reads as empty
 * ejects every caller to the queue's timeout branch and looks exactly like "nobody is logged in".
 *
 * `packages/events` already owns the bucket DEFINITIONS (`streams.ts`) and the key builders
 * (`kvKeyFor`). The values belong with them for the same reason the event payloads belong with the
 * subjects: the contract is the whole triple, and splitting it is how two of the three end up
 * agreeing.
 *
 * ## Why they are NOT in the Go codegen registry
 *
 * `scripts/registry.ts` names what crosses the language border. `apps/sipd` is a location service:
 * it resolves an AOR to a contact and has no reason to know what a queue tier is, and the parity
 * golden it pins would then have to be maintained for a type nothing on the Go side constructs.
 * The BUCKET definitions do cross (they are in `KV_BUCKETS`, which the golden compares), because a
 * Go process that applies definitions must apply all of them. The values do not. If a Go consumer
 * ever needs a roster, adding one registry entry is the change — and it will be a deliberate one.
 *
 * ## Timestamps are ISO strings, not epoch millis
 *
 * Consistent with every envelope on the backbone (`at`, `receivedAt`, `statusChangedAt`). A KV value
 * is read by hand as often as by code during an incident, and `2026-08-05T12:00:00.000Z` answers
 * "when did this agent go on break" without a calculator.
 */

// ---------------------------------------------------------------------------------------------
// queue-membership
// ---------------------------------------------------------------------------------------------

/** How the engine reaches an agent. Mirrors `pbx-db` `QUEUE_AGENT_CONTACT_KINDS`. */
export const QUEUE_AGENT_CONTACT_KINDS = ["extension", "external"] as const;
export type QueueAgentContactKind = (typeof QUEUE_AGENT_CONTACT_KINDS)[number];
export const queueAgentContactKindSchema = z.enum(QUEUE_AGENT_CONTACT_KINDS);

/**
 * One agent's seat in one queue: the tier coordinates, the dial string, and the per-agent
 * distribution parameters from `queue_agent`.
 *
 * `contact` is a DIAL STRING in the media server's vocabulary and not an extension number, because
 * the two are not the same question. An `extension` agent's contact is what the engine's extension
 * dial template produces for their number (`PJSIP/1001`); an `external` agent's is a whole endpoint
 * (`PJSIP/+15551234567@carrier-a`). Resolving that is the control plane's job — it holds the
 * extension rows and the trunk configuration — and doing it at write time means the engine dials
 * exactly what it was given rather than re-deriving an endpoint from a number it cannot verify.
 *
 * The penalty delays are per agent and not per queue because that is where `pbx-db` puts them, and
 * because they describe the AGENT ("this one's phone forwards to a mobile that rings for a minute"),
 * not the queue.
 */
export const queueMembershipAgentSchema = z.object({
	agentId: z.uuid(),
	/** For the log and the wallboard. Never used to select or to dial. */
	name: z.string().min(1).max(128),
	contactKind: queueAgentContactKindSchema,
	/** What the engine hands to the media server, verbatim. */
	contact: z.string().min(1).max(256),
	/** The extension row behind an `extension` agent, when there is one. For the CDR and the log. */
	extensionId: z.uuid().optional(),
	/** Ring tier. Lower rings first when tier rules apply. */
	level: z.int().min(1).max(100),
	/** Order within a tier. The tie-break every ordered strategy falls back to. */
	position: z.int().min(1).max(1000),
	/** How long after a call this agent is held out of distribution. Overrides the queue's. */
	wrapUpSeconds: z.int().min(0).max(3600),
	/** Consecutive no-answers before the agent is taken out of distribution entirely. */
	maxNoAnswer: z.int().min(0).max(100),
	/** Held out of distribution this long after a no-answer. */
	noAnswerDelaySeconds: z.int().min(0).max(3600),
	/** …after a busy. */
	busyDelaySeconds: z.int().min(0).max(3600),
	/** …after an explicit rejection. */
	rejectDelaySeconds: z.int().min(0).max(3600),
	/** A disabled seat is in the roster and never rings. Kept so a wallboard can show it greyed. */
	enabled: z.boolean(),
});

export type QueueMembershipAgent = z.infer<typeof queueMembershipAgentSchema>;

/**
 * One queue's whole roster.
 *
 * ## Why the tier RULES are here and not in the routing artifact
 *
 * `tierRulesApply`, `tierRuleWaitSeconds` and `tierRuleNoAgentNoWait` decide which LEVELS are open
 * to a caller who has waited a given time — they are meaningless without the tiers, and the tiers
 * are not in the artifact. Putting them beside the roster keeps "which agents may this caller reach
 * right now" answerable from one read. The queue's `strategy`, `maxWaitSeconds` and prompts stay in
 * the plan node where the compiler puts them: those are routing, they change with the route, and
 * duplicating them here would create two sources for one answer.
 *
 * `wrapUpSeconds` is the queue's default, used for agents whose own is zero.
 *
 * ## `revision`
 *
 * The control plane's monotonic counter for this queue's roster. The engine logs it, so "the engine
 * was distributing against an old roster" is a question with an answer rather than a theory.
 */
export const queueMembershipSchema = z.object({
	orgId: z.uuid(),
	queueId: z.uuid(),
	/** For the log; the queue's identity on the wire is its id. */
	name: z.string().min(1).max(128).optional(),
	/** Queue-wide default for agents whose own `wrapUpSeconds` is 0. */
	wrapUpSeconds: z.int().min(0).max(3600),
	/** When false every level rings together and the two settings below are ignored. */
	tierRulesApply: z.boolean(),
	/** A caller who has waited this long has the next level opened to them. 0 opens all at once. */
	tierRuleWaitSeconds: z.int().min(0).max(3600),
	/** Open the next level immediately when the current one has nobody logged in at all. */
	tierRuleNoAgentNoWait: z.boolean(),
	agents: z.array(queueMembershipAgentSchema).max(500),
	/** When the control plane last wrote this roster. */
	updatedAt: z.iso.datetime(),
	revision: z.int().min(0).optional(),
});

export type QueueMembership = z.infer<typeof queueMembershipSchema>;

// ---------------------------------------------------------------------------------------------
// agent-state
// ---------------------------------------------------------------------------------------------

/**
 * One agent's live state, as the `agent-state` bucket holds it.
 *
 * ## Why `since` is the field distribution actually reads
 *
 * `longest-idle` is "the agent who has been available longest", which is `now - since` for an entry
 * whose status is `available`. Storing the transition instant rather than a computed idle time is
 * what makes that answerable from a stale-ish read: an entry written ten minutes ago still says
 * exactly how long the agent has been idle, whereas a stored duration would be ten minutes wrong.
 *
 * ## `availableAt` and why wrap-up is a timestamp, not a status alone
 *
 * An agent in wrap-up is not eligible until a deadline. Writing the deadline means the engine that
 * reads the entry does not have to have observed the transition itself — which matters the moment
 * there are two engine instances, because the one that took the call is not necessarily the one
 * distributing the next caller. The same field carries the no-answer / busy / reject penalty
 * deadlines, so "when may this agent ring again" is ONE question with one answer rather than four
 * fields a reader has to remember to check.
 *
 * `status` and `availableAt` are deliberately independent: an agent can be `available` and still not
 * eligible (serving a penalty), and an agent in `wrap-up` past their deadline is eligible without
 * anybody having written a transition. A reader that checks only the status will ring somebody who
 * just declined; a reader that checks only the deadline will ring somebody who logged out.
 */
export const agentStateEntrySchema = z.object({
	orgId: z.uuid(),
	agentId: z.uuid(),
	status: agentStatusSchema,
	/** When the agent entered {@link status}. `longest-idle` is ordered by this. */
	since: z.iso.datetime(),
	previousStatus: agentStatusSchema.optional(),
	/** Not eligible for distribution before this instant, whatever the status says. */
	availableAt: z.iso.datetime().optional(),
	/** Consecutive no-answers. Reset on an answer; `maxNoAnswer` is compared against it. */
	noAnswerCount: z.int().min(0).max(1000).optional(),
	/** The call the agent is ringing for or on. Absent when they are not on one. */
	callId: z.uuid().optional(),
	legId: z.uuid().optional(),
	/** The queue that distributed the current call. */
	queueId: z.uuid().optional(),
	/** Free-text break/unavailable reason, as the UI set it. */
	reason: z.string().max(128).optional(),
	/** Which process last wrote this. `engine` writes call-driven transitions; `api` writes shifts. */
	source: z.enum(["engine", "api"]).optional(),
});

export type AgentStateEntry = z.infer<typeof agentStateEntrySchema>;
