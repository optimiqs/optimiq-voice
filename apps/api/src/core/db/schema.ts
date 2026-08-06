import { pgRole } from "drizzle-orm/pg-core";
import { API_TENANT_ROLE_NAME } from "./tenant";

/**
 * This database's drizzle surface — and, since the legacy removal, its tenant role and nothing
 * else.
 *
 * Every table that used to live here belonged to the deleted platform: `applications` and
 * `secrets` (the workspace-scoped resources of the gRPC API), `products` (the STT/TTS/LLM vendor
 * catalogue), and the three per-application service rows `tts_services`, `stt_services` and
 * `intelligence_services`. Nothing in the surviving code read any of them — the PBX, CDR, live,
 * provisioning and media areas own their own databases (`packages/pbx-db`, `packages/cdr-db`) and
 * better-auth owns its tables in `packages/db` — so they were dropped rather than carried, by the
 * migration beside this file. Their `access_key_id` indexes went with them; there is no access key
 * anywhere in this platform any more.
 *
 * The role survives the tables on purpose. `api_tenant_tls` is NOINHERIT and is the identity every
 * tenant-scoped statement against this database would run as; it costs nothing while unused, it is
 * what `test/core/tenantContext.test.ts` pins against `@optimiq-voice/db`'s string helpers, and the
 * first table this context grows again must be created under it rather than under a role invented
 * at that moment. With no tables to protect there is nothing to preflight, which is why
 * `main.ts` no longer runs `assertTenantRlsPreflight` for this database — `packages/pbx-db` and
 * `packages/cdr-db` still run theirs, and those are the databases that hold tenant rows.
 */
const apiTenantRole = pgRole(API_TENANT_ROLE_NAME, {
	createDb: false,
	createRole: false,
	inherit: false,
});

/** No tables. Kept as a named export so `drizzle()` call sites do not have to special-case it. */
const tables = {};

export { API_TENANT_ROLE_NAME, apiTenantRole, tables };
export { API_TENANT_SCOPE_SQL } from "./tenant";
