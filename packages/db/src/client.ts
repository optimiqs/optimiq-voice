import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	type TenantTransactionalDatabase,
	withTenantTransaction,
} from "./tenant/tenant-transaction";
import type { TenantDatabaseContext } from "./tenant/tenant-role";

/** Drizzle handle over a postgres.js pool. Never export one of these from a feature package. */
export type AdminDatabase = ReturnType<typeof drizzle>;
export type AdminDatabaseTransaction = Parameters<Parameters<AdminDatabase["transaction"]>[0]>[0];

/** Raised when a process is configured with a connection budget it cannot split safely. */
export class PostgresConnectionBudgetError extends RangeError {
	readonly _tag = "PostgresConnectionBudgetError" as const;

	constructor(message: string) {
		super(message);
		this.name = "PostgresConnectionBudgetError";
	}
}

/**
 * A process may open at most `maxConnections` sockets to PostgreSQL across every adapter it
 * uses. Splitting the budget explicitly keeps the promise-based pool and the Effect pool from
 * independently sizing themselves to the same number and doubling the real footprint.
 */
export interface PostgresConnectionBudget {
	readonly maxConnections: number;
	readonly promisePoolMaxConnections: number;
	readonly effectPoolMaxConnections: number;
}

export function allocatePostgresConnectionBudget(maxConnections: number): PostgresConnectionBudget {
	if (!Number.isInteger(maxConnections) || maxConnections < 2) {
		throw new PostgresConnectionBudgetError(
			"PostgreSQL process connection budget must be an integer of at least 2",
		);
	}
	const promisePoolMaxConnections = Math.floor(maxConnections / 2);
	return {
		maxConnections,
		promisePoolMaxConnections,
		effectPoolMaxConnections: maxConnections - promisePoolMaxConnections,
	};
}

export interface PostgresRuntimeGuardrails extends PostgresConnectionBudget {
	readonly applicationName: string;
	readonly idleTimeoutSeconds: number;
	readonly connectTimeoutSeconds: number;
	readonly statementTimeoutMs: number;
	readonly idleInTransactionSessionTimeoutMs: number;
}

export interface DatabaseClientOptions {
	readonly url: string;
	/** Shows up in `pg_stat_activity`; make it identify the process, not the package. */
	readonly applicationName: string;
	/** Process-wide socket budget shared by every adapter. @default 10 */
	readonly maxConnections?: number;
	/** @default 30 */
	readonly idleTimeoutSeconds?: number;
	/** @default 10 */
	readonly connectTimeoutSeconds?: number;
	/** @default 15000 */
	readonly statementTimeoutMs?: number;
	/** @default 30000 */
	readonly idleInTransactionSessionTimeoutMs?: number;
	/**
	 * Overrides the pool size taken from the budget. Use for single-connection tooling such as
	 * migrations, where the runtime split does not apply.
	 */
	readonly poolMaxConnectionsOverride?: number;
}

export function resolvePostgresRuntimeGuardrails(
	options: DatabaseClientOptions,
): PostgresRuntimeGuardrails {
	return {
		applicationName: options.applicationName,
		...allocatePostgresConnectionBudget(options.maxConnections ?? 10),
		idleTimeoutSeconds: options.idleTimeoutSeconds ?? 30,
		connectTimeoutSeconds: options.connectTimeoutSeconds ?? 10,
		statementTimeoutMs: options.statementTimeoutMs ?? 15_000,
		idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs ?? 30_000,
	};
}

function buildSessionSettings(
	guardrails: PostgresRuntimeGuardrails,
): Record<string, number | string> {
	return {
		application_name: guardrails.applicationName,
		statement_timeout: guardrails.statementTimeoutMs,
		idle_in_transaction_session_timeout: guardrails.idleInTransactionSessionTimeoutMs,
		TimeZone: "UTC",
	};
}

/** Raw postgres.js pool. Exported for migration tooling and preflight only. */
export function createPostgresClient(options: DatabaseClientOptions): postgres.Sql {
	const guardrails = resolvePostgresRuntimeGuardrails(options);
	return postgres(options.url, {
		max: options.poolMaxConnectionsOverride ?? guardrails.promisePoolMaxConnections,
		idle_timeout: guardrails.idleTimeoutSeconds,
		connect_timeout: guardrails.connectTimeoutSeconds,
		connection: buildSessionSettings(guardrails),
	});
}

export interface DatabaseClient {
	/**
	 * Untenanted Drizzle handle. Deliberately named: it bypasses every row-level-security policy
	 * a runtime principal would otherwise be subject to, so it is only correct for migrations,
	 * health probes and platform-global (non org-scoped) tables. Tenant-scoped repositories MUST
	 * go through {@link TenantDatabaseClient.withTenantScope}.
	 */
	readonly adminDb: AdminDatabase;
	readonly guardrails: PostgresRuntimeGuardrails;
	readonly checkConnection: () => Promise<void>;
	readonly close: () => Promise<void>;
}

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
	const guardrails = resolvePostgresRuntimeGuardrails(options);
	const client = createPostgresClient(options);
	const adminDb = drizzle({ client });
	return {
		adminDb,
		guardrails,
		checkConnection: async () => {
			await adminDb.execute(sql`select 1`);
		},
		close: async () => {
			await client.end({ timeout: 5 });
		},
	};
}

/**
 * The application boundary for organization-scoped work. The Drizzle handle is reachable only
 * as `adminDb` (untenanted, explicitly named) or inside `withTenantScope`, so a repository
 * cannot accidentally run a tenant query outside the tenant transaction.
 */
export interface TenantDatabaseClient extends DatabaseClient {
	readonly context: TenantDatabaseContext;
	readonly withTenantScope: <T>(
		organizationId: string,
		work: (transaction: AdminDatabaseTransaction) => Promise<T>,
	) => Promise<T>;
}

export function createTenantDatabaseClient(
	context: TenantDatabaseContext,
	options: DatabaseClientOptions,
): TenantDatabaseClient {
	const client = createDatabaseClient(options);
	const transactional: TenantTransactionalDatabase<AdminDatabaseTransaction> = {
		transaction: async (work) => await client.adminDb.transaction(work),
	};
	return {
		...client,
		context,
		withTenantScope: async <T>(
			organizationId: string,
			work: (transaction: AdminDatabaseTransaction) => Promise<T>,
		): Promise<T> => await withTenantTransaction(context, transactional, organizationId, work),
	};
}
