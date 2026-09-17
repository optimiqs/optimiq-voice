import { expect } from "chai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
	agentDispositionsQuery,
	agentStatsQuery,
	readAgentStats,
	DEFAULT_AGENT_STATS_GROUPS,
	DEFAULT_WRAP_UP_SECONDS,
	MAX_AGENT_STATS_GROUPS,
} from "../../src/cdr/query/agent-stats";
import { agentStatsQuerySchema } from "../../src/cdr/query/cdr.dto";
import type { CdrDatabaseTransaction } from "@optimiq-voice/cdr-db";

/**
 * The agent-statistics query, driven without a database.
 *
 * The same two layers `queueStats.test.ts` uses and for the same reasons: the SQL as a string, from
 * a builder exported unexecuted precisely so this can look at it, and the derivations that are NOT
 * in SQL — the per-agent fold and its re-weighted averages — driven against a fake.
 *
 * What is asserted about the SQL is the half a reviewer cannot see by reading it: that the tenant is
 * never a predicate (RLS is the filter), that the window bounds are unconditional so partitions can
 * be pruned, and that the wrap-up window function partitions by AGENT rather than by the group — an
 * agent who takes a sales call and then a support one had ONE gap between them.
 */

const FROM = new Date("2026-08-05T00:00:00.000Z");
const TO = new Date("2026-08-06T00:00:00.000Z");
const AGENT = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_AGENT = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const QUEUE = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const OTHER_QUEUE = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

const BASE = {
	from: FROM,
	to: TO,
	wrapUpCeilingMs: DEFAULT_WRAP_UP_SECONDS * 1_000,
	limit: DEFAULT_AGENT_STATS_GROUPS,
} as const;

/** A real Drizzle builder over the real schema, so `toSQL()` renders the SQL Postgres would see. */
function realish(): CdrDatabaseTransaction {
	return new QueryBuilder() as unknown as CdrDatabaseTransaction;
}

/** Just the predicates: the projection names columns a whole-statement search would match. */
function predicatesOf(sql: string): string {
	const where = sql.indexOf(" where ");
	return where < 0 ? "" : sql.slice(where);
}

/**
 * Captures the query instead of running it.
 *
 * One more link in the chain than the queue-stats fake — `.limit()` is the last call here and is
 * what has to resolve — and `.as()` has to return something the outer builder can select from, so
 * it returns the builder too.
 */
function fakeTransaction(
	rows: readonly Record<string, unknown>[] = [],
	dispositionRows: readonly Record<string, unknown>[] = [],
): CdrDatabaseTransaction {
	// `readAgentStats` now issues TWO statements against this fake, and they are told apart by the
	// one structural difference between them: the aggregate builds a derived table with `.as()`, the
	// disposition count does not. Keying on that rather than on call order keeps the fake honest if
	// the two are ever reordered or run in parallel — which they are.
	// `readAgentStats` issues TWO statements against this fake, so the chain is keyed on what each
	// one PROJECTS rather than on call order: the aggregate selects `answered`, the disposition count
	// selects `code`. Order would be the wrong key — the two run in parallel.
	const chain = (projection?: Record<string, unknown>): Record<string, unknown> => {
		const wanted =
			projection !== undefined && "code" in projection
				? dispositionRows
				: projection !== undefined && "answered" in projection
					? rows
					: [];
		const builder: Record<string, unknown> = {
			toSQL: () => ({ sql: "", params: [] }),
			select: (next?: Record<string, unknown>) => chain(next),
			from: () => builder,
			where: () => builder,
			as: () => builder,
			groupBy: () => builder,
			orderBy: () => builder,
			limit: () => Promise.resolve(wanted),
		};
		return builder;
	};
	return {
		select: (projection?: Record<string, unknown>) => chain(projection),
	} as unknown as CdrDatabaseTransaction;
}

const GROUP = {
	agentId: AGENT,
	queueId: QUEUE,
	answered: 0,
	talkTimeMs: 0,
	averageTalkTimeMs: 0,
	longestTalkTimeMs: 0,
	averageAnswerWaitMs: 0,
	averageRingTimeMs: 0,
	wrapUpMs: 0,
	wrapUpSamples: 0,
};

describe("agent stats query", () => {
	it("bounds the partition key unconditionally, so no request can scan the ledger", () => {
		const { sql } = agentStatsQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('"started_at" >=');
		expect(sql).to.contain('"started_at" <=');
	});

	it("never puts the organization in the predicate — RLS is the filter", () => {
		const { sql } = agentStatsQuery(realish(), BASE).toSQL();
		expect(predicatesOf(sql)).to.not.contain("organization_id");
	});

	/** A seat is only named on an answered queue leg, and that is what "handled" has to mean. */
	it("counts only answered queue legs that name a seat", () => {
		const { sql } = agentStatsQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('"queue_agent_ref" is not null');
		expect(sql).to.contain('"queue_outcome" =');
	});

	it("partitions the wrap-up gap by agent, not by the group it is reported in", () => {
		const { sql } = agentStatsQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('lead("answered_at") over (partition by "queue_agent_ref"');
		expect(sql).to.not.contain('partition by "queue_agent_ref", "queue_ref"');
	});

	it("groups by agent and queue, so the breakdown exists at all", () => {
		const { sql } = agentStatsQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('group by "agent_legs"."queue_agent_ref", "agent_legs"."queue_ref"');
	});

	it("narrows to one agent when asked, and to one queue, without either leaking otherwise", () => {
		const all = agentStatsQuery(realish(), BASE).toSQL();
		const one = agentStatsQuery(realish(), {
			...BASE,
			agentId: AGENT,
			queueId: QUEUE,
		}).toSQL();
		expect(one.params).to.include(AGENT);
		expect(one.params).to.include(QUEUE);
		expect(all.params).to.not.include(AGENT);
		expect(all.params).to.not.include(QUEUE);
	});

	/** The cap is a ceiling, not a page — but it still has to reach the statement. */
	it("caps the number of groups", () => {
		const { sql, params } = agentStatsQuery(realish(), { ...BASE, limit: 7 }).toSQL();
		expect(sql).to.contain("limit");
		expect(params).to.include(7);
	});
});

describe("the per-agent fold", () => {
	it("sums an agent's queues into one row and keeps the breakdown, busiest first", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([
				{ ...GROUP, queueId: QUEUE, answered: 2, talkTimeMs: 200, averageTalkTimeMs: 100 },
				{ ...GROUP, queueId: OTHER_QUEUE, answered: 8, talkTimeMs: 400, averageTalkTimeMs: 50 },
			]),
			BASE,
		);
		expect(rows).to.have.length(1);
		expect(rows[0]?.answered).to.equal(10);
		expect(rows[0]?.talkTimeMs).to.equal(600);
		expect(rows[0]?.averageTalkTimeMs).to.equal(60);
		expect(rows[0]?.queues.map((queue) => queue.queueId)).to.deep.equal([OTHER_QUEUE, QUEUE]);
	});

	/**
	 * The mean of two per-queue means is not the mean. An agent who took one call from a quiet queue
	 * and ninety from a busy one must not have the quiet queue's wait dominate their number.
	 */
	it("re-weights the per-queue averages by call count rather than averaging averages", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([
				{ ...GROUP, queueId: QUEUE, answered: 1, averageAnswerWaitMs: 100_000 },
				{ ...GROUP, queueId: OTHER_QUEUE, answered: 9, averageAnswerWaitMs: 1_000 },
			]),
			BASE,
		);
		// The naive average of the two means would be 50_500.
		expect(rows[0]?.averageAnswerWaitMs).to.equal(10_900);
	});

	it("takes the worst single call across queues, which an average hides", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([
				{ ...GROUP, answered: 1, longestTalkTimeMs: 30_000 },
				{ ...GROUP, queueId: OTHER_QUEUE, answered: 1, longestTalkTimeMs: 900_000 },
			]),
			BASE,
		);
		expect(rows[0]?.longestTalkTimeMs).to.equal(900_000);
	});

	/** The average is over the GAPS, not over the calls — a reader distrusting it needs the count. */
	it("averages wrap-up over its samples and reports how many there were", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([{ ...GROUP, answered: 10, wrapUpMs: 9_000, wrapUpSamples: 3 }]),
			BASE,
		);
		expect(rows[0]?.wrapUpMs).to.equal(9_000);
		expect(rows[0]?.averageWrapUpMs).to.equal(3_000);
		expect(rows[0]?.wrapUpSamples).to.equal(3);
	});

	it("reports zero rather than NaN for an agent with no gap inside the cap", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([{ ...GROUP, answered: 1, wrapUpMs: 0, wrapUpSamples: 0 }]),
			BASE,
		);
		expect(rows[0]?.averageWrapUpMs).to.equal(0);
	});

	it("orders agents by how many calls they took, with a stable tiebreak", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([
				{ ...GROUP, agentId: AGENT, answered: 3 },
				{ ...GROUP, agentId: OTHER_AGENT, answered: 9 },
			]),
			BASE,
		);
		expect(rows.map((row) => row.agentId)).to.deep.equal([OTHER_AGENT, AGENT]);
	});

	it("drops a group with no agent rather than inventing a seat", async () => {
		const { rows } = await readAgentStats(
			fakeTransaction([{ ...GROUP, agentId: null, answered: 4 }]),
			BASE,
		);
		expect(rows).to.have.length(0);
	});

	/** A short list has to say so: there is no cursor to discover the missing rows with. */
	it("flags truncation when the group cap was reached", async () => {
		const groups = [
			{ ...GROUP, answered: 1 },
			{ ...GROUP, queueId: OTHER_QUEUE, answered: 1 },
		];
		expect(
			(await readAgentStats(fakeTransaction(groups), { ...BASE, limit: 2 })).truncated,
		).to.equal(true);
		expect(
			(await readAgentStats(fakeTransaction(groups), { ...BASE, limit: 3 })).truncated,
		).to.equal(false);
	});
});

describe("the agent-stats query dto", () => {
	it("defaults the wrap-up cap rather than demanding one", () => {
		expect(agentStatsQuerySchema.parse({}).wrapUpSeconds).to.equal(DEFAULT_WRAP_UP_SECONDS);
	});

	it("defaults the group ceiling and refuses one past the cap", () => {
		expect(agentStatsQuerySchema.parse({}).limit).to.equal(DEFAULT_AGENT_STATS_GROUPS);
		expect(() =>
			agentStatsQuerySchema.parse({ limit: String(MAX_AGENT_STATS_GROUPS + 1) }),
		).to.throw();
	});

	it("coerces from a query string, which is where these always come from", () => {
		expect(agentStatsQuerySchema.parse({ wrapUpSeconds: "300" }).wrapUpSeconds).to.equal(300);
	});

	it("refuses an agent id that is not a uuid, so it can never reach the predicate", () => {
		expect(() => agentStatsQuerySchema.parse({ agentId: "'; drop table call_legs" })).to.throw();
	});

	it("refuses an unknown parameter rather than silently ignoring a typo", () => {
		expect(() => agentStatsQuerySchema.parse({ organizationId: AGENT })).to.throw();
	});
});

/**
 * The disposition breakdown — the one number on this report that is a MEASUREMENT rather than a
 * proxy, and the module header says so plainly. Nothing here is capped, sampled or approximated:
 * an agent pressed a button, or the wrap-up deadline recorded `unset`, and both were observed.
 */
describe("the disposition breakdown", () => {
	it("counts by agent and code and never predicates on the tenant", () => {
		const { sql } = agentDispositionsQuery(realish(), BASE).toSQL();
		expect(predicatesOf(sql)).to.not.include("organization_id");
		expect(sql).to.include("group by");
		expect(sql).to.include('"queue_disposition_code"');
	});

	/**
	 * A NULL code is a queue that asks no wrap-up question, not an agent who ignored a prompt.
	 * Folding the two together would put every unconfigured queue's traffic in the same bucket as
	 * every unanswered one, which is the single most misleading thing this list could do.
	 */
	it("excludes legs with no code at all", () => {
		const { sql } = agentDispositionsQuery(realish(), BASE).toSQL();
		expect(predicatesOf(sql)).to.include('"queue_disposition_code" is not null');
	});

	it("keeps the same population as the aggregate beside it", () => {
		const predicates = predicatesOf(agentDispositionsQuery(realish(), BASE).toSQL().sql);
		// Answered queue legs only, and the window bounds unconditional so partitions can be pruned.
		expect(predicates).to.include('"queue_outcome"');
		expect(predicates).to.include('"queue_agent_ref" is not null');
		expect(predicates).to.include('"started_at"');
	});

	it("narrows to one agent and to one queue, exactly as the aggregate does", () => {
		const forOne = predicatesOf(
			agentDispositionsQuery(realish(), { ...BASE, agentId: AGENT, queueId: QUEUE }).toSQL().sql,
		);
		expect(forOne).to.include('"queue_agent_ref" =');
		expect(forOne).to.include('"queue_ref" =');
	});

	it("attaches each agent's codes to their row, commonest first", async () => {
		const result = await readAgentStats(
			fakeTransaction(
				[
					{
						agentId: AGENT,
						queueId: QUEUE,
						answered: 10,
						talkTimeMs: 1_000,
						averageTalkTimeMs: 100,
						longestTalkTimeMs: 200,
						averageAnswerWaitMs: 0,
						averageRingTimeMs: 0,
						wrapUpMs: 0,
						wrapUpSamples: 0,
					},
				],
				[
					{ agentId: AGENT, code: "sale", count: 6 },
					{ agentId: AGENT, code: "unset", count: 3 },
					{ agentId: OTHER_AGENT, code: "escalated", count: 1 },
				],
			),
			BASE,
		);
		expect(result.rows[0]?.dispositions).to.deep.equal([
			{ code: "sale", count: 6 },
			{ code: "unset", count: 3 },
		]);
	});

	/**
	 * The counts do NOT have to sum to `answered`: a leg dispositioned after the CDR consumer filed
	 * it keeps its NULL, and a queue that started asking halfway through the window has both kinds
	 * in it. Reconciling them here would mean inventing a code for the difference.
	 */
	it("does not require the codes to account for every answered call", async () => {
		const result = await readAgentStats(
			fakeTransaction(
				[
					{
						agentId: AGENT,
						queueId: QUEUE,
						answered: 10,
						talkTimeMs: 1_000,
						averageTalkTimeMs: 100,
						longestTalkTimeMs: 200,
						averageAnswerWaitMs: 0,
						averageRingTimeMs: 0,
						wrapUpMs: 0,
						wrapUpSamples: 0,
					},
				],
				[{ agentId: AGENT, code: "sale", count: 2 }],
			),
			BASE,
		);
		expect(result.rows[0]?.answered).to.equal(10);
		expect(result.rows[0]?.dispositions).to.deep.equal([{ code: "sale", count: 2 }]);
	});

	it("gives an agent on a queue that asks nothing an empty list, not a missing key", async () => {
		const result = await readAgentStats(
			fakeTransaction([
				{
					agentId: AGENT,
					queueId: QUEUE,
					answered: 1,
					talkTimeMs: 10,
					averageTalkTimeMs: 10,
					longestTalkTimeMs: 10,
					averageAnswerWaitMs: 0,
					averageRingTimeMs: 0,
					wrapUpMs: 0,
					wrapUpSamples: 0,
				},
			]),
			BASE,
		);
		expect(result.rows[0]?.dispositions).to.deep.equal([]);
	});
});
