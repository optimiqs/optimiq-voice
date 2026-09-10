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
/**
 * One skill, and the level the agent or the queue attaches to it.
 *
 * The 1-5 scale, the tag shape and the reasoning behind both are `packages/pbx-db`'s
 * (`queueAgentSkill`); this schema is the wire copy and deliberately repeats the bounds rather than
 * importing them — `packages/events` does not depend on the database package, and a roster that
 * arrived with `level: 900` must be refused at the bucket rather than at the comparator.
 */
export const QUEUE_SKILL_LEVEL_MIN = 1;
export const QUEUE_SKILL_LEVEL_MAX = 5;

export const queueAgentSkillSchema = z.object({
	skill: z.string().min(1).max(63),
	level: z.int().min(QUEUE_SKILL_LEVEL_MIN).max(QUEUE_SKILL_LEVEL_MAX),
});

export type QueueAgentSkill = z.infer<typeof queueAgentSkillSchema>;

/**
 * One skill a queue asks for, and how fast it stops asking.
 *
 * `relaxAfterSeconds` is the seconds of waiting that buy the caller a one-level drop in
 * `minLevel`; `0` never relaxes, which makes the requirement absolute and is the correct setting
 * for a regulated skill. See `packages/pbx-db`'s `queueSkillRequirement` for why relaxation is the
 * feature rather than a softening of it.
 */
export const queueSkillRequirementSchema = z.object({
	skill: z.string().min(1).max(63),
	minLevel: z.int().min(QUEUE_SKILL_LEVEL_MIN).max(QUEUE_SKILL_LEVEL_MAX),
	relaxAfterSeconds: z.int().min(0).max(3600),
});

export type QueueSkillRequirement = z.infer<typeof queueSkillRequirementSchema>;

/** One wrap-up code the console offers. `id` is the `queue_disposition_code` row. */
export const queueDispositionCodeSchema = z.object({
	id: z.uuid(),
	code: z.string().min(1).max(63),
	label: z.string().min(1).max(128),
	position: z.int().min(0).max(1000),
});

export type QueueDispositionCodeEntry = z.infer<typeof queueDispositionCodeSchema>;

/** One survey question: its order, its audio and the label a report groups by. */
export const queueSurveyQuestionSchema = z.object({
	id: z.uuid(),
	position: z.int().min(1).max(3),
	promptId: z.uuid().optional(),
	label: z.string().min(1).max(128),
});

/**
 * The post-call survey, when the queue has one.
 *
 * Present-means-enabled, exactly as `QueueCallbackPlan` is on the plan node and for the same
 * reason: a `questions` array beside a `surveyEnabled: false` is a shape that can lie, and a reader
 * that has to check the flag before trusting the array will eventually forget to.
 *
 * On the ROSTER rather than in the routing artifact, like the tier whisper and the wrap-up seconds
 * beside it. The questions are edited on the queue's own screen and change without the route
 * changing; compiling them would recompile every inbound route in the tenant each time a supervisor
 * reworded question two.
 */
export const queueSurveyPlanSchema = z.object({
	introPromptId: z.uuid().optional(),
	questions: z.array(queueSurveyQuestionSchema).min(1).max(3),
});

export type QueueSurveyPlan = z.infer<typeof queueSurveyPlanSchema>;

export const queueMembershipAgentSchema = z.object({
	agentId: z.uuid(),
	/** For the log and the wallboard. Never used to select or to dial. */
	name: z.string().min(1).max(128),
	contactKind: queueAgentContactKindSchema,
	/** What the engine hands to the media server, verbatim. */
	contact: z.string().min(1).max(256),
	/** The extension row behind an `extension` agent, when there is one. For the CDR and the log. */
	extensionId: z.uuid().optional(),
	/** The logical extension number for native SIP routing, independent of the ARI endpoint. */
	extensionNumber: z.string().min(1).max(32).optional(),
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
	/**
	 * What this agent is good at, as `queue_agent_skill` holds it.
	 *
	 * On the SEAT and not on the queue, because a skill is a property of the person: the same agent
	 * carries `spanish: 4` into every queue they staff, and a copy per membership would have to be
	 * kept in step by whoever edited it. The queue's half of the bargain is
	 * {@link queueSkillRequirementSchema} below — what it asks for — and matching the two is
	 * `queue-strategy.ts`'s job.
	 *
	 * Absent means "this agent has no recorded skills", which is not the same as being unskilled: a
	 * queue that requires nothing still reaches them. Only a queue with an unrelaxed requirement
	 * treats an empty list as a bar they cannot clear.
	 */
	skills: z.array(queueAgentSkillSchema).max(50).optional(),
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
	/**
	 * RONA: whether ONE unanswered offer benches the agent until a human resumes them.
	 *
	 * Optional so a roster written before this field existed keeps its exact behaviour — absent
	 * reads as `false`, which is `mod_callcenter`'s consecutive-count model and what every queue
	 * did. See `packages/pbx-db`'s `queue.rona_enabled` for why the two models are one flag and not
	 * a replacement.
	 */
	ronaEnabled: z.boolean().optional(),
	/**
	 * Whether the console insists on a wrap-up code before the agent goes back on the floor.
	 *
	 * "Insists" is the console's job, not the engine's: the wrap-up deadline ends the after-call
	 * work either way and records `unset`. The engine reads this only to decide whether an agent
	 * who picks a code EARLY may leave wrap-up early — a queue that does not ask the question has
	 * nothing to answer, so there is nothing to shorten.
	 */
	dispositionRequired: z.boolean().optional(),
	/** The vocabulary the console offers. Empty or absent means this queue asks no question. */
	dispositionCodes: z.array(queueDispositionCodeSchema).max(100).optional(),
	/**
	 * What this queue's callers need from an agent. Empty or absent means anybody may take them.
	 *
	 * On the roster and not in the artifact, unlike the priority: a requirement is matched against
	 * SEATS, and the seats are here. A caller who arrived through an IVR option that asked for a
	 * different skill set carries that on the plan node instead, and the two are merged at
	 * selection — see `queue-strategy.ts`.
	 */
	skillRequirements: z.array(queueSkillRequirementSchema).max(20).optional(),
	/** The post-call survey, when the queue has one. Absent means it asks nothing. */
	survey: queueSurveyPlanSchema.optional(),
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
	/**
	 * The call this agent still owes a wrap-up code for, while they are in `wrap-up`.
	 *
	 * Separate from {@link agentStateEntrySchema.shape.callId} because they answer different
	 * questions and stop being the same value the moment a second caller reaches the agent: `callId`
	 * is the call they are ON, and this is the call they are FINISHING. An agent whose wrap-up ended
	 * has neither.
	 *
	 * The engine sets it when wrap-up begins and clears it when wrap-up ends, whichever way it
	 * ended. The console reads it to know which call the code it is about to submit belongs to,
	 * which is the whole reason it is here rather than being re-derived from the last CDR row: the
	 * ledger is eventually consistent and the agent has ten seconds.
	 */
	dispositionCallId: z.uuid().optional(),
	/** The code the agent chose for {@link dispositionCallId}, once they have. `unset` is not written here. */
	dispositionCode: z.string().max(63).optional(),
	/** Whether this queue asks for one at all. Copied from the roster so the console needs one read. */
	dispositionRequired: z.boolean().optional(),
	/** Free-text break/unavailable reason, as the UI set it. */
	reason: z.string().max(128).optional(),
	/** Which process last wrote this. `engine` writes call-driven transitions; `api` writes shifts. */
	source: z.enum(["engine", "api"]).optional(),
});

export type AgentStateEntry = z.infer<typeof agentStateEntrySchema>;

/**
 * The two `unavailable` reasons the ENGINE writes, as opposed to the free text a human types.
 *
 * `reason` stays a free string — it has to, because "back at 3" is a legitimate value — but these
 * two are load-bearing: `isStaffing` and the wallboard both branch on them, and a comparison
 * against a literal spelled out at four call sites is a comparison that eventually disagrees with
 * itself. Anything not in this list came from a person.
 *
 * - `max-no-answer` — the consecutive-ring-out ceiling on `queue_agent.max_no_answer`.
 * - `rona` — a single unanswered offer on a queue with `ronaEnabled`.
 *
 * Both mean the same thing to distribution (this handset is not being answered, stop sending it
 * callers) and different things to a supervisor, which is why they are two values and not one.
 */
export const ENGINE_UNAVAILABLE_REASONS = ["max-no-answer", "rona"] as const;
export type EngineUnavailableReason = (typeof ENGINE_UNAVAILABLE_REASONS)[number];

/** Whether an `unavailable` entry was benched by the distributor rather than by a person. */
export function isEngineBenched(entry: AgentStateEntry): boolean {
	return (
		entry.status === "unavailable" &&
		entry.reason !== undefined &&
		(ENGINE_UNAVAILABLE_REASONS as readonly string[]).includes(entry.reason)
	);
}

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
	/**
	 * Present when the platform owes this caller a CALL, rather than merely holding their place if
	 * they happen to ring back.
	 *
	 * Virtual hold and abandoned-resume are the same fact with different owners of the next move, so
	 * they are the same record with one extra block rather than two stores that can disagree about
	 * who holds which place. Everything that already reads a tombstone keeps working: a callback
	 * token IS a resume promise, so a caller who rings back before the system reaches them claims it
	 * through the ordinary `join`, in the same compare-and-set that deletes it — which is exactly the
	 * "one resume per tombstone" guarantee above, now doing double duty as "we never call somebody
	 * who is already back on the line".
	 *
	 * Optional, so a record written before this existed parses unchanged and a reader that does not
	 * know about callbacks treats every tombstone as the resume promise it always was.
	 */
	callback: z
		.object({
			/** Attempts made so far. Starts at 0; the token is dropped when it reaches `maxAttempts`. */
			attempts: z.int().min(0).max(10),
			/** Attempts allowed, from the queue's compiled callback plan. */
			maxAttempts: z.int().min(1).max(10),
			/** Epoch millis before which no attempt may be made. Set forward after each failure. */
			nextAttemptAt: z.number(),
			/**
			 * The queued call the caller accepted the offer on.
			 *
			 * The CROSS-CALL CDR link, and the only place it can live: a callback is a new `call_id`,
			 * and `call_legs` relates legs INSIDE one call. The engine carries it onto the callback's
			 * `related_call_id`, so a report can put the wait and the call that settled it side by
			 * side. Optional, so a token written before this existed still parses — it simply loses
			 * the link, which is the same amount of linking those reports have today.
			 */
			callId: z.uuid().optional(),
		})
		.optional(),
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
