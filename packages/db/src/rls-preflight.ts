import postgres from "postgres";

/**
 * Generic boot-time assertion harness for tenant row-level security.
 *
 * Every bounded-context database package supplies its own table plan; the evaluation logic and
 * the PostgreSQL catalogue query live here once. Introspection is injectable so the rules can be
 * exercised by unit specs with a fake catalogue and no live database.
 */

/** How much a tenant role may do to a table. Drives both privilege and policy-count expectations. */
export type TenantRlsTableMode =
	/** Full CRUD under a single `FOR ALL` policy. */
	| "read-write"
	/** SELECT/INSERT/UPDATE only — rows are never erasable by tenants. */
	| "no-delete"
	/** Ledger: SELECT + INSERT under two policies, UPDATE/DELETE explicitly forbidden. */
	| "append-only";

export interface TenantRlsTableExpectation {
	readonly table: string;
	/** @default "read-write" */
	readonly mode?: TenantRlsTableMode;
	/**
	 * Require `FORCE ROW LEVEL SECURITY`. Only correct for tables the owning principal itself
	 * must not bypass; forcing it elsewhere breaks migrations, so it is asserted in both directions.
	 * @default false
	 */
	readonly forceRowSecurity?: boolean;
}

export interface TenantRlsPreflightPlan {
	/** The `<context>_tenant_tls` role every policy is granted to. */
	readonly roleName: string;
	/** @default "public" */
	readonly schemaName?: string;
	readonly expectations: readonly TenantRlsTableExpectation[];
	/**
	 * Tables that carry an `organization_id` column and are deliberately NOT tenant-scoped —
	 * operator surfaces the tenant role holds no grant on (`cdr_write_quarantine`, whose column is
	 * nullable because half its rows have no resolvable organization).
	 *
	 * The introspector reads every org-scoped table in the schema, not just the planned ones, so
	 * that a tenant table added by a migration and never added to the plan is REPORTED rather than
	 * silently skipped. This list is the explicit, reviewable exception to that — a table only
	 * leaves the gate by being named here.
	 */
	readonly unscopedTables?: readonly string[];
}

/** One row of the PostgreSQL catalogue snapshot the evaluator reasons about. */
export interface TenantRlsIntrospectedTable {
	readonly table: string;
	readonly currentUser: string;
	readonly currentUserBypassesRls: boolean;
	readonly owner: string;
	readonly rowSecurity: boolean;
	readonly forceRowSecurity: boolean;
	readonly tenantPolicyCount: number;
	readonly tenantPolicyValid: boolean;
	readonly tenantRoleCanSet: boolean;
	readonly tenantRoleHasSchemaUsage: boolean;
	readonly tenantRoleHasTablePrivileges: boolean;
	readonly tenantRoleHasForbiddenPrivileges: boolean;
}

export interface TenantRlsPreflightResult {
	readonly errors: readonly string[];
	readonly ok: boolean;
}

export interface TenantRlsDeploymentPreflight extends TenantRlsPreflightResult {
	readonly tables: readonly TenantRlsIntrospectedTable[];
}

/** Raised by {@link assertTenantRlsPreflight} so boot fails before the app accepts traffic. */
export class TenantRlsPreflightError extends Error {
	readonly _tag = "TenantRlsPreflightError" as const;
	readonly errors: readonly string[];

	constructor(roleName: string, errors: readonly string[]) {
		super(`Tenant RLS preflight failed for role ${roleName}:\n- ${errors.join("\n- ")}`);
		this.name = "TenantRlsPreflightError";
		this.errors = errors;
	}
}

export const DEFAULT_TENANT_RLS_SCHEMA = "public";

export function expectedTenantPolicyCount(mode: TenantRlsTableMode): number {
	return mode === "append-only" ? 2 : 1;
}

export function requiredTenantTablePrivileges(mode: TenantRlsTableMode): string {
	switch (mode) {
		case "append-only":
			return "SELECT,INSERT";
		case "no-delete":
			return "SELECT,INSERT,UPDATE";
		default:
			return "SELECT,INSERT,UPDATE,DELETE";
	}
}

function evaluatePolicies(
	expectation: Required<TenantRlsTableExpectation>,
	table: TenantRlsIntrospectedTable,
): string[] {
	const errors: string[] = [];
	const expectedCount = expectedTenantPolicyCount(expectation.mode);
	if (table.tenantPolicyCount === 0) {
		errors.push(`${table.table}: tenant isolation policy is missing`);
	} else if (table.tenantPolicyCount !== expectedCount) {
		errors.push(
			`${table.table}: exactly ${String(expectedCount)} tenant isolation ${expectedCount === 1 ? "policy is" : "policies are"} required, found ${String(table.tenantPolicyCount)}`,
		);
	}
	if (!table.tenantPolicyValid) {
		errors.push(`${table.table}: tenant isolation policy definition is invalid`);
	}
	return errors;
}

function evaluatePrivileges(
	roleName: string,
	expectation: Required<TenantRlsTableExpectation>,
	table: TenantRlsIntrospectedTable,
): string[] {
	const errors: string[] = [];
	if (!table.tenantRoleCanSet) {
		errors.push(`${table.table}: current role cannot SET ROLE ${roleName}`);
	}
	if (!table.tenantRoleHasSchemaUsage) {
		errors.push(`${table.table}: ${roleName} lacks USAGE on the target schema`);
	}
	if (!table.tenantRoleHasTablePrivileges) {
		errors.push(
			`${table.table}: ${roleName} lacks required privileges (${requiredTenantTablePrivileges(expectation.mode)})`,
		);
	}
	if (table.tenantRoleHasForbiddenPrivileges) {
		errors.push(
			`${table.table}: ${roleName} holds mutation privileges forbidden by mode "${expectation.mode}"`,
		);
	}
	if (table.currentUser !== table.owner && !table.currentUserBypassesRls) {
		errors.push(
			`${table.table}: current role ${table.currentUser} is neither table owner nor BYPASSRLS`,
		);
	}
	return errors;
}

/** Pure evaluation of a catalogue snapshot against a plan. No I/O — this is what specs drive. */
export function evaluateTenantRlsPreflight(
	plan: TenantRlsPreflightPlan,
	tables: readonly TenantRlsIntrospectedTable[],
): TenantRlsPreflightResult {
	const errors: string[] = [];
	const introspected = new Map(tables.map((table) => [table.table, table]));
	const expected = new Map(
		plan.expectations.map((expectation) => [
			expectation.table,
			{
				table: expectation.table,
				mode: expectation.mode ?? ("read-write" as const),
				forceRowSecurity: expectation.forceRowSecurity ?? false,
			},
		]),
	);

	for (const expectation of expected.values()) {
		const table = introspected.get(expectation.table);
		if (!table) {
			errors.push(`${expectation.table}: table is missing`);
			continue;
		}
		if (!table.rowSecurity) {
			errors.push(`${table.table}: row-level security is not enabled`);
		}
		if (expectation.forceRowSecurity && !table.forceRowSecurity) {
			errors.push(`${table.table}: FORCE ROW LEVEL SECURITY is required`);
		}
		if (!expectation.forceRowSecurity && table.forceRowSecurity) {
			errors.push(`${table.table}: FORCE ROW LEVEL SECURITY is not allowed`);
		}
		errors.push(
			...evaluatePolicies(expectation, table),
			...evaluatePrivileges(plan.roleName, expectation, table),
		);
	}

	for (const table of introspected.keys()) {
		if (!expected.has(table)) {
			errors.push(`${table}: table was introspected but is not part of the preflight plan`);
		}
	}

	return { errors, ok: errors.length === 0 };
}

export type TenantRlsIntrospector = (
	plan: TenantRlsPreflightPlan,
) => Promise<readonly TenantRlsIntrospectedTable[]>;

/**
 * Reads the live PostgreSQL catalogue for the plan's tables.
 *
 * Policy names follow the convention `<table>_tenant_isolation` for read-write / no-delete
 * tables and `<table>_tenant_select` + `<table>_tenant_insert` for append-only ledgers.
 */
export function createPostgresTenantRlsIntrospector(databaseUrl: string): TenantRlsIntrospector {
	return async (plan) => {
		const schemaName = plan.schemaName ?? DEFAULT_TENANT_RLS_SCHEMA;
		const tableNames = plan.expectations.map((expectation) => expectation.table);
		const appendOnly = plan.expectations
			.filter((expectation) => expectation.mode === "append-only")
			.map((expectation) => expectation.table);
		const noDelete = plan.expectations
			.filter((expectation) => expectation.mode === "no-delete")
			.map((expectation) => expectation.table);
		// `postgres.js` cannot bind an empty array to `in (...)`, so keep an impossible sentinel.
		const appendOnlyNames = appendOnly.length > 0 ? appendOnly : ["__tenant_rls_no_tables__"];
		const noDeleteNames = noDelete.length > 0 ? noDelete : ["__tenant_rls_no_tables__"];
		const planNames = tableNames.length > 0 ? tableNames : ["__tenant_rls_no_tables__"];
		const unscoped = plan.unscopedTables ?? [];
		const unscopedNames = unscoped.length > 0 ? unscoped : ["__tenant_rls_no_tables__"];

		const client = postgres(databaseUrl, { max: 1 });
		try {
			const rows = await client<TenantRlsIntrospectedTable[]>`
				select
					class.relname as "table",
					current_user as "currentUser",
					current_role_row.rolbypassrls as "currentUserBypassesRls",
					owner_role.rolname as "owner",
					class.relrowsecurity as "rowSecurity",
					class.relforcerowsecurity as "forceRowSecurity",
					(
						select count(*)::int
						from pg_policies as policy
						where policy.schemaname = namespace.nspname
							and policy.tablename = class.relname
					) as "tenantPolicyCount",
					(
						select case
							when class.relname in ${client(appendOnlyNames)} then
								count(*) filter (
									where policy.policyname = class.relname || '_tenant_select'
										and policy.permissive = 'PERMISSIVE'
										and policy.cmd = 'SELECT'
										and policy.roles = array[${plan.roleName}]::name[]
										and policy.qual like ${`%${plan.roleName}.organization_id%`}
										and policy.with_check is null
								) = 1
								and count(*) filter (
									where policy.policyname = class.relname || '_tenant_insert'
										and policy.permissive = 'PERMISSIVE'
										and policy.cmd = 'INSERT'
										and policy.roles = array[${plan.roleName}]::name[]
										and policy.qual is null
										and policy.with_check like ${`%${plan.roleName}.organization_id%`}
								) = 1
							else
								count(*) filter (
									where policy.policyname = class.relname || '_tenant_isolation'
										and policy.permissive = 'PERMISSIVE'
										and policy.cmd = 'ALL'
										and policy.roles = array[${plan.roleName}]::name[]
										and policy.qual like ${`%${plan.roleName}.organization_id%`}
										and policy.with_check like ${`%${plan.roleName}.organization_id%`}
								) = 1
						end
						from pg_policies as policy
						where policy.schemaname = namespace.nspname
							and policy.tablename = class.relname
					) as "tenantPolicyValid",
					case
						when exists(select 1 from pg_roles where rolname = ${plan.roleName})
						then pg_has_role(current_user, ${plan.roleName}, 'SET')
						else false
					end as "tenantRoleCanSet",
					case
						when not exists(select 1 from pg_roles where rolname = ${plan.roleName})
						then false
						else has_schema_privilege(${plan.roleName}, namespace.nspname, 'USAGE')
					end as "tenantRoleHasSchemaUsage",
					case
						when not exists(select 1 from pg_roles where rolname = ${plan.roleName})
						then false
						else has_table_privilege(
							${plan.roleName},
							format('%I.%I', namespace.nspname, class.relname),
							case
								when class.relname in ${client(appendOnlyNames)} then 'SELECT,INSERT'
								when class.relname in ${client(noDeleteNames)} then 'SELECT,INSERT,UPDATE'
								else 'SELECT,INSERT,UPDATE,DELETE'
							end
						)
					end as "tenantRoleHasTablePrivileges",
					case
						when not exists(select 1 from pg_roles where rolname = ${plan.roleName})
						then false
						when class.relname in ${client(appendOnlyNames)}
						then has_table_privilege(
								${plan.roleName},
								format('%I.%I', namespace.nspname, class.relname),
								'UPDATE'
							) or has_table_privilege(
								${plan.roleName},
								format('%I.%I', namespace.nspname, class.relname),
								'DELETE'
							)
						when class.relname in ${client(noDeleteNames)}
						then has_table_privilege(
								${plan.roleName},
								format('%I.%I', namespace.nspname, class.relname),
								'DELETE'
							)
						else false
					end as "tenantRoleHasForbiddenPrivileges"
				from pg_class as class
				join pg_namespace as namespace on namespace.oid = class.relnamespace
				join pg_roles as owner_role on owner_role.oid = class.relowner
				join pg_roles as current_role_row on current_role_row.rolname = current_user
				where namespace.nspname = ${schemaName}
					and class.relkind in ('r', 'p')
					-- Partitions are reached only through their parent, whose policies apply; the
					-- plans deliberately do not list them.
					and not class.relispartition
					-- Every org-scoped table, not just the planned ones, so a tenant table that was
					-- added by a migration but never added to the plan is reported rather than
					-- silently skipped.
					and class.relname not in ${client(unscopedNames)}
					and (
						class.relname in ${client(planNames)}
						or exists (
							select 1
							from pg_attribute as attribute
							where attribute.attrelid = class.oid
								and attribute.attname = 'organization_id'
								and attribute.attnum > 0
								and not attribute.attisdropped
						)
					)
				order by class.relname
			`;
			return rows;
		} finally {
			await client.end({ timeout: 5 });
		}
	};
}

export async function runTenantRlsPreflight(
	plan: TenantRlsPreflightPlan,
	introspect: TenantRlsIntrospector,
): Promise<TenantRlsDeploymentPreflight> {
	const tables = await introspect(plan);
	const result = evaluateTenantRlsPreflight(plan, tables);
	return { errors: result.errors, ok: result.ok, tables };
}

/** Call from `main.ts` before the HTTP server is created; throws on the first misconfiguration. */
export async function assertTenantRlsPreflight(
	plan: TenantRlsPreflightPlan,
	introspect: TenantRlsIntrospector,
): Promise<TenantRlsDeploymentPreflight> {
	const preflight = await runTenantRlsPreflight(plan, introspect);
	if (!preflight.ok) {
		throw new TenantRlsPreflightError(plan.roleName, preflight.errors);
	}
	return preflight;
}
