import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { createTenantDatabaseContext } from "./tenant-role";
import {
	buildTenantScopeSql,
	buildTenantSessionStatements,
	TenantScopeColumnError,
	tenantOrganizationScope,
} from "./tenant-scope";

const pbx = createTenantDatabaseContext("pbx");

describe("buildTenantScopeSql", () => {
	it("compares the tenant column against the transaction-local setting", () => {
		expect(buildTenantScopeSql(pbx.organizationSettingName)).toBe(
			"organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid",
		);
	});

	it("uses the missing-ok form of current_setting so an unscoped session denies instead of leaking", () => {
		const scope = buildTenantScopeSql(pbx.organizationSettingName);

		expect(scope).toContain("current_setting('pbx_tenant_tls.organization_id', true)");
		expect(scope).toContain("nullif(");
		expect(scope).toEndWith("::uuid");
	});

	it("supports a non-default tenant column", () => {
		expect(buildTenantScopeSql(pbx.organizationSettingName, "owner_organization_id")).toBe(
			"owner_organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid",
		);
	});

	it.each([["Organization_Id"], ["organization id"], ["organization_id;--"], ["1org"], [""]])(
		"rejects %p as a tenant column name",
		(columnName) => {
			expect(() => buildTenantScopeSql(pbx.organizationSettingName, columnName)).toThrow(
				TenantScopeColumnError,
			);
		},
	);

	it("produces the same text through the Drizzle fragment helper", () => {
		const fragment = tenantOrganizationScope(pbx);

		expect(fragment.queryChunks.length).toBeGreaterThan(0);
	});
});

describe("buildTenantSessionStatements", () => {
	const dialect = new PgDialect();

	it("quotes the tenant role as an identifier", () => {
		expect(dialect.sqlToQuery(buildTenantSessionStatements(pbx).setRole).sql).toBe(
			'set local role "pbx_tenant_tls"',
		);
	});

	it("binds the organization id as a parameter rather than inlining it", () => {
		const query = dialect.sqlToQuery(
			buildTenantSessionStatements(pbx).setOrganization("018f2b2a-0000-7000-8000-000000000000"),
		);

		expect(query.sql).toBe("select set_config($1, $2, true)");
		expect(query.params).toEqual([
			"pbx_tenant_tls.organization_id",
			"018f2b2a-0000-7000-8000-000000000000",
		]);
	});
});
