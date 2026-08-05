import {
	createPostgresTenantRlsIntrospector,
	type TenantRlsIntrospector,
	type TenantRlsPreflightPlan,
} from "@optimiq-voice/db";
import { API_TENANT_ROLE_NAME } from "./tenant";

/**
 * The boot-time tenant-RLS contract for the telephony database — identity-removal
 * **Step 5 items 2 and 3**.
 *
 * Every table here carries `organization_id` (Step 5 item 1) and a
 * `<table>_tenant_isolation` policy granted to `api_tenant_tls`. The list is spelled out rather
 * than derived from the Drizzle table map on purpose: `products` is in the schema but is a
 * platform-global catalogue with no tenant column, and the preflight evaluator reports any table
 * it introspects that the plan does not cover — so a derived list would have to special-case it
 * anyway, and this way the exclusion is visible.
 *
 * `mode` is `read-write` throughout: every one of these tables is created, updated and deleted by
 * tenants through the ordinary CRUD handlers. Nothing here is an append-only ledger.
 *
 * `forceRowSecurity` stays false. The migration principal owns these tables and must keep
 * bypassing RLS, or migrations and the `products` seed could not run.
 */
export const API_TENANT_RLS_PLAN: TenantRlsPreflightPlan = {
	roleName: API_TENANT_ROLE_NAME,
	schemaName: "public",
	expectations: [
		{ table: "applications", mode: "read-write" },
		{ table: "intelligence_services", mode: "read-write" },
		{ table: "secrets", mode: "read-write" },
		{ table: "stt_services", mode: "read-write" },
		{ table: "tts_services", mode: "read-write" },
	],
};

/**
 * PostgreSQL-backed introspector for this database.
 *
 * Thin delegation to the shared `@optimiq-voice/db` introspector, kept as a named export so boot
 * wiring stays stable if this context ever needs plan-specific introspection — the same shape
 * `packages/pbx-db` exposes.
 */
export function createApiTenantRlsIntrospector(databaseUrl: string): TenantRlsIntrospector {
	return createPostgresTenantRlsIntrospector(databaseUrl);
}

export default API_TENANT_RLS_PLAN;
