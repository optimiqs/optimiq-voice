import { createTenantDatabaseContext } from "@optimiq-voice/db";

/**
 * The `api` bounded context's tenant identity — identity-removal **Step 5 item 2**.
 *
 * `packages/pbx-db` and `packages/cdr-db` build theirs by importing `createTenantDatabaseContext`
 * and using the `PgRole` / `SQL` objects it hands back directly. This package **cannot**: pnpm
 * resolves `drizzle-orm@1.0.0-rc.4` once per distinct peer set, and `apps/api` pulls in
 * `pg` / `@types/pg` while `packages/db` does not, so the two receive separate — structurally
 * identical, nominally incompatible — instances of the same build. Handing a `pgRole()` built by
 * one to a `pgPolicy({ to })` imported from the other is a type error, and drizzle-kit would be
 * serialising an object from a foreign registry.
 *
 * Only the **string** helpers cross the boundary, which they can do safely because they are pure
 * functions over strings. The role and the policy predicate are then rebuilt from those strings
 * with this package's own drizzle. `test/core/tenantContext.test.ts` pins the two representations
 * together so they cannot drift.
 */

export const API_TENANT_CONTEXT_NAME = "api";

const context = createTenantDatabaseContext(API_TENANT_CONTEXT_NAME);

/** `api_tenant_tls` — the non-inheriting role every tenant-scoped statement runs as. */
export const API_TENANT_ROLE_NAME: string = context.roleName;

/** `api_tenant_tls.organization_id` — the transaction-local setting the policies read. */
export const API_TENANT_ORGANIZATION_SETTING: string = context.organizationSettingName;

/**
 * `organization_id = nullif(current_setting('api_tenant_tls.organization_id', true), '')::uuid`
 *
 * The missing-ok form of `current_setting` means an unscoped transaction compares against NULL
 * and sees zero rows: the failure mode is a denial, never a leak.
 */
export const API_TENANT_SCOPE_SQL = `organization_id = nullif(current_setting('${API_TENANT_ORGANIZATION_SETTING}', true), '')::uuid`;
