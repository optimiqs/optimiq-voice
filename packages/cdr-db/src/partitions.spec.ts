import { describe, expect, it } from "bun:test";
import {
	addMonths,
	assertPartitionedCdrTable,
	buildCreateDefaultPartitionSql,
	buildCreateMonthlyPartitionSql,
	CDR_PARTITION_KEYS,
	createMonthlyPartition,
	defaultPartitionName,
	monthlyPartitionName,
	monthlyPartitionRange,
	monthsInHorizon,
	monthStart,
	PARTITIONED_CDR_TABLES,
	PartitionedTableError,
	toDateLiteral,
	type PartitionExecutor,
} from "./partitions";
import type { SQL } from "drizzle-orm";

function recordingExecutor(): PartitionExecutor & { readonly queries: SQL[] } {
	const queries: SQL[] = [];
	return {
		queries,
		execute: (query: SQL) => {
			queries.push(query);
			return Promise.resolve([]);
		},
	};
}

/**
 * These specs are the drift check drizzle-kit cannot perform: the partition contract lives in
 * hand-written migration SQL, so its naming and bounds are pinned here instead of in a snapshot.
 */
describe("monthly partition arithmetic", () => {
	it("normalizes any instant to the UTC start of its month", () => {
		expect(monthStart(new Date("2026-08-31T23:59:59.999Z")).toISOString()).toBe(
			"2026-08-01T00:00:00.000Z",
		);
		// A local-midnight date in a positive-offset zone must not roll back a month.
		expect(monthStart(new Date("2026-01-01T00:00:00Z")).toISOString()).toBe(
			"2026-01-01T00:00:00.000Z",
		);
	});

	it("rolls over year boundaries in both directions", () => {
		expect(toDateLiteral(addMonths(new Date("2026-12-15T00:00:00Z"), 1))).toBe("2027-01-01");
		expect(toDateLiteral(addMonths(new Date("2026-01-15T00:00:00Z"), -1))).toBe("2025-12-01");
		expect(toDateLiteral(addMonths(new Date("2026-08-15T00:00:00Z"), -13))).toBe("2025-07-01");
	});

	it("names partitions `<table>_<YYYY>_<MM>` with a zero-padded month", () => {
		expect(monthlyPartitionName("call_legs", new Date("2026-08-05T12:00:00Z"))).toBe(
			"call_legs_2026_08",
		);
		expect(monthlyPartitionName("call_events", new Date("2026-11-30T23:00:00Z"))).toBe(
			"call_events_2026_11",
		);
		expect(defaultPartitionName("call_legs")).toBe("call_legs_default");
	});

	it("produces half-open month ranges", () => {
		const range = monthlyPartitionRange("call_legs", new Date("2026-08-20T00:00:00Z"));

		expect(range.name).toBe("call_legs_2026_08");
		expect(toDateLiteral(range.from)).toBe("2026-08-01");
		expect(toDateLiteral(range.to)).toBe("2026-09-01");
	});

	it("walks a horizon forward from the month containing the start", () => {
		const months = monthsInHorizon(new Date("2026-11-17T00:00:00Z"), 3).map(toDateLiteral);

		expect(months).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
	});

	it.each([0, -1, 1.5, Number.NaN])("rejects a horizon of %p months", (monthCount) => {
		expect(() => monthsInHorizon(new Date(), monthCount)).toThrow(RangeError);
	});
});

describe("partition DDL", () => {
	it("emits idempotent monthly partition DDL with quoted identifiers", () => {
		expect(buildCreateMonthlyPartitionSql("call_legs", new Date("2026-08-05T00:00:00Z"))).toBe(
			`create table if not exists "call_legs_2026_08" partition of "call_legs" for values from ('2026-08-01') to ('2026-09-01');`,
		);
	});

	it("can emit non-idempotent DDL for a fresh baseline", () => {
		expect(
			buildCreateMonthlyPartitionSql("call_events", new Date("2027-01-09T00:00:00Z"), {
				ifNotExists: false,
			}),
		).toBe(
			`create table "call_events_2027_01" partition of "call_events" for values from ('2027-01-01') to ('2027-02-01');`,
		);
	});

	it("emits the catch-all partition DDL", () => {
		expect(buildCreateDefaultPartitionSql("call_legs")).toBe(
			`create table if not exists "call_legs_default" partition of "call_legs" default;`,
		);
	});
});

describe("partitioned table allow-list", () => {
	it("covers exactly the two ledgers, with their partition keys", () => {
		expect([...PARTITIONED_CDR_TABLES]).toEqual(["call_legs", "call_events"]);
		expect(CDR_PARTITION_KEYS).toEqual({ call_legs: "started_at", call_events: "at" });
	});

	it.each(["recordings", "pg_class", "call_legs; drop table call_legs", ""])(
		"rejects %p",
		(tableName) => {
			expect(() => assertPartitionedCdrTable(tableName)).toThrow(PartitionedTableError);
		},
	);

	it("routes createMonthlyPartition through the allow-listed SQL function", async () => {
		const executor = recordingExecutor();

		const name = await createMonthlyPartition(executor, "call_legs", new Date("2026-09-14Z"));

		expect(name).toBe("call_legs_2026_09");
		expect(executor.queries).toHaveLength(1);
		const chunks = executor.queries[0]?.queryChunks ?? [];
		expect(JSON.stringify(chunks)).toContain("cdr_ensure_monthly_partition");
		// The month is a bound parameter, never string-interpolated.
		expect(chunks.some((chunk) => JSON.stringify(chunk).includes("2026-09-01"))).toBe(true);
	});
});
