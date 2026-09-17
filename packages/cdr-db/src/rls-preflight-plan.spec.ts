import { describe, expect, it } from "bun:test";
import {
	evaluateTenantRlsPreflight,
	expectedTenantPolicyCount,
	requiredTenantTablePrivileges,
	type TenantRlsIntrospectedTable,
} from "@optimiq-voice/db";
import { cdrTenantContext } from "./cdr-context";
import { CDR_APPEND_ONLY_TABLES, cdrTenantRlsPreflightPlan } from "./rls-preflight-plan";

function healthy(
	table: string,
	overrides: Partial<TenantRlsIntrospectedTable> = {},
): TenantRlsIntrospectedTable {
	return {
		table,
		currentUser: "optimiq",
		currentUserBypassesRls: false,
		owner: "optimiq",
		rowSecurity: true,
		forceRowSecurity: false,
		tenantPolicyCount: CDR_APPEND_ONLY_TABLES.includes(table) ? 2 : 1,
		tenantPolicyValid: true,
		tenantRoleCanSet: true,
		tenantRoleHasSchemaUsage: true,
		tenantRoleHasTablePrivileges: true,
		tenantRoleHasForbiddenPrivileges: false,
		...overrides,
	};
}

const healthyCatalogue = cdrTenantRlsPreflightPlan.expectations.map((expectation) =>
	healthy(expectation.table),
);

describe("cdr tenant RLS preflight plan", () => {
	it("binds to the cdr_tenant_tls role in the public schema", () => {
		expect(cdrTenantRlsPreflightPlan.roleName).toBe("cdr_tenant_tls");
		expect(cdrTenantRlsPreflightPlan.roleName).toBe(cdrTenantContext.roleName);
		expect(cdrTenantRlsPreflightPlan.schemaName).toBe("public");
	});

	/**
	 * The whole list, in order, so a table added to this database cannot arrive without somebody
	 * choosing its mode. That is the point of asserting the exact array rather than a membership:
	 * the DEFAULT for a new table is "nobody thought about it", and the append-only guarantee is a
	 * privilege fact that no policy edit can restore once it has been given away.
	 */
	it("declares the two ledgers append-only and the two lifecycles read-write", () => {
		expect(
			cdrTenantRlsPreflightPlan.expectations.map((expectation) => [
				expectation.table,
				expectation.mode,
			]),
		).toEqual([
			["call_events", "append-only"],
			["call_legs", "append-only"],
			// An export job is claimed, advanced and completed — every transition an UPDATE.
			["cdr_export_job", "read-write"],
			["recordings", "read-write"],
		]);
		expect(CDR_APPEND_ONLY_TABLES).toEqual(["call_events", "call_legs"]);
	});

	it("keeps the schema owner able to bypass RLS so migrations and enrichment work", () => {
		for (const expectation of cdrTenantRlsPreflightPlan.expectations) {
			expect(expectation.forceRowSecurity).toBe(false);
		}
	});

	it("means SELECT+INSERT and two policies for the ledgers", () => {
		expect(requiredTenantTablePrivileges("append-only")).toBe("SELECT,INSERT");
		expect(expectedTenantPolicyCount("append-only")).toBe(2);
		expect(expectedTenantPolicyCount("read-write")).toBe(1);
	});

	it("passes against a healthy catalogue", () => {
		expect(evaluateTenantRlsPreflight(cdrTenantRlsPreflightPlan, healthyCatalogue).ok).toBe(true);
	});

	it("fails when a ledger grants the tenant role UPDATE or DELETE", () => {
		const result = evaluateTenantRlsPreflight(cdrTenantRlsPreflightPlan, [
			healthy("call_events"),
			healthy("call_legs", { tenantRoleHasForbiddenPrivileges: true }),
			healthy("cdr_export_job"),
			healthy("recordings"),
		]);

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("forbidden by mode");
	});

	it("fails when a ledger grows a third policy", () => {
		const result = evaluateTenantRlsPreflight(cdrTenantRlsPreflightPlan, [
			healthy("call_events"),
			healthy("call_legs", { tenantPolicyCount: 3 }),
			healthy("cdr_export_job"),
			healthy("recordings"),
		]);

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("exactly 2 tenant isolation policies");
	});

	it("fails when row-level security is off anywhere", () => {
		const result = evaluateTenantRlsPreflight(cdrTenantRlsPreflightPlan, [
			healthy("call_events"),
			healthy("call_legs"),
			healthy("cdr_export_job"),
			healthy("recordings", { rowSecurity: false }),
		]);

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("row-level security is not enabled");
	});

	it("fails when a table is missing entirely", () => {
		const result = evaluateTenantRlsPreflight(cdrTenantRlsPreflightPlan, [healthy("call_legs")]);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("call_events: table is missing");
	});
});
