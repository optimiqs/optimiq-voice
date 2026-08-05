import { type TenantRlsPreflightPlan } from "@optimiq-voice/db";
import { cdrTenantContext } from "./cdr-context";

/**
 * Boot-time RLS contract for the CDR database.
 *
 * `call_legs` and `call_events` are `append-only`: the harness then requires exactly two tenant
 * policies (`_tenant_select` + `_tenant_insert`), SELECT+INSERT privileges, and asserts the
 * tenant role holds NO update or delete privilege. That is the whole append-only guarantee,
 * checked against the live catalogue before the process accepts traffic.
 *
 * `recordings` is `read-write`: the retention lifecycle mutates `deleted_at`, and tenants may
 * correct ownership metadata.
 *
 * `forceRowSecurity` is left false everywhere on purpose, and the harness asserts that in both
 * directions. The schema owner must stay able to bypass RLS: it runs the migrations, the
 * partition ensure/drop functions, and the writer's enrichment updates (see `writer.ts`).
 *
 * Partitions (`call_legs_2026_08`, …) are intentionally absent from the plan. The tenant role has
 * no grants on them, so it can only reach rows through the parent, where the parent's policies
 * apply. Listing them would also make the plan time-dependent, which a boot assertion must not be.
 */
export const cdrTenantRlsPreflightPlan: TenantRlsPreflightPlan = {
	roleName: cdrTenantContext.roleName,
	schemaName: "public",
	expectations: [
		{ table: "call_events", mode: "append-only", forceRowSecurity: false },
		{ table: "call_legs", mode: "append-only", forceRowSecurity: false },
		{ table: "recordings", mode: "read-write", forceRowSecurity: false },
	],
};

/** Tables whose rows a tenant may never modify once written. */
export const CDR_APPEND_ONLY_TABLES = cdrTenantRlsPreflightPlan.expectations
	.filter((expectation) => expectation.mode === "append-only")
	.map((expectation) => expectation.table);
