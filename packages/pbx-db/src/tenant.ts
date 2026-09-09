import { type AnyPgColumn, foreignKey, pgPolicy, type PgPolicy } from "drizzle-orm/pg-core";
import {
	createTenantDatabaseContext,
	type TenantDatabaseContext,
	tenantOrganizationScope,
} from "@optimiq-voice/db";

/**
 * The telephony bounded context. Everything tenant-scoped in this database runs as
 * `pbx_tenant_tls` and is filtered by the transaction-local `pbx_tenant_tls.organization_id`
 * setting; the role is created with `inherit: false` so `set local role` drops every privilege
 * the connecting principal holds.
 */
export const PBX_TENANT_CONTEXT_NAME = "pbx";

export const pbxTenantContext: TenantDatabaseContext =
	createTenantDatabaseContext(PBX_TENANT_CONTEXT_NAME);

/** Exported for `drizzle-kit` (which manages the role) and for `pgPolicy({ to })`. */
export const pbxTenantRole = pbxTenantContext.role;

/**
 * `organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid`.
 * An unscoped transaction compares against NULL and therefore sees zero rows.
 */
const pbxTenantScope = tenantOrganizationScope(pbxTenantContext);

/**
 * The single `FOR ALL` policy every read-write tenant table carries.
 *
 * The name is load-bearing: {@link import("@optimiq-voice/db").createPostgresTenantRlsIntrospector}
 * asserts `<table>_tenant_isolation` exists with exactly this shape.
 */
export function tenantIsolationPolicy(tableName: string): PgPolicy {
	return pgPolicy(`${tableName}_tenant_isolation`, {
		as: "permissive",
		for: "all",
		to: pbxTenantRole,
		using: pbxTenantScope,
		withCheck: pbxTenantScope,
	});
}

/**
 * Append-only ledgers get two policies instead of one — SELECT and INSERT — so no UPDATE or
 * DELETE path exists for a tenant even if the role were mistakenly granted the privilege.
 * The preflight harness expects exactly `<table>_tenant_select` and `<table>_tenant_insert`.
 */
export function appendOnlyTenantPolicies(tableName: string): readonly [PgPolicy, PgPolicy] {
	return [
		pgPolicy(`${tableName}_tenant_select`, {
			as: "permissive",
			for: "select",
			to: pbxTenantRole,
			using: pbxTenantScope,
		}),
		pgPolicy(`${tableName}_tenant_insert`, {
			as: "permissive",
			for: "insert",
			to: pbxTenantRole,
			withCheck: pbxTenantScope,
		}),
	];
}

/**
 * A foreign key whose first column is the tenant, so a cross-tenant reference is illegal in the
 * DATABASE and not merely in whichever repository happens to scope its lookup.
 *
 * PostgreSQL checks referential integrity with row-level security bypassed, and a tenant policy
 * only constrains a row's own `organization_id` — so `references(() => parent.id)` alone lets
 * organization A bind a row to a row owned by organization B. Referencing
 * `(organization_id, id)` makes that reference unresolvable. The parent therefore carries a
 * `<table>_organization_id_key` unique index, which is what this points at.
 *
 * `onDelete` is always `cascade`: `set null` would null the tenant column too (PostgreSQL nulls
 * every referencing column), and `organization_id` is NOT NULL.
 */
export function tenantCompositeForeignKey(config: {
	readonly name: string;
	readonly columns: [AnyPgColumn, ...AnyPgColumn[]];
	readonly foreignColumns: [AnyPgColumn, ...AnyPgColumn[]];
}) {
	return foreignKey({
		name: config.name,
		columns: config.columns,
		foreignColumns: config.foreignColumns,
	}).onDelete("cascade");
}
