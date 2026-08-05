import { describe, expect, it } from "bun:test";
import {
	assertTenantRlsPreflight,
	evaluateTenantRlsPreflight,
	expectedTenantPolicyCount,
	requiredTenantTablePrivileges,
	runTenantRlsPreflight,
	type TenantRlsIntrospectedTable,
	TenantRlsPreflightError,
	type TenantRlsPreflightPlan,
} from "./rls-preflight";

const ROLE_NAME = "pbx_tenant_tls";

function healthyTable(
	table: string,
	overrides: Partial<TenantRlsIntrospectedTable> = {},
): TenantRlsIntrospectedTable {
	return {
		table,
		currentUser: "optimiq_runtime",
		currentUserBypassesRls: false,
		owner: "optimiq_runtime",
		rowSecurity: true,
		forceRowSecurity: false,
		tenantPolicyCount: 1,
		tenantPolicyValid: true,
		tenantRoleCanSet: true,
		tenantRoleHasSchemaUsage: true,
		tenantRoleHasTablePrivileges: true,
		tenantRoleHasForbiddenPrivileges: false,
		...overrides,
	};
}

const plan: TenantRlsPreflightPlan = {
	roleName: ROLE_NAME,
	expectations: [{ table: "extension" }, { table: "cdr_leg", mode: "append-only" }],
};

const healthyTables = [
	healthyTable("extension"),
	healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
];

describe("mode helpers", () => {
	it("requires two policies for append-only ledgers and one everywhere else", () => {
		expect(expectedTenantPolicyCount("append-only")).toBe(2);
		expect(expectedTenantPolicyCount("read-write")).toBe(1);
		expect(expectedTenantPolicyCount("no-delete")).toBe(1);
	});

	it("maps each mode to the privileges the tenant role must hold", () => {
		expect(requiredTenantTablePrivileges("read-write")).toBe("SELECT,INSERT,UPDATE,DELETE");
		expect(requiredTenantTablePrivileges("no-delete")).toBe("SELECT,INSERT,UPDATE");
		expect(requiredTenantTablePrivileges("append-only")).toBe("SELECT,INSERT");
	});
});

describe("evaluateTenantRlsPreflight", () => {
	it("passes a fully configured plan", () => {
		expect(evaluateTenantRlsPreflight(plan, healthyTables)).toEqual({
			errors: [],
			ok: true,
		});
	});

	it("reports a table that the plan expects but the database does not have", () => {
		const result = evaluateTenantRlsPreflight(plan, [healthyTable("extension")]);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("cdr_leg: table is missing");
	});

	it("reports a tenant table that nobody put in the plan", () => {
		const result = evaluateTenantRlsPreflight(plan, [...healthyTables, healthyTable("voicemail")]);

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			"voicemail: table was introspected but is not part of the preflight plan",
		);
	});

	it("fails when row-level security is not enabled", () => {
		const result = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", { rowSecurity: false }),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);

		expect(result.errors).toContain("extension: row-level security is not enabled");
	});

	it("asserts FORCE ROW LEVEL SECURITY in both directions", () => {
		const forced = evaluateTenantRlsPreflight(
			{
				roleName: ROLE_NAME,
				expectations: [{ table: "extension", forceRowSecurity: true }],
			},
			[healthyTable("extension", { forceRowSecurity: false })],
		);
		expect(forced.errors).toContain("extension: FORCE ROW LEVEL SECURITY is required");

		const unforced = evaluateTenantRlsPreflight(
			{ roleName: ROLE_NAME, expectations: [{ table: "extension" }] },
			[healthyTable("extension", { forceRowSecurity: true })],
		);
		expect(unforced.errors).toContain("extension: FORCE ROW LEVEL SECURITY is not allowed");
	});

	it("fails on a missing policy, a wrong policy count and an invalid policy body", () => {
		const missing = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", { tenantPolicyCount: 0 }),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);
		expect(missing.errors).toContain("extension: tenant isolation policy is missing");

		const wrongCount = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension"),
			healthyTable("cdr_leg", { tenantPolicyCount: 1 }),
		]);
		expect(wrongCount.errors).toContain(
			"cdr_leg: exactly 2 tenant isolation policies are required, found 1",
		);

		const invalid = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", { tenantPolicyValid: false }),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);
		expect(invalid.errors).toContain("extension: tenant isolation policy definition is invalid");
	});

	it("fails when the runtime principal cannot assume the tenant role", () => {
		const result = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", { tenantRoleCanSet: false }),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);

		expect(result.errors).toContain(`extension: current role cannot SET ROLE ${ROLE_NAME}`);
	});

	it("fails when the tenant role is missing schema usage or table privileges", () => {
		const result = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", {
				tenantRoleHasSchemaUsage: false,
				tenantRoleHasTablePrivileges: false,
			}),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);

		expect(result.errors).toContain(`extension: ${ROLE_NAME} lacks USAGE on the target schema`);
		expect(result.errors).toContain(
			`extension: ${ROLE_NAME} lacks required privileges (SELECT,INSERT,UPDATE,DELETE)`,
		);
	});

	it("fails when an append-only ledger grants the tenant role UPDATE or DELETE", () => {
		const result = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension"),
			healthyTable("cdr_leg", {
				tenantPolicyCount: 2,
				tenantRoleHasForbiddenPrivileges: true,
			}),
		]);

		expect(result.errors).toContain(
			`cdr_leg: ${ROLE_NAME} holds mutation privileges forbidden by mode "append-only"`,
		);
	});

	it("fails when the connected principal is neither owner nor BYPASSRLS", () => {
		const result = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", {
				owner: "someone_else",
				currentUserBypassesRls: false,
			}),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);

		expect(result.errors).toContain(
			"extension: current role optimiq_runtime is neither table owner nor BYPASSRLS",
		);
	});

	it("accepts a non-owner principal that holds BYPASSRLS", () => {
		const result = evaluateTenantRlsPreflight(plan, [
			healthyTable("extension", {
				owner: "someone_else",
				currentUserBypassesRls: true,
			}),
			healthyTable("cdr_leg", { tenantPolicyCount: 2 }),
		]);

		expect(result.ok).toBe(true);
	});
});

describe("runTenantRlsPreflight / assertTenantRlsPreflight", () => {
	it("returns the introspected snapshot alongside the verdict", async () => {
		const preflight = await runTenantRlsPreflight(plan, () => Promise.resolve(healthyTables));

		expect(preflight.ok).toBe(true);
		expect(preflight.tables).toHaveLength(2);
	});

	it("passes the plan through to the introspector", async () => {
		let seen: TenantRlsPreflightPlan | undefined;
		await runTenantRlsPreflight(plan, (received) => {
			seen = received;
			return Promise.resolve(healthyTables);
		});

		expect(seen).toBe(plan);
	});

	it("throws a TenantRlsPreflightError carrying every failure", async () => {
		const broken = [healthyTable("extension", { rowSecurity: false })];

		const error = await assertTenantRlsPreflight(plan, () => Promise.resolve(broken)).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(TenantRlsPreflightError);
		expect((error as TenantRlsPreflightError).errors.length).toBeGreaterThan(0);
		expect((error as TenantRlsPreflightError).message).toContain(ROLE_NAME);
	});

	it("resolves when every table is compliant", async () => {
		await expect(
			assertTenantRlsPreflight(plan, () => Promise.resolve(healthyTables)),
		).resolves.toMatchObject({ ok: true });
	});
});
