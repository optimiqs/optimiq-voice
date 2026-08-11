import { expect } from "chai";
import { CdrRecordingRetentionSweeper } from "../../src/cdr/recordings/recording-retention-sweeper.service";
import type { CdrEnv } from "../../src/cdr/shared/cdr-env";
import type { ObjectStore } from "../../src/storage";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The recording retention purge.
 *
 * These are all written from the same direction: the sweep is biased towards NOT deleting. A row
 * that is tombstoned while its object is still in the bucket is deleted for the customer and
 * retained for a subpoena, so every case below is about the order of the two operations and about
 * what happens when the store refuses.
 */

const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

interface ExecutedStatement {
	readonly text: string;
}

/** A database whose `adminDb.execute` answers a scripted list and records what it was asked. */
function fakeDatabase(results: readonly unknown[]): {
	readonly database: CdrDatabaseClient;
	readonly statements: ExecutedStatement[];
} {
	const statements: ExecutedStatement[] = [];
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

function fakeStore(refuse: readonly string[] = []): ObjectStore & { readonly deleted: string[] } {
	const deleted: string[] = [];
	return {
		driver: "local",
		deleted,
		delete: async (objectKey: string) => {
			if (refuse.includes(objectKey)) {
				throw new Error("the bucket is unreachable");
			}
			deleted.push(objectKey);
			await Promise.resolve();
		},
	} as unknown as ObjectStore & { readonly deleted: string[] };
}

function env(overrides: Partial<CdrEnv> = {}): CdrEnv {
	return {
		CDR_WRITER_ENABLED: true,
		CDR_RECORDING_RETENTION_DAYS: 30,
		CDR_RECORDING_SWEEP_INTERVAL_MS: 3_600_000,
		CDR_RECORDING_SWEEP_BATCH: 200,
		...overrides,
	} as CdrEnv;
}

function due(id: string, key: string): Record<string, string> {
	return { id, organization_id: ORG, object_key: key };
}

describe("recording retention sweeper", () => {
	it("removes the object before it tombstones the row", async () => {
		const { database, statements } = fakeDatabase([
			[due("r1", `${ORG}/call-1/r1.wav`)],
			[{ id: "r1" }],
			[],
		]);
		const store = fakeStore();
		const sweeper = new CdrRecordingRetentionSweeper(env(), database, store);

		const result = await sweeper.sweep();

		expect(store.deleted).to.deep.equal([`${ORG}/call-1/r1.wav`]);
		expect(result.purged).to.equal(1);
		expect(result.tombstoned).to.equal(1);
		// Worklist, then the tombstone for what went, then the tombstone expiry. Three statements,
		// and the SELECT is first — a sweep that marked rows before deleting would show it here.
		expect(statements).to.have.length(3);
		expect(statements[0]?.text).to.contain("retention_until");
		expect(statements[1]?.text).to.contain("deleted_at");
	});

	it("leaves a row playable and still due when its object could not be removed", async () => {
		const { database, statements } = fakeDatabase([
			[due("r1", "keeps/failing.wav"), due("r2", "goes/away.wav")],
			[{ id: "r2" }],
			[],
		]);
		const store = fakeStore(["keeps/failing.wav"]);
		const sweeper = new CdrRecordingRetentionSweeper(env(), database, store);

		const result = await sweeper.sweep();

		expect(store.deleted).to.deep.equal(["goes/away.wav"]);
		expect(result.purged).to.equal(1);
		expect(sweeper.stats.unpurgeable).to.equal(1);
		// The tombstone statement names only the id whose bytes actually went.
		expect(statements[1]?.text).to.contain("r2");
		expect(statements[1]?.text).to.not.contain("r1");
	});

	it("still expires tombstones when nothing was due", async () => {
		const { database, statements } = fakeDatabase([[], [], [{ id: "old" }]]);
		const sweeper = new CdrRecordingRetentionSweeper(env(), database, fakeStore());

		const result = await sweeper.sweep();

		expect(result).to.deep.equal({ purged: 0, tombstoned: 0 });
		expect(statements[2]?.text).to.contain("delete from");
	});

	it("survives a failing pass without killing the schedule", async () => {
		const database = {
			adminDb: {
				execute: async () => {
					await Promise.resolve();
					throw new Error("the pool is exhausted");
				},
			},
		} as unknown as CdrDatabaseClient;
		const sweeper = new CdrRecordingRetentionSweeper(env(), database, fakeStore());

		const result = await sweeper.sweep();

		expect(result).to.deep.equal({ purged: 0, tombstoned: 0 });
		expect(sweeper.stats.failed).to.equal(1);
		// Still runnable: the interval is what would otherwise have died with the exception.
		expect((await sweeper.sweep()).purged).to.equal(0);
		expect(sweeper.stats.failed).to.equal(2);
	});

	it("does nothing once the process is shutting down", async () => {
		const { database, statements } = fakeDatabase([[due("r1", "a.wav")]]);
		const sweeper = new CdrRecordingRetentionSweeper(env(), database, fakeStore());

		sweeper.onApplicationShutdown();
		await sweeper.sweep();

		expect(statements).to.have.length(0);
	});

	it("arms no timer when the sweep is disabled or the writers are off", () => {
		const armed = (overrides: Partial<CdrEnv>): boolean => {
			const { database } = fakeDatabase([]);
			const sweeper = new CdrRecordingRetentionSweeper(env(overrides), database, fakeStore());
			sweeper.onModuleInit();
			const running = (sweeper as unknown as { timer: unknown }).timer !== undefined;
			sweeper.onApplicationShutdown();
			return running;
		};

		expect(armed({ CDR_RECORDING_SWEEP_INTERVAL_MS: 0 })).to.equal(false);
		expect(armed({ CDR_WRITER_ENABLED: false })).to.equal(false);
		expect(armed({})).to.equal(true);
	});
});
