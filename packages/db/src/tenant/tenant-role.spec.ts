import { describe, expect, it } from "bun:test";
import {
	createTenantDatabaseContext,
	TenantContextNameError,
	tenantDatabaseRoleName,
	tenantOrganizationSettingName,
} from "./tenant-role";

describe("tenant database context", () => {
	it("derives the role and setting names from the bounded-context name", () => {
		const context = createTenantDatabaseContext("pbx");

		expect(context.contextName).toBe("pbx");
		expect(context.roleName).toBe("pbx_tenant_tls");
		expect(context.organizationSettingName).toBe("pbx_tenant_tls.organization_id");
	});

	it("keeps the standalone name helpers consistent with the context factory", () => {
		expect(tenantDatabaseRoleName("cdr")).toBe("cdr_tenant_tls");
		expect(tenantOrganizationSettingName("cdr")).toBe("cdr_tenant_tls.organization_id");
	});

	it("creates a non-inheriting role so the tenant scope cannot borrow runtime privileges", () => {
		// Drizzle keeps the role options as internal properties, so read them structurally.
		const role: {
			name: string;
			inherit?: boolean;
			createDb?: boolean;
			createRole?: boolean;
		} = createTenantDatabaseContext("pbx").role;

		expect(role.name).toBe("pbx_tenant_tls");
		expect(role.inherit).toBe(false);
		expect(role.createDb).toBe(false);
		expect(role.createRole).toBe(false);
	});

	it.each([
		["Pbx", "uppercase"],
		["1pbx", "leading digit"],
		["pbx-db", "hyphen"],
		["pbx;drop", "statement separator"],
		["", "empty"],
		["a".repeat(26), "too long"],
	])("rejects %p (%s) as a context name", (contextName) => {
		expect(() => createTenantDatabaseContext(contextName)).toThrow(TenantContextNameError);
	});
});
