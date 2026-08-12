import { and, callLegs, eq, gte, isNotNull, lte, sql } from "@optimiq-voice/cdr-db";
import type { CdrDatabaseTransaction, SQL } from "@optimiq-voice/cdr-db";

/**
 * Queue service level, over a window — the query behind a wallboard and the SLA widgets.
 *
 * ## Why this is SQL over `call_legs` and not a replay of `queue.evt.v1.*`
 *
 * The events carry every fact this needs, durably and replayably, and a live wallboard reads them
 * exactly that way. What a stream cannot answer is the question a supervisor asks on Monday: "what
 * was our service level last week, by queue". That is an aggregate over a TIME WINDOW on rows that
 * are already partitioned by time and already scoped by RLS. Rebuilding it from a log on every
 * request would be a scan with no index on any column being asked about, and it would have to
 * re-derive the tenant boundary in application code — which is the one boundary this codebase never
 * re-derives.
 *
 * So the queue's verdict is written to the ledger beside the numbers it is reported alongside
 * (`call_legs.queue_outcome` and friends), and this is one grouped scan of a partial index.
 *
 * ## The one aggregate query in a package that has argued against them
 *
 * `cdr.repository.ts` refuses to give a listing a `total`, and the argument there is right: a
 * `count(*)` over a partitioned ledger is a scan of every partition in the range, paid on every
 * page of every listing. This is the case that argument does not cover. A statistic IS the
 * aggregate — there is no cheaper shape of the answer — it is asked once rather than per page, and
 * it runs against `call_legs_queue_idx`, a PARTIAL index on `queue_outcome is not null` whose
 * leading columns are exactly this query's predicates. A tenant's queue traffic is a small fraction
 * of their legs, and the index means the scan is over that fraction rather than over the ledger.
 *
 * The honest ceiling, and it is why `MAX_RANGE_DAYS` still applies: this is a live query, not a
 * rollup. It is right for a wallboard's day and a supervisor's quarter, and it is the wrong shape
 * for a year of a large tenant. The seam when that arrives is a materialised hourly rollup keyed
 * `(organization_id, queue_ref, hour)`; this function's SIGNATURE is what such a rollup would keep,
 * so the endpoint above it would not change.
 *
 * ## What it deliberately does not do
 *
 * It does not join `pbx-db` to name the queues. `queueRef` is a uuid and this database holds no
 * queue names — the caller already has the queue list from `GET /queues` and can label the rows
 * itself, which is one HTTP request rather than a cross-database join this architecture does not
 * have. Nor does it name agents: `queue_agent_ref` is a row id, and who sat in that seat is
 * `pbx-db`'s to answer, for anyone allowed to ask it.
 */

/** The service-level target: the fraction of offered calls answered inside this many seconds. */
export const DEFAULT_SLA_SECONDS = 20;
export const MAX_SLA_SECONDS = 3_600;

export interface QueueStatsRow {
	readonly queueId: string;
	/**
	 * Every call the queue was asked to serve in the window — answered plus every way of not being.
	 *
	 * The SLA denominator, and the reason `queue_outcome` is a column rather than something inferred
	 * from the leg's disposition: a caller the queue timed out into a voicemail box has a leg that
	 * ended `answered`, and counting them as served is how a queue nobody staffs reports perfectly.
	 */
	readonly offered: number;
	readonly answered: number;
	/** The caller hung up while holding. The number a supervisor reacts to. */
	readonly abandoned: number;
	/** A wait deadline expired and the queue sent them to its timeout branch. */
	readonly timedOut: number;
	/** Nobody was logged in at all. Distinct from `timedOut`, because the fix is different. */
	readonly noAgents: number;
	/** The caller pressed the exit key. A CHOICE, which is why it is not folded into `abandoned`. */
	readonly exited: number;
	/**
	 * Mean wait across ANSWERED calls only, in milliseconds.
	 *
	 * Answered only, deliberately. An average that included abandonments would move whenever callers
	 * gave up sooner, so a queue getting worse could show a falling average hold time — the classic
	 * contact-centre metric that reports the opposite of what happened. Abandonment has its own
	 * average below, which is the number that tells you how long people are willing to wait.
	 */
	readonly averageAnswerWaitMs: number;
	readonly averageAbandonWaitMs: number;
	/** The worst wait any answered caller had. An average hides exactly this. */
	readonly longestAnswerWaitMs: number;
	/**
	 * Answered inside the target, as a percentage of OFFERED, rounded to one decimal.
	 *
	 * Of offered and not of answered, which is the definition that matters and the one people get
	 * wrong: "90% of answered calls were answered quickly" is true of a queue that answers two calls
	 * and abandons a hundred. `null` when nothing was offered — a queue with no traffic has no
	 * service level, and reporting 0 would make an idle queue look like a failing one on a wallboard.
	 */
	readonly serviceLevelPct: number | null;
	/** How many of the offered calls beat the target. The numerator, exposed so the maths is checkable. */
	readonly withinTarget: number;
}

export interface QueueStatsQuery {
	readonly from: Date;
	readonly to: Date;
	readonly slaSeconds: number;
	/** One queue, or every queue with traffic in the window. */
	readonly queueId?: string;
}

/**
 * Builds the grouped aggregate. Exported unexecuted so a spec can assert its SQL without a database
 * — the same shape `sip-auth-event-query.ts` uses for the same reason.
 */
export function queueStatsQuery(
	transaction: CdrDatabaseTransaction,
	query: QueueStatsQuery,
): { toSQL(): { sql: string; params: unknown[] } } {
	const targetMs = query.slaSeconds * 1_000;
	const filters: SQL[] = [
		// The partition bounds first, unconditionally, so the planner can prune before it reads.
		gte(callLegs.startedAt, query.from),
		lte(callLegs.startedAt, query.to),
		// Matches `call_legs_queue_idx`, a partial index over exactly this predicate. It is also what
		// makes "offered" mean what it says: a leg with no queue verdict never entered a queue.
		isNotNull(callLegs.queueOutcome),
		isNotNull(callLegs.queueRef),
	] as SQL[];
	if (query.queueId !== undefined) {
		filters.push(eq(callLegs.queueRef, query.queueId) as SQL);
	}

	// `filter (where …)` rather than `sum(case when … then 1 else 0 end)`: one pass, and the average
	// aggregates below need the filtered form anyway — an `avg` over a CASE would average the NULLs
	// out of the denominator in one dialect and into it in another.
	return transaction
		.select({
			queueId: callLegs.queueRef,
			offered: sql<number>`count(*)`.mapWith(Number),
			answered: sql<number>`count(*) filter (where ${callLegs.queueOutcome} = 'answered')`.mapWith(
				Number,
			),
			abandoned:
				sql<number>`count(*) filter (where ${callLegs.queueOutcome} = 'caller-hangup')`.mapWith(
					Number,
				),
			timedOut: sql<number>`count(*) filter (where ${callLegs.queueOutcome} = 'timeout')`.mapWith(
				Number,
			),
			noAgents: sql<number>`count(*) filter (where ${callLegs.queueOutcome} = 'no-agents')`.mapWith(
				Number,
			),
			exited: sql<number>`count(*) filter (where ${callLegs.queueOutcome} = 'exit-key')`.mapWith(
				Number,
			),
			// `coalesce(…, 0)` because `avg` over an empty set is NULL, and a queue with abandonments
			// and no answers would otherwise hand the API a null it would have to decide about twice.
			averageAnswerWaitMs:
				sql<number>`coalesce(round(avg(${callLegs.queueWaitMs}) filter (where ${callLegs.queueOutcome} = 'answered')), 0)`.mapWith(
					Number,
				),
			averageAbandonWaitMs:
				sql<number>`coalesce(round(avg(${callLegs.queueWaitMs}) filter (where ${callLegs.queueOutcome} = 'caller-hangup')), 0)`.mapWith(
					Number,
				),
			longestAnswerWaitMs:
				sql<number>`coalesce(max(${callLegs.queueWaitMs}) filter (where ${callLegs.queueOutcome} = 'answered'), 0)`.mapWith(
					Number,
				),
			withinTarget:
				sql<number>`count(*) filter (where ${callLegs.queueOutcome} = 'answered' and ${callLegs.queueWaitMs} <= ${targetMs})`.mapWith(
					Number,
				),
		})
		.from(callLegs)
		.where(and(...filters))
		.groupBy(callLegs.queueRef)
		.orderBy(callLegs.queueRef) as never;
}

/** Runs it and derives the one field SQL should not: a percentage with a divide-by-zero in it. */
export async function readQueueStats(
	transaction: CdrDatabaseTransaction,
	query: QueueStatsQuery,
): Promise<readonly QueueStatsRow[]> {
	const rows = (await (queueStatsQuery(transaction, query) as unknown as Promise<
		readonly (Omit<QueueStatsRow, "serviceLevelPct" | "queueId"> & {
			readonly queueId: string | null;
		})[]
	>)) as readonly (Omit<QueueStatsRow, "serviceLevelPct" | "queueId"> & {
		readonly queueId: string | null;
	})[];

	return rows.flatMap((row) =>
		row.queueId === null
			? []
			: [
					{
						...row,
						queueId: row.queueId,
						serviceLevelPct:
							row.offered === 0 ? null : Math.round((row.withinTarget / row.offered) * 1_000) / 10,
					},
				],
	);
}
