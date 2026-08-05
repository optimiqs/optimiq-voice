import {
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

export function createCdrDatabaseClient(options: DatabaseClientOptions): CdrDatabaseClient {
	return createTenantDatabaseClient(cdrTenantContext, options);
}

/** Reads the CDR connection string, preferring the context-specific variable. */
export function resolveCdrDatabaseUrl(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	return environment.CDR_DATABASE_URL ?? environment.CDR_DATABASE_MIGRATION_URL;
}
