import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
	createPostgresClient,
	type DatabaseClientOptions,
	type TenantDatabaseContext,
	type TenantTransactionalDatabase,
	withTenantTransaction,
} from "@optimiq-voice/db";
import { pbxRelations } from "./schema/relations";
import { pbxTenantContext } from "./tenant";
import type postgres from "postgres";

/**
 * The telephony database handle.
 *
 * Unlike the base package's generic client this one is bound to the PBX relations, so
 * `db.query.extension.findMany({ with: { users: true } })` is typed. The raw Drizzle handle is
 * reachable only as `adminDb` (untenanted — migrations, health probes) or inside
 * `withTenantScope`, which drops into `pbx_tenant_tls` and publishes the organization id.
 */
function createPbxDrizzle(client: postgres.Sql) {
	return drizzle({ client, relations: pbxRelations });
}

export type PbxDatabase = ReturnType<typeof createPbxDrizzle>;
export type PbxDatabaseTransaction = Parameters<Parameters<PbxDatabase["transaction"]>[0]>[0];

export interface PbxDatabaseClient {
	readonly context: TenantDatabaseContext;
	/**
	 * Untenanted handle. Deliberately named: it bypasses every row-level-security policy a runtime
	 * principal would be subject to, so it is only correct for migrations, health probes and
	 * preflight. Tenant-scoped repositories MUST use {@link PbxDatabaseClient.withTenantScope}.
	 */
	readonly adminDb: PbxDatabase;
	readonly withTenantScope: <T>(
		organizationId: string,
		work: (transaction: PbxDatabaseTransaction) => Promise<T>,
	) => Promise<T>;
	readonly checkConnection: () => Promise<void>;
	readonly close: () => Promise<void>;
}

export function createPbxDatabaseClient(options: DatabaseClientOptions): PbxDatabaseClient {
	const client = createPostgresClient(options);
	const adminDb = createPbxDrizzle(client);
	const transactional: TenantTransactionalDatabase<PbxDatabaseTransaction> = {
		transaction: async (work) => await adminDb.transaction(work),
	};
	return {
		context: pbxTenantContext,
		adminDb,
		withTenantScope: async <T>(
			organizationId: string,
			work: (transaction: PbxDatabaseTransaction) => Promise<T>,
		): Promise<T> =>
			await withTenantTransaction(pbxTenantContext, transactional, organizationId, work),
		checkConnection: async () => {
			await adminDb.execute(sql`select 1`);
		},
		close: async () => {
			await client.end({ timeout: 5 });
		},
	};
}
