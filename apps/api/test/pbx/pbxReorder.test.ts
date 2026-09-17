import { expect } from "chai";
import * as Effect from "effect/Effect";
import { ivrMenuOption } from "@optimiq-voice/pbx-db";
import { IVR_MENU_OPTION_RESOURCE } from "../../src/pbx/ivr-menus/ivr-menus.resource";
import { makePbxRepository } from "../../src/pbx/shared/pbx.repository";
import type { PbxChildResource } from "../../src/pbx/shared/pbx-resource";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `PUT …/reorder` against a collection that carries a UNIQUE `(parent, ordinal)` index.
 *
 * Seven of the eight reorderable collections declare `uniqueIndex(... parent, ordinal)` in
 * `packages/pbx-db` — only IVR options use a plain index — and `uniqueIndex()` emits
 * `CREATE UNIQUE INDEX`, which cannot be deferred: the constraint is enforced at the end of every
 * STATEMENT, not at COMMIT. Writing the final ordinals one row per statement therefore raised
 * `23505` on the simplest real reorder (swap the first two rows, and the second row is told to take
 * an ordinal the first still holds), which `toPbxFailure` turned into a 409 about a value the caller
 * never sent. Reordering was impossible on those seven collections and nothing covered it.
 *
 * There is no database in this suite — the SQL is `verify-pbx.ts`'s job — so the index is modelled
 * instead: the fake transaction applies each update in order and refuses, exactly as Postgres would,
 * any statement that leaves two rows in the same collection sharing an ordinal. That is enough to
 * fail the one-statement-per-row version and to pass the two-pass one, which is the whole claim.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const MENU_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

const OPTION_IDS = [
	"019fd3c2-aaaa-76be-a6b3-b0f1914e39b1",
	"019fd3c2-aaaa-76be-a6b3-b0f1914e39b2",
	"019fd3c2-aaaa-76be-a6b3-b0f1914e39b3",
	"019fd3c2-aaaa-76be-a6b3-b0f1914e39b4",
];

/**
 * The same descriptor, renamed onto a table that is NOT a routing input.
 *
 * `settle` recompiles for any table `affectsRouting()` accepts, and a recompile is a live database.
 * The subject here is the ordinal write sequence, which is identical for every reorderable
 * collection, so the recompile is stepped around rather than stubbed.
 */
const RESOURCE: PbxChildResource = { ...IVR_MENU_OPTION_RESOURCE, tableName: "queue_agent" };

interface FakeRow {
	readonly id: string;
	ordinal: number;
}

/**
 * A transaction over one in-memory collection, with the unique index enforced per statement.
 *
 * `reorderChildren` issues its updates in `ids` order, one statement each, so the nth update of a
 * pass targets `ids[n]` — which is what lets the fake resolve the row without parsing Drizzle's
 * `where`. Everything else it is asked for (the parent existence probe, the two collection reads)
 * has one possible answer here.
 */
function fakeDatabase(order: readonly string[]): {
	readonly database: PbxDatabaseClient;
	readonly rows: readonly FakeRow[];
	readonly ordinalWrites: readonly number[];
} {
	const rows: FakeRow[] = OPTION_IDS.map((id, index) => ({ id, ordinal: index }));
	const ordinalWrites: number[] = [];
	let updateIndex = 0;

	const assertUnique = () => {
		const seen = new Set<number>();
		for (const row of rows) {
			if (seen.has(row.ordinal)) {
				throw Object.assign(new Error("duplicate key value violates unique constraint"), {
					code: "23505",
					constraint_name: "ivr_menu_option_menu_ordinal_key",
				});
			}
			seen.add(row.ordinal);
		}
	};

	const selectResult = () => {
		const copy = [...rows].sort((left, right) => left.ordinal - right.ordinal);
		const chain = {
			from: () => chain,
			where: () => chain,
			orderBy: () => chain,
			limit: () => Promise.resolve(copy.map((row) => ({ ...row }))),
			then: (resolve: (value: unknown) => unknown) => resolve(copy.map((row) => ({ ...row }))),
		};
		return chain;
	};

	const transaction = {
		execute: async () => await Promise.resolve([{ "?column?": 1 }]),
		select: () => selectResult(),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					// The pass is `ids.length` statements long, so the position inside the pass names the row.
					const id = order[updateIndex % order.length] ?? "";
					updateIndex += 1;
					const row = rows.find((candidate) => candidate.id === id);
					const ordinal = values[ivrMenuOption.ordinal.name] as number;
					ordinalWrites.push(ordinal);
					if (row !== undefined) {
						row.ordinal = ordinal;
					}
					assertUnique();
					await Promise.resolve();
				},
			}),
		}),
	};

	const database = {
		withTenantScope: async <T>(
			_organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => await work(transaction as never),
	} as unknown as PbxDatabaseClient;

	return { database, rows, ordinalWrites };
}

describe("child collection reorder", () => {
	it("rewrites a real permutation without ever colliding on (parent, ordinal)", async () => {
		// A swap of the first two, which is the reorder a person actually performs and the one that
		// collided immediately under the old single-pass write.
		const order = [OPTION_IDS[1], OPTION_IDS[0], OPTION_IDS[2], OPTION_IDS[3]] as string[];
		const { database, rows, ordinalWrites } = fakeDatabase(order);
		const repository = makePbxRepository({ database });

		const result = await Effect.runPromise(
			repository.reorderChildren(ORGANIZATION_ID, RESOURCE, MENU_ID, order),
		);

		// The stored order is exactly the sent order, and it is dense from zero.
		expect([...rows].sort((a, b) => a.ordinal - b.ordinal).map((row) => row.id)).to.deep.equal(
			order,
		);
		expect(result.row.map((row) => String(row.id))).to.deep.equal(order);

		// Two passes: every row parked outside the final range first, then the final ordinals.
		expect(ordinalWrites).to.deep.equal([-1, -2, -3, -4, 0, 1, 2, 3]);
	});

	it("reverses a collection, the permutation that collides on every row", async () => {
		const order = [...OPTION_IDS].reverse();
		const { database, rows } = fakeDatabase(order);
		const repository = makePbxRepository({ database });

		await Effect.runPromise(repository.reorderChildren(ORGANIZATION_ID, RESOURCE, MENU_ID, order));

		expect([...rows].sort((a, b) => a.ordinal - b.ordinal).map((row) => row.id)).to.deep.equal(
			order,
		);
	});
});
