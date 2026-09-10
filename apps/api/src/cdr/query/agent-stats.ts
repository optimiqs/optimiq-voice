import { and, callLegs, eq, gte, isNotNull, lte, sql } from "@optimiq-voice/cdr-db";
import type { CdrDatabaseTransaction, SQL } from "@optimiq-voice/cdr-db";

/**
 * Per-agent handling statistics over a window — "how did the floor do last week", by seat.
 *
 * ## Why this lives beside `queue-stats.ts` and reads the same rows
 *
 * A queue's service level and an agent's handling are the two halves of one question, and they are
 * answered from the same six columns of the same ledger. Splitting them across two data sources —
 * a live agent-state projection for one and `call_legs` for the other — is how a supervisor ends up
 * with a screen where the queue answered 300 calls and its four agents answered 280, because the
 * projection was restarted on Tuesday. The ledger is the only thing on this platform that is
 * durable, replay-free and already tenant-scoped, so both numbers come out of it.
 *
 * `queue_agent_ref` is the key and it is a `queue_agent` ROW id, not a user id: this database holds
 * no user ids at all. Who sat in that seat is `pbx-db`'s to answer, for whoever is allowed to ask
 * it — the same division `queue-stats.ts` makes about queue names, and for the same reason.
 *
 * ## Wrap-up is a PROXY, and the comment saying so is the feature
 *
 * Nothing on this platform records an after-call-work state. There is no `wrap_up_ms` column
 * because there is no moment at which anything knows the agent finished typing. What IS in the
 * ledger is when an agent's call ended and when their next one was answered, and the gap between
 * those two is the only after-call measurement the data can support.
 *
 * So that is what this reports, and it is CAPPED — see {@link AgentStatsQuery.wrapUpCeilingMs}.
 * Uncapped, the gap between the last call before lunch and the first one after it is an hour of
 * "wrap-up", and an agent who took two calls all day would top the report. Capped, what is left is
 * the recovery time between calls in a working stretch, which is the thing a supervisor is actually
 * looking for. It is exposed alongside `wrapUpSamples` so a reader can see how many gaps went into
 * it and distrust an average built from three of them.
 *
 * The honest alternative was to omit the field. It is not omitted because the number is genuinely
 * useful and because a report that silently lacks it invites somebody to compute it downstream from
 * the raw CDR with no cap at all.
 *
 * ## The cost, and the ceiling
 *
 * One scan of `call_legs_queue_agent_idx` — a PARTIAL index on `queue_agent_ref is not null`, which
 * is a strict subset of the legs the queue index already covers — plus one sort per agent for the
 * window function. `MAX_RANGE_DAYS` applies for the reason it applies to `queue-stats.ts`: this is
 * a live query, not a rollup, and a request's cost is proportional to the window it names. The seam
 * when a large tenant wants a year is a materialised daily rollup keyed
 * `(organization_id, queue_agent_ref, day)`; this function's SIGNATURE is what such a rollup would
 * keep, so nothing above it would change.
 *
 * ## Why the result is bounded by a limit and not by a cursor
 *
 * `cdr.repository.ts` refuses a `total` and pages by keyset, because a listing over a ledger is
 * unbounded. This is not that. A tenant has agents — tens, sometimes hundreds — and the grouped
 * result is agents × the queues they took calls from, which is bounded by CONFIGURATION rather than
 * by traffic. A keyset cursor over aggregate groups would have to be stable across a window whose
 * contents change under it, which is a correctness problem invented to solve a size problem that
 * does not exist. So the group count is capped, the cap is stated, and the caller is told when it
 * was hit rather than being handed a silently short list.
 */

/**
 * The longest gap between two of an agent's calls that still counts as after-call work.
 *
 * Two minutes: long enough for the disposition note a contact centre actually asks for, short
 * enough that a coffee break is not billed to the previous caller. Overridable per request because
 * it is a QUESTION and not a setting — the same argument `slaSeconds` makes in `queue-stats.ts`.
 */
export const DEFAULT_WRAP_UP_SECONDS = 120;
export const MAX_WRAP_UP_SECONDS = 3_600;

/**
 * The most (agent, queue) groups one request may return, and the default.
 *
 * A ceiling rather than a page size: see the header. Two thousand groups is far past any real
 * tenant's agents × queues, so reaching it means something is wrong rather than that somebody
 * needs the next page.
 */
export const DEFAULT_AGENT_STATS_GROUPS = 500;
export const MAX_AGENT_STATS_GROUPS = 2_000;

/** One agent's numbers inside ONE queue. The breakdown, not the total. */
export interface AgentQueueStatsRow {
	readonly queueId: string;
	readonly answered: number;
	readonly talkTimeMs: number;
	readonly averageTalkTimeMs: number;
	/**
	 * How long the CALLER waited before this agent took it, averaged over this agent's answers.
	 *
	 * An agent statistic that is not about the agent, deliberately kept here: it is the number that
	 * distinguishes an agent who answers the calls nobody else got to from one who is cherry-picking
	 * a queue that never queues. Read on its own it says nothing about performance, which is exactly
	 * why it belongs beside the ones that do.
	 */
	readonly averageAnswerWaitMs: number;
}

export interface AgentStatsRow {
	readonly agentId: string;
	/** Calls this agent took from a queue in the window. The denominator of everything else. */
	readonly answered: number;
	/**
	 * Total billed talk time, in milliseconds — `billsec_ms`, answer to hangup.
	 *
	 * `billsec_ms` and not `duration_ms`: the difference between them is the agent's phone ringing,
	 * and counting ring time as talk time makes an agent who misses calls look busy.
	 */
	readonly talkTimeMs: number;
	readonly averageTalkTimeMs: number;
	/** The longest single call. An average hides exactly this, and it is where the outliers are. */
	readonly longestTalkTimeMs: number;
	/** Mean caller wait across this agent's answers. See {@link AgentQueueStatsRow}. */
	readonly averageAnswerWaitMs: number;
	/**
	 * Mean time between the agent's phone starting to ring and them picking it up.
	 *
	 * `duration_ms - billsec_ms` on the AGENT's leg, which is the one measurement of an agent's own
	 * responsiveness the ledger can make without guessing. Never negative: the writer sets
	 * `billsec_ms` to zero on an unanswered leg and these rows are all answered ones.
	 */
	readonly averageRingTimeMs: number;
	/** Total capped inter-call gap. A PROXY for after-call work — see the module header. */
	readonly wrapUpMs: number;
	readonly averageWrapUpMs: number;
	/** How many gaps went into the two fields above, so a reader can distrust a small sample. */
	readonly wrapUpSamples: number;
	/** Per-queue breakdown, busiest queue first. */
	readonly queues: readonly AgentQueueStatsRow[];
}

export interface AgentStatsQuery {
	readonly from: Date;
	readonly to: Date;
	/** Gaps longer than this are a break, not wrap-up. See {@link DEFAULT_WRAP_UP_SECONDS}. */
	readonly wrapUpCeilingMs: number;
	/** One agent, or every agent who took a call in the window. */
	readonly agentId?: string;
	/** One queue, or every queue. Narrows the ROWS, not the wrap-up window function's partition. */
	readonly queueId?: string;
	/** The group ceiling. See {@link MAX_AGENT_STATS_GROUPS}. */
	readonly limit: number;
}

/** The shape the grouped SELECT returns, before the per-agent fold. */
interface AgentStatsGroup {
	readonly agentId: string | null;
	readonly queueId: string | null;
	readonly answered: number;
	readonly talkTimeMs: number;
	readonly averageTalkTimeMs: number;
	readonly longestTalkTimeMs: number;
	readonly averageAnswerWaitMs: number;
	readonly averageRingTimeMs: number;
	readonly wrapUpMs: number;
	readonly wrapUpSamples: number;
}

/**
 * Builds the grouped aggregate. Exported unexecuted so a spec can assert its SQL without a database
 * — the same shape `queue-stats.ts` uses, for the same reason.
 *
 * It is two levels rather than one because of the wrap-up gap: `lead()` is a ROW-level function and
 * cannot be nested inside an aggregate, so the gap is computed in a derived table and summed above
 * it. The window is partitioned by AGENT and not by (agent, queue) on purpose — an agent who takes
 * a sales call and then a support call had one gap between them, and partitioning by queue would
 * either count it twice or not at all depending on which way the rows fell.
 */
export function agentStatsQuery(
	transaction: CdrDatabaseTransaction,
	query: AgentStatsQuery,
): { toSQL(): { sql: string; params: unknown[] } } {
	const filters: SQL[] = [
		// The partition bounds first, unconditionally, so the planner can prune before it reads.
		gte(callLegs.startedAt, query.from),
		lte(callLegs.startedAt, query.to),
		// Matches `call_legs_queue_agent_idx`, a partial index over exactly this predicate. It is
		// also the definition of the population: a leg with no agent was not handled by one.
		isNotNull(callLegs.queueAgentRef),
		// `queue_outcome = 'answered'` and not `disposition = 'answered'`: a caller the queue timed
		// out into a voicemail box has a leg that ended answered, and crediting that to the agent
		// whose seat the call last rang is how a queue nobody staffs reports a full team.
		eq(callLegs.queueOutcome, "answered"),
	] as SQL[];
	if (query.agentId !== undefined) {
		filters.push(eq(callLegs.queueAgentRef, query.agentId) as SQL);
	}
	if (query.queueId !== undefined) {
		filters.push(eq(callLegs.queueRef, query.queueId) as SQL);
	}

	const legs = transaction
		.select({
			agentId: callLegs.queueAgentRef,
			queueId: callLegs.queueRef,
			billsecMs: callLegs.billsecMs,
			queueWaitMs: callLegs.queueWaitMs,
			// Clamped at zero rather than trusted: `duration_ms` and `billsec_ms` are written by two
			// different moments of the hangup path, and a negative "ring time" in a report is worse
			// than a zero one.
			ringMs: sql<number>`greatest(${callLegs.durationMs} - ${callLegs.billsecMs}, 0)`.as(
				"ring_ms",
			),
			gapMs:
				sql<number>`extract(epoch from (lead(${callLegs.answeredAt}) over (partition by ${callLegs.queueAgentRef} order by ${callLegs.answeredAt}) - ${callLegs.endedAt})) * 1000`.as(
					"gap_ms",
				),
		})
		.from(callLegs)
		.where(and(...filters))
		.as("agent_legs");

	// `filter (where …)` rather than `sum(case when … end)`, for the reason `queue-stats.ts` gives:
	// one pass, and an `avg` over a CASE averages the NULLs into the denominator in one dialect and
	// out of it in another.
	const inWindow = sql`${legs.gapMs} >= 0 and ${legs.gapMs} <= ${query.wrapUpCeilingMs}`;

	return (
		transaction
			.select({
				agentId: legs.agentId,
				queueId: legs.queueId,
				answered: sql<number>`count(*)`.mapWith(Number),
				talkTimeMs: sql<number>`coalesce(sum(${legs.billsecMs}), 0)`.mapWith(Number),
				averageTalkTimeMs: sql<number>`coalesce(round(avg(${legs.billsecMs})), 0)`.mapWith(Number),
				longestTalkTimeMs: sql<number>`coalesce(max(${legs.billsecMs}), 0)`.mapWith(Number),
				averageAnswerWaitMs: sql<number>`coalesce(round(avg(${legs.queueWaitMs})), 0)`.mapWith(
					Number,
				),
				averageRingTimeMs: sql<number>`coalesce(round(avg(${legs.ringMs})), 0)`.mapWith(Number),
				wrapUpMs:
					sql<number>`coalesce(round(sum(${legs.gapMs}) filter (where ${inWindow})), 0)`.mapWith(
						Number,
					),
				wrapUpSamples: sql<number>`count(*) filter (where ${inWindow})`.mapWith(Number),
			})
			.from(legs)
			.groupBy(legs.agentId, legs.queueId)
			// Busiest first, then a stable tiebreak, so the cap below cuts off the tail rather than an
			// arbitrary slice — a truncated report has to lose the rows nobody was going to read.
			.orderBy(sql`count(*) desc`, legs.agentId, legs.queueId)
			.limit(query.limit) as never
	);
}

export interface AgentStatsResult {
	readonly rows: readonly AgentStatsRow[];
	/** The group cap was reached, so an agent's per-queue breakdown may be incomplete. */
	readonly truncated: boolean;
}

/**
 * Runs it and folds the (agent, queue) groups into one row per agent.
 *
 * The fold is here and not in SQL because doing it in SQL means either two round trips or
 * `jsonb_agg`, and the second buries the per-queue shape inside a blob this codebase would then
 * have to re-validate. Indexed through a `Map` rather than a `.find` per group: the group count is
 * bounded but the quadratic version is bounded by the same number squared, and there is no reason
 * to write it.
 */
export async function readAgentStats(
	transaction: CdrDatabaseTransaction,
	query: AgentStatsQuery,
): Promise<AgentStatsResult> {
	const groups = (await (agentStatsQuery(transaction, query) as unknown as Promise<
		readonly AgentStatsGroup[]
	>)) as readonly AgentStatsGroup[];

	const byAgent = new Map<
		string,
		{
			agentId: string;
			answered: number;
			talkTimeMs: number;
			longestTalkTimeMs: number;
			weightedWaitMs: number;
			weightedRingMs: number;
			wrapUpMs: number;
			wrapUpSamples: number;
			queues: AgentQueueStatsRow[];
		}
	>();

	for (const group of groups) {
		// A group with no agent cannot happen — the predicate excludes it — but the column is
		// nullable, so it is dropped rather than coerced into a row keyed on the string "null".
		if (group.agentId === null) {
			continue;
		}
		let agent = byAgent.get(group.agentId);
		if (agent === undefined) {
			agent = {
				agentId: group.agentId,
				answered: 0,
				talkTimeMs: 0,
				longestTalkTimeMs: 0,
				weightedWaitMs: 0,
				weightedRingMs: 0,
				wrapUpMs: 0,
				wrapUpSamples: 0,
				queues: [],
			};
			byAgent.set(group.agentId, agent);
		}
		agent.answered += group.answered;
		agent.talkTimeMs += group.talkTimeMs;
		agent.longestTalkTimeMs = Math.max(agent.longestTalkTimeMs, group.longestTalkTimeMs);
		// Re-weighted by the group's call count rather than averaged: the mean of two per-queue means
		// is not the mean, and an agent who took one call from a quiet queue and ninety from a busy
		// one would otherwise have the quiet queue's wait dominate their number.
		agent.weightedWaitMs += group.averageAnswerWaitMs * group.answered;
		agent.weightedRingMs += group.averageRingTimeMs * group.answered;
		agent.wrapUpMs += group.wrapUpMs;
		agent.wrapUpSamples += group.wrapUpSamples;
		if (group.queueId !== null) {
			agent.queues.push({
				queueId: group.queueId,
				answered: group.answered,
				talkTimeMs: group.talkTimeMs,
				averageTalkTimeMs: group.averageTalkTimeMs,
				averageAnswerWaitMs: group.averageAnswerWaitMs,
			});
		}
	}

	const rows = [...byAgent.values()]
		.map((agent) => ({
			agentId: agent.agentId,
			answered: agent.answered,
			talkTimeMs: agent.talkTimeMs,
			averageTalkTimeMs: agent.answered === 0 ? 0 : Math.round(agent.talkTimeMs / agent.answered),
			longestTalkTimeMs: agent.longestTalkTimeMs,
			averageAnswerWaitMs:
				agent.answered === 0 ? 0 : Math.round(agent.weightedWaitMs / agent.answered),
			averageRingTimeMs:
				agent.answered === 0 ? 0 : Math.round(agent.weightedRingMs / agent.answered),
			wrapUpMs: agent.wrapUpMs,
			averageWrapUpMs:
				agent.wrapUpSamples === 0 ? 0 : Math.round(agent.wrapUpMs / agent.wrapUpSamples),
			wrapUpSamples: agent.wrapUpSamples,
			queues: [...agent.queues].sort((left, right) => right.answered - left.answered),
		}))
		.sort(
			(left, right) => right.answered - left.answered || left.agentId.localeCompare(right.agentId),
		);

	return { rows, truncated: groups.length >= query.limit };
}
