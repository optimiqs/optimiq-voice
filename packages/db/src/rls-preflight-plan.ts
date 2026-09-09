import type { TenantRlsPreflightPlan } from "./rls-preflight";

/**
 * The base database's own tenant-RLS contract.
 *
 * It is **empty, and that is correct today**: this database holds only platform-global tables —
 * better-auth's `user` / `session` / `account` / `organization` / `member` / `invitation` /
 * `api_key` / `jwks` / `two_factor` / `verification`, plus the two transitional
 * `legacy_*` mapping tables from identity-removal Step 2. None of them is organization-scoped in
 * the row-level-security sense: `organization` and `member` *define* the tenant boundary rather
 * than living inside one, and a policy on them would make the very lookups that resolve a session
 * unrunnable.
 *
 * The tenant-scoped data lives in the bounded-context packages, which own their own plans:
 * `@optimiq-voice/pbx-db` (`PBX_TENANT_RLS_PLAN`, 35 tables) and `@optimiq-voice/cdr-db`.
 * `scripts/tenant-rls-preflight.ts` runs any of them — it is the shared runner, and
 * `--plan-module` picks which contract to assert.
 *
 * If Step 5 ever puts an org-scoped table in this database, add it here and the runner starts
 * enforcing it; until then the script reports `planEmpty: true` so an empty plan can never be
 * mistaken for a passing gate.
 *
 * `roleName` is a PLACEHOLDER: no migration creates `optimiq_tenant_tls`, because this database
 * has no tenant role. Whoever adds the first table here must replace it with the role that
 * migration actually creates — the introspector now degrades a non-existent role to "lacks
 * privileges" rather than raising `undefined_object`, so the failure is a diagnosis, but it is
 * still a failure.
 */
export const BASE_TENANT_RLS_PLAN: TenantRlsPreflightPlan = {
	roleName: "optimiq_tenant_tls",
	schemaName: "public",
	expectations: [],
};

export default BASE_TENANT_RLS_PLAN;
