import {
	type AdminDatabase,
	type AdminDatabaseTransaction,
	createTenantDatabaseClient,
	type DatabaseClientOptions,
	type TenantDatabaseClient,
} from "@optimiq-voice/db";
import { cdrTenantContext } from "./cdr-context";

/**
 * Connection factory for the CDR database.
 *
 * The CDR context has its own database and its own connection budget; it never shares a pool
 * with @optimiq-voice/db or pbx-db, and there are no cross-database joins. Reporting reads go
 * through `withTenantScope` (RLS-bound); the engine's writer path uses `adminDb` inside
 * `withCdrWriterScope`.
 */
export type CdrDatabaseClient = TenantDatabaseClient;

/**
 * The Drizzle handles a consumer receives, re-exported under CDR names.
 *
 * Not cosmetic: a consumer outside this workspace package (`apps/api`) resolves its own copy of
 * `drizzle-orm` — see `src/sql.ts` — so it cannot name these types by importing them from
 * `drizzle-orm` itself and have them accept the tables THIS package built. Re-exporting them
 * alongside the tables and the operators is what makes a repository function outside this package
 * declarable at all.
 */
export type CdrDatabase = AdminDatabase;
export type CdrDatabaseTransaction = AdminDatabaseTransaction;

export function createCdrDatabaseClient(options: DatabaseClientOptions): CdrDatabaseClient {
	return createTenantDatabaseClient(cdrTenantContext, options);
}

/** Reads the CDR connection string, preferring the context-specific variable. */
export function resolveCdrDatabaseUrl(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	return environment.CDR_DATABASE_URL ?? environment.CDR_DATABASE_MIGRATION_URL;
}
