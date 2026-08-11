import { getTableName } from "drizzle-orm";
import {
	createPostgresTenantRlsIntrospector,
	type TenantRlsIntrospector,
	type TenantRlsPreflightPlan,
	type TenantRlsTableExpectation,
} from "@optimiq-voice/db";
import { auditLog, sipAuthEvent } from "./schema/security-schema";
import { pbxTables } from "./schema/tables";
import { pbxTenantContext } from "./tenant";

/**
 * The boot-time contract for this database.
 *
 * The expectation list is derived from {@link pbxTables} rather than hand-maintained, so a table
 * added to the schema without a matching policy fails preflight instead of shipping unprotected —
 * the preflight evaluator also reports any table it introspects that the plan does not cover.
 */

/** Ledgers: `SELECT` + `INSERT` only, two policies, no UPDATE/DELETE privilege. */
export const PBX_APPEND_ONLY_TABLES: readonly string[] = [
	getTableName(auditLog),
	getTableName(sipAuthEvent),
];

function expectationFor(table: string): TenantRlsTableExpectation {
	return PBX_APPEND_ONLY_TABLES.includes(table)
		? { table, mode: "append-only" }
		: { table, mode: "read-write" };
}

/** Physical table names, sorted, for grants and for the preflight plan. */
export const PBX_TENANT_TABLES: readonly string[] = Object.values(pbxTables)
	.map((table) => getTableName(table))
	.sort((left, right) => left.localeCompare(right));

export const PBX_TENANT_RLS_PLAN: TenantRlsPreflightPlan = {
	roleName: pbxTenantContext.roleName,
	schemaName: "public",
	expectations: PBX_TENANT_TABLES.map(expectationFor),
};

/**
 * PostgreSQL-backed introspector for this database. Thin delegation to the shared
 * @optimiq-voice/db introspector (its empty-mode-bucket sentinel bug is fixed), kept as a named
 * export so boot wiring stays stable if this context ever needs plan-specific introspection.
 */
export function createPbxTenantRlsIntrospector(databaseUrl: string): TenantRlsIntrospector {
	return createPostgresTenantRlsIntrospector(databaseUrl);
}
