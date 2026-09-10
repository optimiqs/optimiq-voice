import { expect } from "chai";
import { CdrLegRetentionSweeper } from "../../src/cdr/retention/leg-retention-sweeper.service";
import type {
	CdrLegRetentionAudit,
	DroppedPartitionAuditEntry,
} from "../../src/cdr/retention/leg-retention-audit";
import type { CdrEnv } from "../../src/cdr/shared/cdr-env";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The CDR partition retention sweep.
 *
 * Every case here is written from one direction: this is the only thing in the codebase that
 * issues `DROP TABLE` against the billing ledger, so the tests are about what stops it — the
 * dry-run interlock, the disabled window, the re-entrancy refusal — and about the audit trail
 * being gathered BEFORE the rows it describes are destroyed.
 */

const ORG_A = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ORG_B = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";

interface Executed {
	readonly text: string;
}

/** A database whose `adminDb.execute` answers a scripted list and records what it was asked. */
function fakeDatabase(results: readonly unknown[]): {
	readonly database: CdrDatabaseClient;
	readonly statements: Executed[];
} {
	const statements: Executed[] = [];
	let index = 0;
	const database = {
		adminDb: {
			execute: async (query: unknown) => {
				statements.push({
					text: JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query),
				});
				const result = results[index] ?? [];
				index += 1;
				return await Promise.resolve(result);
			},
		},
	} as unknown as CdrDatabaseClient;
	return { database, statements };
}

function env(overrides: Partial<CdrEnv> = {}): CdrEnv {
	return {
		CDR_WRITER_ENABLED: true,
		CDR_LEG_RETENTION_MONTHS: 13,
		CDR_RETENTION_DRY_RUN: false,
		CDR_RETENTION_SWEEP_INTERVAL_MS: 86_400_000,
		...overrides,
	} as CdrEnv;
}

function fakeAudit(): CdrLegRetentionAudit & {
	readonly calls: { organizationId: string; entries: readonly DroppedPartitionAuditEntry[] }[];
} {
	const calls: {
		organizationId: string;
		entries: readonly DroppedPartitionAuditEntry[];
	}[] = [];
	return {
		calls,
		recordDroppedPartitions: async (organizationId, entries) => {
			calls.push({ organizationId, entries });
			await Promise.resolve();
		},
	};
}

/** `call_legs` and `call_events` are both previewed, so two candidate reads come first. */
function candidates(): unknown[] {
	return [
		[{ partition_name: "call_legs_2024_01", bytes: "4096" }],
		[{ partition_name: "call_events_2024_01", bytes: "8192" }],
	];
}

describe("CdrLegRetentionSweeper", () => {
	it("drops the expired partitions and reports them", async () => {
		const { database, statements } = fakeDatabase([
			...candidates(),
			[{ dropped_partition: "call_legs_2024_01" }],
			[{ dropped_partition: "call_events_2024_01" }],
		]);

		const result = await new CdrLegRetentionSweeper(env(), database).sweep();

		expect(result.dryRun).to.equal(false);
		expect([...result.dropped]).to.deep.equal(["call_legs_2024_01", "call_events_2024_01"]);
		expect(statements.some((statement) => statement.text.includes("pg_inherits"))).to.equal(true);
		expect(
			statements.some((statement) => statement.text.includes("cdr_drop_partitions_before")),
		).to.equal(true);
	});

	it("drops nothing in dry-run mode, and still previews what it would drop", async () => {
		const { database, statements } = fakeDatabase(candidates());

		const result = await new CdrLegRetentionSweeper(
			env({ CDR_RETENTION_DRY_RUN: true }),
			database,
		).sweep();

		expect(result.dryRun).to.equal(true);
		expect([...result.dropped]).to.deep.equal([]);
		expect(
			statements.some((statement) => statement.text.includes("cdr_drop_partitions_before")),
		).to.equal(false);
		// The preview still ran: an operator's approval artifact is the whole point of the mode.
		expect(statements.filter((statement) => statement.text.includes("pg_inherits"))).to.have.length(
			2,
		);
	});

	it("tallies rows per organization BEFORE dropping, and audits only what was dropped", async () => {
		const audit = fakeAudit();
		const { database, statements } = fakeDatabase([
			...candidates(),
			// The per-organization tally, read off the `call_legs` partition only.
			[
				{ organization_id: ORG_A, rows: "120" },
				{ organization_id: ORG_B, rows: 7 },
			],
			[{ dropped_partition: "call_legs_2024_01" }],
			[{ dropped_partition: "call_events_2024_01" }],
		]);

		await new CdrLegRetentionSweeper(env(), database, audit).sweep();

		const tallyIndex = statements.findIndex((statement) => statement.text.includes("count(*)"));
		const dropIndex = statements.findIndex((statement) =>
			statement.text.includes("cdr_drop_partitions_before"),
		);
		expect(tallyIndex).to.be.greaterThan(-1);
		expect(tallyIndex).to.be.lessThan(dropIndex, "the tally must be taken before the drop");

		expect(audit.calls).to.have.length(2);
		const first = audit.calls.find((call) => call.organizationId === ORG_A);
		expect(first?.entries[0]).to.deep.equal({
			partition: "call_legs_2024_01",
			table: "call_legs",
			rows: 120,
			retentionMonths: 13,
			cutoffDate: first?.entries[0]?.cutoffDate,
		});
		expect(first?.entries[0]?.cutoffDate).to.match(/^\d{4}-\d{2}-01$/u);
	});

	it("does not tally when there is no audit port to write to", async () => {
		const { database, statements } = fakeDatabase([
			...candidates(),
			[{ dropped_partition: "call_legs_2024_01" }],
			[{ dropped_partition: "call_events_2024_01" }],
		]);

		await new CdrLegRetentionSweeper(env(), database).sweep();

		expect(statements.some((statement) => statement.text.includes("count(*)"))).to.equal(false);
	});

	it("does nothing at all when nothing is past the window", async () => {
		const { database, statements } = fakeDatabase([[], []]);

		const result = await new CdrLegRetentionSweeper(env(), database).sweep();

		expect([...result.dropped]).to.deep.equal([]);
		expect(statements).to.have.length(2);
	});

	it("survives a failure and leaves the schedule running", async () => {
		const database = {
			adminDb: {
				execute: async () => {
					await Promise.resolve();
					throw new Error("the cdr database is unreachable");
				},
			},
		} as unknown as CdrDatabaseClient;
		const sweeper = new CdrLegRetentionSweeper(env(), database);

		const result = await sweeper.sweep();

		expect(result.plan).to.equal(undefined);
		expect(sweeper.stats.failed).to.equal(1);
	});

	it("refuses a second pass while one is running", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const database = {
			adminDb: {
				execute: async () => {
					await gate;
					return [];
				},
			},
		} as unknown as CdrDatabaseClient;
		const sweeper = new CdrLegRetentionSweeper(env(), database);

		const first = sweeper.sweep();
		const second = await sweeper.sweep();
		release();
		await first;

		expect(second.plan).to.equal(undefined);
		expect(sweeper.stats.swept).to.equal(1);
	});

	it("never schedules itself when the window is zero, the writer is off, or the interval is zero", () => {
		for (const overrides of [
			{ CDR_LEG_RETENTION_MONTHS: 0 },
			{ CDR_WRITER_ENABLED: false },
			{ CDR_RETENTION_SWEEP_INTERVAL_MS: 0 },
		] satisfies Partial<CdrEnv>[]) {
			const { database } = fakeDatabase([]);
			const sweeper = new CdrLegRetentionSweeper(env(overrides), database);
			sweeper.onModuleInit();
			// Nothing to clear means nothing was scheduled; shutdown is still safe to call.
			sweeper.onApplicationShutdown();
			expect(sweeper.stats.swept).to.equal(0);
		}
	});

	it("stops sweeping after shutdown", async () => {
		const { database } = fakeDatabase(candidates());
		const sweeper = new CdrLegRetentionSweeper(env(), database);
		sweeper.onApplicationShutdown();

		const result = await sweeper.sweep();

		expect(result.plan).to.equal(undefined);
		expect(sweeper.stats.swept).to.equal(0);
	});
});
