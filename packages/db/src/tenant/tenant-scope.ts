import { type SQL, sql } from "drizzle-orm";
import type { TenantDatabaseContext } from "./tenant-role";
import type { PgColumn } from "drizzle-orm/pg-core";

/** Identifiers inlined into policy SQL must be provably safe; column names are validated too. */
const COLUMN_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

/** Raised when a policy would be built from an unsafe column identifier. */
export class TenantScopeColumnError extends Error {
	readonly columnName: string;

	constructor(columnName: string) {
		super(
			`Tenant scope column "${columnName}" must match ${String(COLUMN_NAME_PATTERN)} so it is safe to inline into a row-level-security policy.`,
		);
		this.name = "TenantScopeColumnError";
		this.columnName = columnName;
	}
}

/**
 * Builds the predicate text shared by a bounded context's row-level-security policies.
 *
 * `current_setting(..., true)` returns NULL when the setting was never applied, and `nullif(...,'')`
 * turns the empty-string case into NULL as well. Comparing `organization_id = NULL` yields NULL,
 * so an unscoped transaction sees zero rows instead of every row — the failure mode is a denial,
 * never a leak.
 */
export function buildTenantScopeSql(settingName: string, columnName = "organization_id"): string {
	if (!COLUMN_NAME_PATTERN.test(columnName)) {
		throw new TenantScopeColumnError(columnName);
	}
	return `${columnName} = nullif(current_setting('${settingName}', true), '')::uuid`;
}

/** Drizzle fragment form of {@link buildTenantScopeSql} for `pgPolicy({ using, withCheck })`. */
export function tenantOrganizationScope(
	context: TenantDatabaseContext,
	columnName = "organization_id",
): SQL {
	return sql.raw(buildTenantScopeSql(context.organizationSettingName, columnName));
}

/** Same predicate bound to a typed Drizzle column instead of a literal column name. */
export function tenantColumnScope(context: TenantDatabaseContext, column: PgColumn): SQL {
	return sql`${column} = nullif(current_setting(${sql.raw(`'${context.organizationSettingName}'`)}, true), '')::uuid`;
}

/** Statements a tenant transaction issues before any tenant-scoped work runs. */
export function buildTenantSessionStatements(context: TenantDatabaseContext): {
	setRole: SQL;
	setOrganization: (organizationId: string) => SQL;
} {
	return {
		setRole: sql`set local role ${sql.identifier(context.roleName)}`,
		setOrganization: (organizationId: string) =>
			sql`select set_config(${context.organizationSettingName}, ${organizationId}, true)`,
	};
}
