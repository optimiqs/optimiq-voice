import * as Effect from "effect/Effect";
import { TenantDatabaseScopeError } from "./tenant-errors";
import { buildTenantSessionStatements } from "./tenant-scope";
import type { TenantDatabaseContext } from "./tenant-role";
import type { SQL } from "drizzle-orm";

/**
 * Structural shapes rather than concrete Drizzle types: the base package must stay usable by
 * every bounded-context database (postgres.js today, `drizzle-orm/effect-postgres` when the PBX
 * contexts land) without importing their adapters or pinning their relation generics.
 */
export interface TenantTransactionHandle {
	readonly execute: (query: SQL) => PromiseLike<unknown>;
}

export interface TenantTransactionalDatabase<Tx extends TenantTransactionHandle> {
	readonly transaction: <T>(work: (transaction: Tx) => Promise<T>) => Promise<T>;
}

export interface TenantEffectTransactionHandle {
	readonly execute: (query: SQL) => Effect.Effect<unknown, unknown, never>;
}

export interface TenantEffectTransactionalDatabase<Tx extends TenantEffectTransactionHandle> {
	readonly transaction: <A, E, R>(
		work: (transaction: Tx) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

function requireOrganizationId(context: TenantDatabaseContext, organizationId: string): string {
	const trimmed = organizationId.trim();
	if (trimmed.length === 0) {
		throw new TenantDatabaseScopeError({
			contextName: context.contextName,
			organizationId,
		});
	}
	return trimmed;
}

/**
 * Runs `work` inside a transaction that has dropped into the bounded context's tenant role and
 * published the organization id as a transaction-local setting.
 *
 * `set local role` and `set_config(..., true)` are both transaction-scoped, so the pooled
 * connection is restored on commit or rollback and can never leak one tenant's scope into the
 * next checkout.
 */
export async function withTenantTransaction<Tx extends TenantTransactionHandle, T>(
	context: TenantDatabaseContext,
	database: TenantTransactionalDatabase<Tx>,
	organizationId: string,
	work: (transaction: Tx) => Promise<T>,
): Promise<T> {
	const scopedOrganizationId = requireOrganizationId(context, organizationId);
	const statements = buildTenantSessionStatements(context);
	return await database.transaction(async (transaction) => {
		await transaction.execute(statements.setRole);
		await transaction.execute(statements.setOrganization(scopedOrganizationId));
		return await work(transaction);
	});
}

/** Effect-native counterpart of {@link withTenantTransaction}. */
export const withTenantEffectTransaction = Effect.fn("TenantDatabase.withTenantEffectTransaction")(
	function* <Tx extends TenantEffectTransactionHandle, A, E, R>(
		context: TenantDatabaseContext,
		database: TenantEffectTransactionalDatabase<Tx>,
		organizationId: string,
		work: (transaction: Tx) => Effect.Effect<A, E, R>,
	) {
		const trimmed = organizationId.trim();
		if (trimmed.length === 0) {
			return yield* Effect.fail(
				new TenantDatabaseScopeError({
					contextName: context.contextName,
					organizationId,
				}),
			);
		}
		const statements = buildTenantSessionStatements(context);
		return yield* database.transaction((transaction) =>
			Effect.gen(function* () {
				yield* transaction.execute(statements.setRole);
				yield* transaction.execute(statements.setOrganization(trimmed));
				return yield* work(transaction);
			}),
		);
	},
);
