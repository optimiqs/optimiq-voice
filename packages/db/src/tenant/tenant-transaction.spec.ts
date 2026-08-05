import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { TenantDatabaseScopeError } from "./tenant-errors";
import { createTenantDatabaseContext } from "./tenant-role";
import {
	type TenantEffectTransactionalDatabase,
	type TenantTransactionalDatabase,
	withTenantEffectTransaction,
	withTenantTransaction,
} from "./tenant-transaction";
import type { SQL } from "drizzle-orm";

const pbx = createTenantDatabaseContext("pbx");
const dialect = new PgDialect();
const ORGANIZATION_ID = "018f2b2a-0000-7000-8000-000000000001";

function renderStatements(statements: readonly SQL[]): { sql: string; params: unknown[] }[] {
	return statements.map((statement) => {
		const query = dialect.sqlToQuery(statement);
		return { sql: query.sql, params: query.params };
	});
}

type FakeTransaction = { execute: (query: SQL) => Promise<unknown> };

function createFakePromiseDatabase(): {
	database: TenantTransactionalDatabase<FakeTransaction>;
	executed: SQL[];
	transactionCount: () => number;
} {
	const executed: SQL[] = [];
	let transactions = 0;
	const transaction: FakeTransaction = {
		execute: async (query) => {
			executed.push(query);
			return await Promise.resolve(undefined);
		},
	};
	return {
		executed,
		transactionCount: () => transactions,
		database: {
			transaction: async (work) => {
				transactions += 1;
				return await work(transaction);
			},
		},
	};
}

describe("withTenantTransaction", () => {
	it("sets the tenant role and the organization setting before the work runs", async () => {
		const fake = createFakePromiseDatabase();

		const result = await withTenantTransaction(
			pbx,
			fake.database,
			ORGANIZATION_ID,
			async () => await Promise.resolve("done"),
		);

		expect(result).toBe("done");
		expect(fake.transactionCount()).toBe(1);

		const rendered = renderStatements(fake.executed);
		expect(rendered).toHaveLength(2);
		expect(rendered[0]?.sql).toBe('set local role "pbx_tenant_tls"');
		expect(rendered[1]?.sql).toBe("select set_config($1, $2, true)");
		expect(rendered[1]?.params).toEqual(["pbx_tenant_tls.organization_id", ORGANIZATION_ID]);
	});

	it("runs the setup statements before the caller's work", async () => {
		const fake = createFakePromiseDatabase();
		let executedCountAtWorkTime = -1;

		await withTenantTransaction(pbx, fake.database, ORGANIZATION_ID, async () => {
			executedCountAtWorkTime = fake.executed.length;
			return await Promise.resolve(null);
		});

		expect(executedCountAtWorkTime).toBe(2);
	});

	it("trims the organization id before publishing it", async () => {
		const fake = createFakePromiseDatabase();

		await withTenantTransaction(
			pbx,
			fake.database,
			`  ${ORGANIZATION_ID}  `,
			async () => await Promise.resolve(null),
		);

		expect(renderStatements(fake.executed)[1]?.params?.[1]).toBe(ORGANIZATION_ID);
	});

	it.each([[""], ["   "], ["\t\n"]])(
		"refuses to open a transaction for a blank organization id (%p)",
		async (organizationId) => {
			const fake = createFakePromiseDatabase();

			await expect(
				withTenantTransaction(
					pbx,
					fake.database,
					organizationId,
					async () => await Promise.resolve(null),
				),
			).rejects.toBeInstanceOf(TenantDatabaseScopeError);
			expect(fake.transactionCount()).toBe(0);
			expect(fake.executed).toHaveLength(0);
		},
	);
});

type FakeEffectTransaction = {
	execute: (query: SQL) => Effect.Effect<unknown, never, never>;
};

function createFakeEffectDatabase(): {
	database: TenantEffectTransactionalDatabase<FakeEffectTransaction>;
	executed: SQL[];
	transactionCount: () => number;
} {
	const executed: SQL[] = [];
	let transactions = 0;
	const transaction: FakeEffectTransaction = {
		execute: (query) =>
			Effect.sync(() => {
				executed.push(query);
			}),
	};
	return {
		executed,
		transactionCount: () => transactions,
		database: {
			transaction: (work) =>
				Effect.suspend(() => {
					transactions += 1;
					return work(transaction);
				}),
		},
	};
}

describe("withTenantEffectTransaction", () => {
	it("applies the same role and setting statements as the promise wrapper", async () => {
		const fake = createFakeEffectDatabase();

		const result = await Effect.runPromise(
			withTenantEffectTransaction(pbx, fake.database, ORGANIZATION_ID, () =>
				Effect.succeed("done"),
			),
		);

		expect(result).toBe("done");
		const rendered = renderStatements(fake.executed);
		expect(rendered[0]?.sql).toBe('set local role "pbx_tenant_tls"');
		expect(rendered[1]?.params).toEqual(["pbx_tenant_tls.organization_id", ORGANIZATION_ID]);
	});

	it("fails with a typed scope error instead of opening a transaction", async () => {
		const fake = createFakeEffectDatabase();

		const exit = await Effect.runPromiseExit(
			withTenantEffectTransaction(pbx, fake.database, "  ", () => Effect.succeed("done")),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(fake.transactionCount()).toBe(0);
		expect(fake.executed).toHaveLength(0);
	});
});
