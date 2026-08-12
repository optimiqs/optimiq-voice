import { z } from "zod";
import { agentStatusSchema } from "./telephony";

/**
 * The three ACD KV VALUE contracts: `queue-membership`, `agent-state` and `queue-waiting`.
 *
 * ## Why these are in `packages/events` and not in either application
 *
 * Each bucket is written by one process and read by another — or, in two cases, written by several
 * at once. `queue-membership` is written by `apps/api` when a tier or an agent changes and read by
 * `apps/engine` on every queued caller; `agent-state` is written by BOTH (the API on
 * login/logout/pause, the engine on ring/answer/wrap-up) and read by both plus the wallboard;
 * `queue-waiting` is written by EVERY engine instance holding a caller and read by all of them plus
 * the wallboard, which is why it is the one whose write discipline (compare-and-set, always) is part
 * of the contract rather than a convention. A shape agreed in a comment across two repositories'
 * worth of code is a shape that drifts, and the failure mode is silent: a roster the engine reads as
 * empty ejects every caller to the queue's timeout branch and looks exactly like "nobody is logged
 * in".
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
 * ## Timestamps are ISO strings, not epoch millis — except in `queue-waiting`
 *
 * The first two are consistent with every envelope on the backbone (`at`, `receivedAt`,
 * `statusChangedAt`). A KV value is read by hand as often as by code during an incident, and
 * `2026-08-05T12:00:00.000Z` answers "when did this agent go on break" without a calculator.
 *
 * `queue-waiting` breaks that, and `claims.ts` already broke it the same way for the same reason:
 * its timestamps are not read, they are COMPARED, on the call path, once a second per waiting caller
 * — ranking a line and testing a lease. A comparison that has to `Date.parse` first is a comparison
 * somebody eventually writes as a string compare, and the resulting bug is a line in the wrong
 * order rather than a crash. Legibility loses to a hot loop exactly twice in this package, and both
 * times it is written down.
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
	/**
	 * `queue_tier.announce_prompt_id` — played to THIS agent instead of the queue's whisper when a
	 * call distributed by this tier reaches them.
	 *
	 * On the roster rather than in the plan node, and that is the whole reason it can exist at all: a
	 * tier is a membership fact, the artifact has never carried tiers, and putting a per-tier prompt
	 * in the plan would force a recompile of every route in the tenant each time a supervisor moved
	 * somebody between levels. It travels with the seat, exactly like `wrapUpSeconds` and the three
	 * penalty delays beside it.
	 *
	 * A bare prompt id, like `agentWhisperPromptId` on the node: the engine resolves it through the
	 * same media-ref path and falls back to the queue's whisper when it is absent or unresolvable.
	 */
	announcePromptId: z.uuid().optional(),
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

// ---------------------------------------------------------------------------------------------
// queue-waiting
// ---------------------------------------------------------------------------------------------

/** Hard ceilings on the record, so a writer refuses before the bucket does. */
export const QUEUE_WAITING_MAX_ENTRIES = 500;
export const QUEUE_WAITING_MAX_TOMBSTONES = 500;

/**
 * One caller standing in one queue's line, as every engine instance sees them.
 *
 * ## Epoch millis, not ISO strings
 *
 * The exception to this file's own rule, and the same exception `claims.ts` makes for the same
 * reason: `joinedAt` and `expiresAt` are compared against a clock on the CALL PATH — every waiting
 * caller re-ranks the line once a second — and a comparison that has to parse a date first is a
 * comparison somebody eventually writes as a string compare. `agent-state`'s `since` is read by a
 * wallboard and by one comparator; these are read by every caller in the queue, every second.
 *
 * ## `joinedAt` is the ORDER, and it is not always when this call arrived
 *
 * That distinction is the entire abandoned-resume feature. A caller who hung up at position 3 and
 * rings back inside the window is re-inserted carrying the joinedAt they ORIGINALLY had, so the line
 * puts them back where they were rather than at the end. Every other reader treats it as "when they
 * joined", which is exactly what it means to them.
 *
 * ## The lease
 *
 * `expiresAt` is pushed forward by the session that owns the entry while the caller is really still
 * on the line, and `instanceId` says which process is doing the pushing. An entry past its expiry is
 * pruned by whichever writer next touches the record — see `QUEUE_WAITING_KV` for why a per-entry
 * server-side TTL is not available and why that matters more here than anywhere else.
 */
export const queueWaitingEntrySchema = z.object({
	callId: z.uuid(),
	legId: z.uuid(),
	/** Higher dequeues first. Same 0-1000 scale as `queue.caller.joined`. */
	priority: z.int().min(0).max(1000),
	/** Epoch millis. The order within a priority, and what a resume restores. */
	joinedAt: z.number(),
	/** The engine process holding this caller's leg. */
	instanceId: z.string().min(1).max(128),
	/** Epoch millis. Past this with no renewal, any writer may prune the entry. */
	expiresAt: z.number(),
	/** For the wallboard, and the key an abandoned-resume tombstone would be written under. */
	callerNumber: z.string().max(128).optional(),
});

export type QueueWaitingEntry = z.infer<typeof queueWaitingEntrySchema>;

/**
 * A place held for a caller who hung up while waiting.
 *
 * ## Keyed by the caller's NUMBER, and what that costs
 *
 * There is nothing else to key it on. The caller is gone: their call id died with their leg, and the
 * only thing they will present when they ring back is the number their phone sends. So the promise
 * is "this NUMBER may resume", and the consequence has to be stated rather than discovered — a
 * switchboard, a call box, a household landline or any shared line presents one number for many
 * people, and the second person to ring in from it would be handed the first person's place. That is
 * why `queue.abandoned_resume_allowed` defaults to false and why its comment says who should turn it
 * on.
 *
 * A number that is withheld or absent gets no tombstone at all, rather than sharing an "unknown"
 * bucket with every other anonymous caller — which would hand the promise to whoever rang next.
 *
 * ## One resume per tombstone
 *
 * The entry is deleted the moment it is adopted, in the same compare-and-set that inserts the
 * resumed caller. Without that, one abandoned call would let the same number jump the line as often
 * as it liked for the whole window, which is a queue-priority bypass anybody can dial.
 */
export const queueResumeTombstoneSchema = z.object({
	/** The caller's number, as the engine read it off the leg. The lookup key. */
	callerNumber: z.string().min(1).max(128),
	/** The `joinedAt` the resumed caller inherits — their old place in the line. */
	joinedAt: z.number(),
	/** The priority they had. Restored too: a VIP who was cut off is still a VIP. */
	priority: z.int().min(0).max(1000),
	/** When they gave up. For the log, and for a wallboard that wants to show near-misses. */
	abandonedAt: z.number(),
	/** Epoch millis, `now + discard_abandoned_after_seconds`. Past it the promise is gone. */
	expiresAt: z.number(),
});

export type QueueResumeTombstone = z.infer<typeof queueResumeTombstoneSchema>;

/**
 * One queue's line and its outstanding resume promises, as the `queue-waiting` bucket holds them.
 *
 * ## Why the tombstones share the record rather than living in their own keys
 *
 * Because every write already touches this key. A caller abandoning is a `leave` — a compare-and-set
 * that removes their entry — and writing the tombstone in the SAME write makes "they left the line
 * and their place is being held" one atomic fact instead of two that can disagree. A separate key
 * would add a second write on the unhappiest path in the feature (the caller has already hung up) and
 * would introduce a state where a caller is out of the line with no promise recorded, or has a promise
 * recorded while still in the line.
 *
 * ## Both arrays are capped, and the caps are enforced by the writer
 *
 * `QUEUE_WAITING_MAX_ENTRIES` / `QUEUE_WAITING_MAX_TOMBSTONES` are below what the bucket's
 * `maxValueSizeBytes` would accept, on purpose: a write that is refused by the SERVER for being too
 * large arrives as an unavailability in the middle of an incident, whereas a cap the writer knows
 * about is a queue that stops handing out new promises and says so. The line's cap is the one that
 * matters least in practice — a queue with 500 people waiting has a staffing problem, not a bucket
 * problem — and a caller who cannot be inserted is still served, with a position the engine reports
 * as unknown rather than wrong.
 */
export const queueWaitingRecordSchema = z.object({
	orgId: z.uuid(),
	queueId: z.uuid(),
	/** Ordered by nothing in particular on the wire; the RANK is computed, never stored. */
	entries: z.array(queueWaitingEntrySchema).max(QUEUE_WAITING_MAX_ENTRIES),
	tombstones: z.array(queueResumeTombstoneSchema).max(QUEUE_WAITING_MAX_TOMBSTONES),
	/** Epoch millis of the last write. For the log and for a stale-record check by eye. */
	updatedAt: z.number(),
});

export type QueueWaitingRecord = z.infer<typeof queueWaitingRecordSchema>;
