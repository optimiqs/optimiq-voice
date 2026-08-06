import { createPbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { PbxEnv } from "./pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The telephony database handle for `apps/api`.
 *
 * `createPbxDatabaseClient` is the package's only constructor and `withTenantScope` is the only
 * way out of it that a repository may use: it opens a transaction, drops into `pbx_tenant_tls`
 * (created `inherit: false`, so every privilege of the connecting principal is dropped) and
 * publishes the organization id as a transaction-local setting the RLS policies read. The raw
 * handle is reachable only as `adminDb`, which is deliberately named and is for migrations and
 * health probes.
 *
 * This is the PBX area's counterpart to `db.forOrganization(...)` in `src/core/db.ts` — the same
 * pattern against the other bounded context, using the package's own wrapper rather than a second
 * hand-rolled one.
 */
export function createPbxDatabase(env: PbxEnv): PbxDatabaseClient {
	return createPbxDatabaseClient({
		url: env.PBX_DATABASE_URL,
		applicationName: "optimiq-api-pbx",
		maxConnections: env.PBX_DATABASE_MAX_CONNECTIONS,
	});
}
