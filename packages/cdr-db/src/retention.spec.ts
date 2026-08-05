import { describe, expect, it } from "bun:test";
import { toDateLiteral, type PartitionExecutor } from "./partitions";
import {
	DEFAULT_CDR_RETENTION_MONTHS,
	dropPartitionsBefore,
	expiredRecordingsSelectQuery,
	expiredRecordingsUpdateQuery,
	planCdrRetention,
	purgedRecordingTombstoneDeleteQuery,
	retentionCutoff,
	RetentionWindowError,
	runCdrRetention,
} from "./retention";
import type { SQL } from "drizzle-orm";

function stubExecutor(results: readonly unknown[]): PartitionExecutor & { readonly calls: SQL[] } {
	const calls: SQL[] = [];
	let index = 0;
	return {
		calls,
		execute: (query: SQL) => {
			calls.push(query);
			const result = results[index] ?? [];
			index += 1;
			return Promise.resolve(result);
		},
	};
}

const NOW = new Date("2026-08-05T10:00:00Z");

describe("retention window", () => {
	it("counts the current partial month as month one", () => {
		expect(toDateLiteral(retentionCutoff(NOW, 1))).toBe("2026-08-01");
		expect(toDateLiteral(retentionCutoff(NOW, 2))).toBe("2026-07-01");
		expect(toDateLiteral(retentionCutoff(NOW, 13))).toBe("2025-08-01");
	});

	it.each([0, -1, 2.5, Number.NaN])("rejects a retention window of %p months", (months) => {
		expect(() => retentionCutoff(NOW, months)).toThrow(RetentionWindowError);
	});

	it("defaults to a full year plus the current partial month", () => {
		expect(DEFAULT_CDR_RETENTION_MONTHS).toBe(13);
		expect(planCdrRetention({ now: NOW }).cutoffDate).toBe("2025-08-01");
	});

	it("describes the sweep without touching the database", () => {
		const plan = planCdrRetention({ now: NOW, retentionMonths: 6, tombstoneMonths: 3 });

		expect(plan.cutoffDate).toBe("2026-03-01");
		expect([...plan.tables]).toEqual(["call_legs", "call_events"]);
		expect(toDateLiteral(plan.tombstoneCutoff)).toBe("2026-05-01");
	});
});

describe("retention statements", () => {
	it("only ever expires rows that still hold an object", () => {
		const text = JSON.stringify(expiredRecordingsUpdateQuery(NOW).queryChunks);

		expect(text).toContain("deleted_at");
		expect(text).toContain("retention_until");
		expect(text).toContain("is null");
	});

	it("orders the purge worklist oldest first and bounds it", () => {
		const query = expiredRecordingsSelectQuery(NOW, 25);
		const text = JSON.stringify(query.queryChunks);

		expect(text).toContain("order by");
		expect(text).toContain("limit");
		expect(JSON.stringify(query.queryChunks)).toContain("object_key");
	});

	it("removes tombstones only after the object is long gone", () => {
		const text = JSON.stringify(purgedRecordingTombstoneDeleteQuery(NOW).queryChunks);

		expect(text).toContain("delete from");
		expect(text).toContain("deleted_at");
	});

	it("calls the allow-listed drop function per table", async () => {
		const executor = stubExecutor([[{ dropped_partition: "call_legs_2024_01" }]]);

		const dropped = await dropPartitionsBefore(executor, "call_legs", new Date("2025-01-15Z"));

		expect(dropped).toEqual(["call_legs_2024_01"]);
		expect(JSON.stringify(executor.calls[0]?.queryChunks)).toContain("cdr_drop_partitions_before");
	});

	it("sweeps both ledgers then both recording lifecycles, in that order", async () => {
		const executor = stubExecutor([
			[{ dropped_partition: "call_legs_2025_07" }],
			[{ dropped_partition: "call_events_2025_07" }],
			[{ id: "a" }, { id: "b" }],
			[{ id: "c" }],
		]);

		const outcome = await runCdrRetention(executor, { now: NOW, retentionMonths: 13 });

		expect(outcome.droppedPartitions).toEqual(["call_legs_2025_07", "call_events_2025_07"]);
		expect(outcome.expiredRecordings).toBe(2);
		expect(outcome.removedTombstones).toBe(1);
		expect(outcome.plan.cutoffDate).toBe("2025-08-01");
		expect(executor.calls).toHaveLength(4);
	});
});
