import { type PgRole, pgRole } from "drizzle-orm/pg-core";

/** PostgreSQL identifiers we interpolate into DDL/SQL must be provably safe to inline. */
const CONTEXT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,24}$/u;

/** Raised when a bounded-context name cannot be used as a PostgreSQL identifier. */
export class TenantContextNameError extends Error {
	readonly contextName: string;

	constructor(contextName: string) {
		super(
			`Tenant context name "${contextName}" must match ${String(CONTEXT_NAME_PATTERN)} so it is safe to inline as a PostgreSQL identifier.`,
		);
		this.name = "TenantContextNameError";
		this.contextName = contextName;
	}
}

/**
 * Everything a bounded-context database needs to enforce tenant isolation: the non-inheriting
 * role every tenant-scoped statement runs as, and the transaction-local setting that carries
 * the active organization id into row-level-security policies.
 */
export interface TenantDatabaseContext {
	/** Bounded-context name, e.g. `pbx`, `cdr`, `auth`. */
	readonly contextName: string;
	/** `<context>_tenant_tls`. */
	readonly roleName: string;
	/** `<context>_tenant_tls.organization_id`. */
	readonly organizationSettingName: string;
	/** Drizzle role entity so migrations and policies can reference the role by object. */
	readonly role: PgRole;
}

export function tenantDatabaseRoleName(contextName: string): string {
	return `${contextName}_tenant_tls`;
}

export function tenantOrganizationSettingName(contextName: string): string {
	return `${tenantDatabaseRoleName(contextName)}.organization_id`;
}

/**
 * Creates the tenant role/setting pair for a bounded-context database.
 *
 * The role is created with `inherit: false` so a session that `SET ROLE`s into it drops every
 * privilege of the connecting principal — a runtime principal can therefore never read across
 * tenants even if a policy is missing.
 */
export function createTenantDatabaseContext(contextName: string): TenantDatabaseContext {
	if (!CONTEXT_NAME_PATTERN.test(contextName)) {
		throw new TenantContextNameError(contextName);
	}
	const roleName = tenantDatabaseRoleName(contextName);
	return {
		contextName,
		roleName,
		organizationSettingName: tenantOrganizationSettingName(contextName),
		role: pgRole(roleName, {
			createDb: false,
			createRole: false,
			inherit: false,
		}),
	};
}
