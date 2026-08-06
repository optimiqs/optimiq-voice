import { expect } from "chai";
import {
	buildTenantScopeSql,
	buildTenantSessionStatements,
	createTenantDatabaseContext,
	tenantDatabaseRoleName,
	tenantOrganizationSettingName,
} from "@optimiq-voice/db";
import { apiTenantRole, tables } from "../../src/core/db/schema";
import {
	API_TENANT_CONTEXT_NAME,
	API_TENANT_ORGANIZATION_SETTING,
	API_TENANT_ROLE_NAME,
	API_TENANT_SCOPE_SQL,
} from "../../src/core/db/tenant";

/**
 * `apps/api` and `packages/db` resolve different `drizzle-orm@1.0.0-rc.4` instances (apps/api
 * pulls in `pg`, packages/db does not), so this package rebuilds the tenant role and the policy
 * predicate from the shared *string* helpers instead of importing the drizzle objects — see the
 * long note in `src/core/db/tenant.ts`. These cases are what stops the two representations from
 * drifting: if `@optimiq-voice/db` ever changes how it names a role or spells a policy, the
 * migrations this package already shipped become wrong, and this fails first.
 */
describe("@core/tenantContext", function () {
	it("names the role exactly as the shared helper does", function () {
		expect(API_TENANT_ROLE_NAME).to.equal(tenantDatabaseRoleName(API_TENANT_CONTEXT_NAME));
		expect(API_TENANT_ROLE_NAME).to.equal("api_tenant_tls");
	});

	it("names the transaction-local setting exactly as the shared helper does", function () {
		expect(API_TENANT_ORGANIZATION_SETTING).to.equal(
			tenantOrganizationSettingName(API_TENANT_CONTEXT_NAME),
		);
		expect(API_TENANT_ORGANIZATION_SETTING).to.equal("api_tenant_tls.organization_id");
	});

	it("spells the policy predicate exactly as the shared builder does", function () {
		expect(API_TENANT_SCOPE_SQL).to.equal(buildTenantScopeSql(API_TENANT_ORGANIZATION_SETTING));
	});

	it("uses the missing-ok form of current_setting so an unscoped session denies", function () {
		// `current_setting(..., true)` is NULL when unset and `nullif(...,'')` folds the empty
		// string in, so `organization_id = NULL` matches nothing. The failure mode is a denial.
		expect(API_TENANT_SCOPE_SQL).to.contain(
			"current_setting('api_tenant_tls.organization_id', true)",
		);
		expect(API_TENANT_SCOPE_SQL).to.contain("nullif(");
		expect(API_TENANT_SCOPE_SQL).to.match(/::uuid$/u);
	});

	it("creates the role without inheritance, so `set role` drops every privilege", function () {
		const role = createTenantDatabaseContext(API_TENANT_CONTEXT_NAME).role as unknown as {
			name: string;
			inherit?: boolean;
		};
		expect(role.name).to.equal(API_TENANT_ROLE_NAME);
		expect(role.inherit).to.equal(false);
	});

	it("issues the same two session statements the facade issues", function () {
		const statements = buildTenantSessionStatements(
			createTenantDatabaseContext(API_TENANT_CONTEXT_NAME),
		);
		expect(statements).to.have.property("setRole");
		expect(statements).to.have.property("setOrganization");
	});

	it("owns no tables, which is why there is no boot preflight for this database", function () {
		// The five tenant-scoped tables this context used to own — applications, secrets,
		// tts_services, stt_services, intelligence_services — belonged to the deleted gRPC platform
		// and were dropped by `drizzle/20260806164427_drop_legacy_api_tables`. `main.ts` therefore
		// runs no `assertTenantRlsPreflight` here; pbx-db and cdr-db still run theirs.
		//
		// The day this context grows a tenant table again, this case fails first — and the fix is
		// to declare it with a `<table>_tenant_isolation` policy, grant it to the role below, and
		// restore the preflight rather than to delete this assertion.
		expect(Object.keys(tables)).to.deep.equal([]);
		expect((apiTenantRole as unknown as { name: string }).name).to.equal(API_TENANT_ROLE_NAME);
	});
});
