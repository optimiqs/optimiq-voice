import { expect } from "chai";
import { AuditLogRetentionSweeper } from "../../src/pbx/audit-log/audit-log-retention-sweeper.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The change ledger's own retention.
 *
 * `audit_log` was the one table on this platform with no window at all: it grew monotonically with
 * a tenant's activity for the life of the deployment, holding who did what and from which address
 * indefinitely — the same minimisation problem the recording and voicemail windows exist to solve,
 * applied to the table that records the solving.
 *
 * The property these cases exist to pin is the one that must never drift: the window is read from
 * the PROCESS ENVIRONMENT and there is no organization anywhere in the delete. A tenant able to
 * set this could shorten the evidence of its own administrators' actions, which is not a retention
 * policy. The rest is ordinary sweeper behaviour — the cutoff, the batch ceiling, and `0` meaning
 * keep for ever.
 */

function env(overrides: Partial<PbxEnv> = {}): PbxEnv {
	return {
		AUDIT_LOG_RETENTION_DAYS: 400,
		AUDIT_LOG_SWEEP_INTERVAL_MS: 86_400_000,
		AUDIT_LOG_SWEEP_BATCH: 1_000,
		...overrides,
	} as PbxEnv;
}

interface Executed {
	readonly text: string;
}

/**
 * A database that records the SQL it was handed and answers a scripted list of deleted ids.
 *
 * `withTenantScope` is deliberately absent from the fake: if the sweeper ever reached for it, these
 * tests would fail with a `TypeError` rather than quietly passing — which is the point, since the
 * whole design is that this delete is untenanted and runs as the admin principal.
 */
function fakeDatabase(results: readonly unknown[]): {
	readonly database: PbxDatabaseClient;
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
	} as unknown as PbxDatabaseClient;
	return { database, statements };
}

describe("audit log retention sweeper", () => {
	it("deletes the oldest rows past the window, bounded by the batch", async () => {
		const { database, statements } = fakeDatabase([[{ id: "a" }, { id: "b" }]]);
		const sweeper = new AuditLogRetentionSweeper(env(), database);

		const result = await sweeper.sweep();

		expect(result.purged).to.equal(2);
		expect(statements).to.have.length(1);
		expect(statements[0]?.text).to.contain("delete from audit_log");
		expect(statements[0]?.text).to.contain("occurred_at");
		// Oldest first and capped, so a first pass on an established deployment drains over days
		// rather than locking a table that takes a write on every mutation the API serves.
		expect(statements[0]?.text).to.contain("order by occurred_at");
		expect(statements[0]?.text).to.contain("limit");
	});

	it("names no organization at all — the window is the PLATFORM's", async () => {
		const { database, statements } = fakeDatabase([[]]);
		const sweeper = new AuditLogRetentionSweeper(env(), database);

		await sweeper.sweep();

		// A tenant that could scope or shorten this could shorten the record of its own actions.
		// The absence of `organization_id` in the statement is what makes that unexpressible.
		expect(statements[0]?.text).to.not.contain("organization_id");
	});

	it("keeps the ledger for ever at 0, and does not even ask the database", async () => {
		const { database, statements } = fakeDatabase([[{ id: "a" }]]);
		const sweeper = new AuditLogRetentionSweeper(env({ AUDIT_LOG_RETENTION_DAYS: 0 }), database);
		sweeper.onModuleInit();

		const result = await sweeper.sweep();

		expect(result.purged).to.equal(0);
		expect(statements).to.have.length(0);
		expect(sweeper.stats.swept).to.equal(0);
	});

	it("survives a failing pass without killing the interval", async () => {
		const database = {
			adminDb: {
				execute: async () => {
					await Promise.resolve();
					throw new Error("the database is unreachable");
				},
			},
		} as unknown as PbxDatabaseClient;
		const sweeper = new AuditLogRetentionSweeper(env(), database);

		// Nothing was deleted that should not have been, so the next tick sees the same worklist.
		expect((await sweeper.sweep()).purged).to.equal(0);
		expect(sweeper.stats.failed).to.equal(1);
	});

	it("stops sweeping after shutdown", async () => {
		const { database } = fakeDatabase([[{ id: "a" }]]);
		const sweeper = new AuditLogRetentionSweeper(env(), database);
		sweeper.onApplicationShutdown();

		expect((await sweeper.sweep()).purged).to.equal(0);
		expect(sweeper.stats.swept).to.equal(0);
	});
});
