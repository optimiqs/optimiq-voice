import { createCdrDatabaseClient } from "@optimiq-voice/cdr-db";
import type { CdrEnv } from "./cdr-env";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The reporting database handle for `apps/api`.
 *
 * Two principals come out of this one client, and which one a code path uses is the whole security
 * story of the area:
 *
 * - `withTenantScope(orgId, …)` — opens a transaction, `SET ROLE`s into `cdr_tenant_tls` (created
 *   `NOINHERIT`, so every privilege of the connecting principal is dropped) and publishes the
 *   organization id the RLS policies read. Every REQUEST-driven read goes through it. The tenant
 *   role holds SELECT + INSERT on the ledgers and nothing else, so a reporting query cannot rewrite
 *   billing history even if it wanted to.
 * - `adminDb` inside `withCdrWriterScope(orgId, …)` — the schema owner, used by the durable writers.
 *   The owner is not subject to the policies, which is exactly why `withCdrWriterScope` forces the
 *   organization id into the statement itself; the predicate is the boundary, the setting is only a
 *   marker for `pg_stat_activity`.
 *
 * This is the CDR area's counterpart to `createPbxDatabase` and to `db.forOrganization(...)` in
 * `src/core/db.ts` — the same pattern against a third bounded context, using the package's own
 * wrapper rather than a hand-rolled one.
 */
export function createCdrDatabase(env: CdrEnv): CdrDatabaseClient {
	return createCdrDatabaseClient({
		url: env.CDR_DATABASE_URL,
		applicationName: "optimiq-api-cdr",
		maxConnections: env.CDR_DATABASE_MAX_CONNECTIONS,
	});
}
