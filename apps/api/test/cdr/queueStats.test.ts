import { expect } from "chai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { queueStatsQuerySchema } from "../../src/cdr/query/cdr.dto";
import {
	queueStatsQuery,
	readQueueStats,
	DEFAULT_SLA_SECONDS,
} from "../../src/cdr/query/queue-stats";
import type { CdrDatabaseTransaction } from "@optimiq-voice/cdr-db";

/**
 * The queue-statistics query, driven without a database.
 *
 * Two layers, matching the shape the CDR area already tests in: the SQL as a string (built by a
 * function that is exported unexecuted precisely so this can look at it), and the one derivation
 * that is NOT in SQL — a percentage with a divide-by-zero in it — driven against a fake.
 *
 * What is asserted about the SQL is the half a reviewer cannot see by reading it: that the tenant is
 * never a predicate (RLS is the filter, and an organization id in this query would be the beginning
 * of a second, weaker boundary), and that the window bounds are unconditional so the planner can
 * prune partitions.
 */

const FROM = new Date("2026-08-05T00:00:00.000Z");
const TO = new Date("2026-08-06T00:00:00.000Z");
const QUEUE = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

/**
 * A real Drizzle builder over the real schema, so `toSQL()` renders the SQL Postgres would see.
 *
 * `QueryBuilder` and not a fake, and not a driver: the assertions here are about the SQL TEXT, and a
 * fake that returned a string would be asserting against itself. It is the same construction
 * `sipAuthEvents.test.ts` uses, for the same reason and with the same slicing of the statement — the
 * SELECT projection names columns that a naive substring search over the whole query would match.
 */
function realish(): CdrDatabaseTransaction {
	return new QueryBuilder() as unknown as CdrDatabaseTransaction;
}

/** Just the predicates: the projection names columns a whole-statement search would match. */
function predicatesOf(sql: string): string {
	const where = sql.indexOf(" where ");
	return where < 0 ? "" : sql.slice(where);
}

/** Captures the query instead of running it. `select().from().where()…` returns `this`. */
function fakeTransaction(rows: readonly Record<string, unknown>[] = []): CdrDatabaseTransaction {
	const builder = {
		toSQL: () => ({ sql: "", params: [] }),
		select: () => builder,
		from: () => builder,
		where: () => builder,
		groupBy: () => builder,
		orderBy: () => Promise.resolve(rows),
	};
	return builder as unknown as CdrDatabaseTransaction;
}

describe("queue stats query", () => {
	it("bounds the partition key unconditionally, so no request can scan the ledger", () => {
		const { sql } = queueStatsQuery(realish(), {
			from: FROM,
			to: TO,
			slaSeconds: DEFAULT_SLA_SECONDS,
		}).toSQL();
		expect(sql).to.contain('"started_at" >=');
		expect(sql).to.contain('"started_at" <=');
	});

	it("never puts the organization in the predicate — RLS is the filter", () => {
		const { sql } = queueStatsQuery(realish(), {
			from: FROM,
			to: TO,
			slaSeconds: DEFAULT_SLA_SECONDS,
		}).toSQL();
		expect(predicatesOf(sql)).to.not.contain("organization_id");
	});

	it("selects only legs with a queue verdict, which is what `offered` means", () => {
		const { sql } = queueStatsQuery(realish(), {
			from: FROM,
			to: TO,
			slaSeconds: DEFAULT_SLA_SECONDS,
		}).toSQL();
		expect(sql).to.contain('"queue_outcome" is not null');
	});

	it("narrows to one queue when asked, and groups by queue either way", () => {
		const all = queueStatsQuery(realish(), {
			from: FROM,
			to: TO,
			slaSeconds: DEFAULT_SLA_SECONDS,
		}).toSQL();
		const one = queueStatsQuery(realish(), {
			from: FROM,
			to: TO,
			slaSeconds: DEFAULT_SLA_SECONDS,
			queueId: QUEUE,
		}).toSQL();
		expect(all.sql).to.contain("group by");
		expect(one.params).to.include(QUEUE);
		expect(all.params).to.not.include(QUEUE);
	});
});

describe("the service level", () => {
	async function statsOf(row: Record<string, unknown>) {
		const rows = await readQueueStats(fakeTransaction([row]), {
			from: FROM,
			to: TO,
			slaSeconds: 20,
		});
		return rows[0];
	}

	const base = {
		queueId: QUEUE,
		offered: 0,
		answered: 0,
		abandoned: 0,
		timedOut: 0,
		noAgents: 0,
		exited: 0,
		averageAnswerWaitMs: 0,
		averageAbandonWaitMs: 0,
		longestAnswerWaitMs: 0,
		withinTarget: 0,
	};

	/**
	 * Of OFFERED, not of answered. "90% of answered calls were answered quickly" is true of a queue
	 * that answers two calls and abandons a hundred, and it is the definition people reach for.
	 */
	it("divides by offered, so abandonments count against the service level", async () => {
		const stats = await statsOf({
			...base,
			offered: 10,
			answered: 4,
			abandoned: 6,
			withinTarget: 4,
		});
		expect(stats?.serviceLevelPct).to.equal(40);
	});

	it("rounds to one decimal, so a wallboard is not rendering fifteen digits", async () => {
		const stats = await statsOf({ ...base, offered: 3, answered: 1, withinTarget: 1 });
		expect(stats?.serviceLevelPct).to.equal(33.3);
	});

	/** An idle queue has no service level. Reporting 0 would make it look like a failing one. */
	it("reports null rather than 0 for a queue with no traffic", async () => {
		const stats = await statsOf({ ...base, offered: 0 });
		expect(stats?.serviceLevelPct).to.equal(null);
	});

	it("drops a group with no queue id rather than inventing one", async () => {
		const rows = await readQueueStats(fakeTransaction([{ ...base, queueId: null }]), {
			from: FROM,
			to: TO,
			slaSeconds: 20,
		});
		expect(rows).to.have.length(0);
	});
});

describe("the queue-stats query dto", () => {
	it("defaults the target rather than demanding one", () => {
		expect(queueStatsQuerySchema.parse({}).slaSeconds).to.equal(DEFAULT_SLA_SECONDS);
	});

	it("coerces the target from a query string, which is where it always comes from", () => {
		expect(queueStatsQuerySchema.parse({ slaSeconds: "60" }).slaSeconds).to.equal(60);
	});

	it("refuses a target of zero, which would make every answer late", () => {
		expect(() => queueStatsQuerySchema.parse({ slaSeconds: "0" })).to.throw();
	});

	it("refuses a queue id that is not a uuid, so it can never reach the predicate", () => {
		expect(() => queueStatsQuerySchema.parse({ queueId: "'; drop table call_legs" })).to.throw();
	});
});
