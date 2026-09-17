import { expect } from "chai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
	callVolumeDestinationQuery,
	callVolumeQuery,
	readCallVolume,
	DEFAULT_VOLUME_BUCKET,
	MAX_VOLUME_BUCKETS,
} from "../../src/cdr/query/call-volume";
import { callVolumeQuerySchema, MAX_RANGE_DAYS } from "../../src/cdr/query/cdr.dto";
import type { CdrDatabaseTransaction } from "@optimiq-voice/cdr-db";

/**
 * The call-volume queries, driven without a database.
 *
 * Same two layers as `queueStats.test.ts`: the SQL as a string from builders exported unexecuted,
 * and the derivations that are NOT in SQL — the unanswered subtraction and the bucket's ISO
 * rendering — driven against a fake.
 *
 * The assertion this file exists for is the grain: `date_trunc`'s first argument is a BOUND
 * PARAMETER and never an interpolated word. The DTO validates it as an enum today, so interpolating
 * it would be safe today, and that is precisely the argument that stops holding the first time
 * somebody widens the schema.
 */

const FROM = new Date("2026-08-05T00:00:00.000Z");
const TO = new Date("2026-08-06T00:00:00.000Z");
const BASE = { from: FROM, to: TO, bucket: "hour", limit: 100 } as const;

function realish(): CdrDatabaseTransaction {
	return new QueryBuilder() as unknown as CdrDatabaseTransaction;
}

function predicatesOf(sql: string): string {
	const where = sql.indexOf(" where ");
	return where < 0 ? "" : sql.slice(where);
}

/**
 * Captures the queries instead of running them, handing each of the two a different result set.
 *
 * Both queries end in `.limit()`, so the fake resolves there and pops the next fixture — which also
 * pins the ORDER `readCallVolume` runs them in, and that order is load-bearing: they share one
 * connection inside one tenant-scope transaction and must not be issued concurrently.
 */
function fakeTransaction(
	results: readonly (readonly Record<string, unknown>[])[],
): CdrDatabaseTransaction {
	const pending = [...results];
	const builder: Record<string, unknown> = {
		toSQL: () => ({ sql: "", params: [] }),
		select: () => builder,
		from: () => builder,
		where: () => builder,
		groupBy: () => builder,
		orderBy: () => builder,
		limit: () => Promise.resolve(pending.shift() ?? []),
	};
	return builder as unknown as CdrDatabaseTransaction;
}

describe("call volume query", () => {
	it("bounds the partition key unconditionally, so no request can scan the ledger", () => {
		const { sql } = callVolumeQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('"started_at" >=');
		expect(sql).to.contain('"started_at" <=');
	});

	it("never puts the organization in the predicate — RLS is the filter", () => {
		const { sql } = callVolumeQuery(realish(), BASE).toSQL();
		expect(predicatesOf(sql)).to.not.contain("organization_id");
	});

	/** Interpolating the grain would be safe until the DTO changes. A parameter is safe regardless. */
	it("binds the bucket grain rather than interpolating it into the statement", () => {
		const { sql, params } = callVolumeQuery(realish(), { ...BASE, bucket: "day" }).toSQL();
		expect(sql).to.not.contain("date_trunc('day'");
		expect(params).to.include("day");
	});

	/**
	 * `group by 1` and not a repeated `date_trunc(…)`. With a BOUND grain the repeat emits a second
	 * placeholder, and Postgres compares grouping expressions by parse tree — so the repeated version
	 * is rejected outright as an ungrouped column. This test is the one that caught that.
	 */
	it("groups and orders by the projection's bucket ordinal, chronologically", () => {
		const { sql } = callVolumeQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('date_trunc($1, "started_at")');
		expect(sql).to.contain("group by 1");
		expect(sql).to.contain("order by 1");
		expect(sql.split("date_trunc").length - 1).to.equal(1);
	});

	/**
	 * `answered_at is not null` and not `disposition = 'answered'`: a voicemail deposit satisfies the
	 * second, and "we answered 80% of calls" meaning "80% reached a mailbox" is the single most
	 * misleading number a phone system can print.
	 */
	it("counts an answer by the answer timestamp, not by the reporting disposition", () => {
		const { sql } = callVolumeQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('count(*) filter (where "answered_at" is not null)');
		expect(sql).to.not.contain('"disposition" =');
	});

	it("splits the bucket by direction in one pass rather than three queries", () => {
		const { sql } = callVolumeQuery(realish(), BASE).toSQL();
		for (const direction of ["inbound", "outbound", "internal"]) {
			expect(sql).to.contain(`filter (where "direction" = '${direction}')`);
		}
	});

	it("averages billed time over answered legs only, so the mean does not track the answer rate", () => {
		const { sql } = callVolumeQuery(realish(), BASE).toSQL();
		expect(sql).to.contain(
			'coalesce(round(avg("billsec_ms") filter (where "answered_at" is not null)), 0)',
		);
	});

	it("caps the number of buckets", () => {
		const { params } = callVolumeQuery(realish(), { ...BASE, limit: 9 }).toSQL();
		expect(params).to.include(9);
	});
});

describe("the destination series", () => {
	it("groups by bucket and destination, so a new destination type needs no code change", () => {
		const { sql } = callVolumeDestinationQuery(realish(), BASE).toSQL();
		expect(sql).to.contain('"destination_type"');
		expect(sql).to.contain('group by 1, "call_legs"."destination_type"');
		expect(sql.split("date_trunc").length - 1).to.equal(1);
	});

	it("bounds itself at the bucket cap times the domain, not at the bucket cap", () => {
		const { params } = callVolumeDestinationQuery(realish(), { ...BASE, limit: 10 }).toSQL();
		expect(params).to.include(130);
	});

	it("never puts the organization in the predicate either", () => {
		const { sql } = callVolumeDestinationQuery(realish(), BASE).toSQL();
		expect(predicatesOf(sql)).to.not.contain("organization_id");
	});
});

describe("reading the volume", () => {
	const BUCKET = new Date("2026-08-05T09:00:00.000Z");

	async function read(
		totals: readonly Record<string, unknown>[],
		destinations: readonly Record<string, unknown>[] = [],
		limit = 100,
	) {
		return await readCallVolume(fakeTransaction([totals, destinations]), { ...BASE, limit });
	}

	/** The subtraction is materialised here so the client and the server cannot disagree about it. */
	it("derives unanswered from the two counts rather than leaving it to the client", async () => {
		const result = await read([{ bucket: BUCKET, total: 10, answered: 6 }]);
		expect(result.rows[0]?.unanswered).to.equal(4);
	});

	it("renders the bucket as an ISO instant whichever shape the driver hands back", async () => {
		const result = await read([
			{ bucket: BUCKET, total: 1, answered: 1 },
			{ bucket: "2026-08-05T10:00:00.000Z", total: 1, answered: 0 },
		]);
		expect(result.rows.map((row) => row.bucket)).to.deep.equal([
			"2026-08-05T09:00:00.000Z",
			"2026-08-05T10:00:00.000Z",
		]);
	});

	it("returns the destination series beside the totals, bucketed the same way", async () => {
		const result = await read(
			[{ bucket: BUCKET, total: 3, answered: 3 }],
			[{ bucket: BUCKET, destinationType: "queue", total: 2, answered: 2 }],
		);
		expect(result.destinations).to.have.length(1);
		expect(result.destinations[0]?.bucket).to.equal("2026-08-05T09:00:00.000Z");
		expect(result.destinations[0]?.destinationType).to.equal("queue");
	});

	/** A silently short chart is a chart people draw conclusions from. */
	it("flags truncation when the bucket cap was reached", async () => {
		const rows = [
			{ bucket: BUCKET, total: 1, answered: 0 },
			{ bucket: BUCKET, total: 1, answered: 0 },
		];
		expect((await read(rows, [], 2)).truncated).to.equal(true);
		expect((await read(rows, [], 3)).truncated).to.equal(false);
	});
});

describe("the call-volume query dto", () => {
	it("defaults the grain to the hour rather than demanding one", () => {
		expect(callVolumeQuerySchema.parse({}).bucket).to.equal(DEFAULT_VOLUME_BUCKET);
	});

	it("refuses a grain outside the two that are useful — and it never reaches date_trunc", () => {
		expect(() => callVolumeQuerySchema.parse({ bucket: "century" })).to.throw();
	});

	/**
	 * The bound is DERIVED from the range cap, so an accepted request can never be truncated by it.
	 * This is the assertion that fails if somebody widens one constant without the other.
	 */
	it("caps buckets at exactly the widest window the range allows, in hours", () => {
		expect(MAX_VOLUME_BUCKETS).to.equal(MAX_RANGE_DAYS * 24);
		expect(callVolumeQuerySchema.parse({}).limit).to.equal(MAX_VOLUME_BUCKETS);
	});

	it("refuses an unknown parameter rather than silently ignoring a typo", () => {
		expect(() => callVolumeQuerySchema.parse({ direction: "inbound" })).to.throw();
	});
});
