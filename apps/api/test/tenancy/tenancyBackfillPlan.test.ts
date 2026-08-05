import { expect } from "chai";
import {
	addResolution,
	emptyTenantRowCounts,
	findFinalizationBlockers,
	isLegacyWorkspaceAccessKey,
	isUuid,
	resolveOrganizationId,
	TENANT_DERIVED_TABLES,
	TENANT_SOURCE_TABLES,
	TENANT_TABLES,
	type TenantLedger,
	unresolvedRowCount,
} from "../../scripts/tenancy/plan";

const ORGANIZATION_A = "019fd41e-e73c-73fc-8fa9-b5512fecd859";
const ORGANIZATION_B = "019fd41e-e73e-743d-96a7-1c42f48b4b29";

function ledger(entries: [string, string][] = [["WOalpha", ORGANIZATION_A]]): TenantLedger {
	return {
		byAccessKey: new Map(entries),
		organizationIds: new Set([...entries.map(([, id]) => id), ORGANIZATION_B]),
	};
}

describe("@tenancy/backfillPlan", function () {
	describe("access key recognition", function () {
		it("recognises a legacy workspace key", function () {
			expect(isLegacyWorkspaceAccessKey("WOidentitymigrationfixturea")).to.be.true;
		});

		it("does not mistake a user key for a workspace key", function () {
			// `US…` identified a person and never scoped a telephony row (plan §2.10, Step 2
			// correction 2), so it must never be treated as a tenant.
			expect(isLegacyWorkspaceAccessKey("US14wj8q6qlirw331gfswusfblie6h78uz")).to.be.false;
		});

		it("rejects a key with a separator that would be unsafe if it reached SQL", function () {
			expect(isLegacyWorkspaceAccessKey("WO-alpha;drop")).to.be.false;
		});

		it("recognises the uuid an organization id serialises to", function () {
			expect(isUuid(ORGANIZATION_A)).to.be.true;
			expect(isUuid("not-a-uuid")).to.be.false;
		});
	});

	describe("resolveOrganizationId", function () {
		it("maps a legacy key through the ledger", function () {
			expect(resolveOrganizationId("WOalpha", ledger())).to.deep.equal({
				kind: "mapped",
				organizationId: ORGANIZATION_A,
			});
		});

		it("trims before looking up, so whitespace is not a distinct tenant", function () {
			expect(resolveOrganizationId("  WOalpha  ", ledger())).to.deep.equal({
				kind: "mapped",
				organizationId: ORGANIZATION_A,
			});
		});

		it("treats a known organization id in the legacy column as already scoped", function () {
			// Rows written after the cutover store the organization id in both columns, because
			// `access_key_id` is still `not null` until Step 9.
			expect(resolveOrganizationId(ORGANIZATION_B, ledger())).to.deep.equal({
				kind: "self",
				organizationId: ORGANIZATION_B,
			});
		});

		it("normalises the case of a self-referencing organization id", function () {
			expect(resolveOrganizationId(ORGANIZATION_B.toUpperCase(), ledger())).to.deep.equal({
				kind: "self",
				organizationId: ORGANIZATION_B,
			});
		});

		it("does NOT accept a well-formed uuid that is not a known organization", function () {
			// Otherwise a stray uuid would silently become a tenant nobody can administer.
			expect(resolveOrganizationId("00000000-0000-4000-8000-000000000000", ledger())).to.deep.equal(
				{ kind: "unmapped", accessKeyId: "00000000-0000-4000-8000-000000000000" },
			);
		});

		it("reports an unmigrated workspace key rather than guessing", function () {
			expect(resolveOrganizationId("WOnever-migrated", ledger())).to.have.property(
				"kind",
				"unmapped",
			);
		});

		it("reports blank, null and undefined as blank", function () {
			for (const value of ["", "   ", null, undefined]) {
				expect(resolveOrganizationId(value, ledger())).to.deep.equal({ kind: "blank" });
			}
		});
	});

	describe("counts", function () {
		it("starts at zero on every axis", function () {
			expect(emptyTenantRowCounts()).to.deep.equal({
				alreadyScoped: 0,
				mapped: 0,
				selfMapped: 0,
				blank: 0,
				unmapped: 0,
			});
		});

		it("accumulates each resolution into its own bucket", function () {
			let counts = emptyTenantRowCounts();
			counts = addResolution(counts, { kind: "mapped", organizationId: ORGANIZATION_A });
			counts = addResolution(counts, { kind: "self", organizationId: ORGANIZATION_B });
			counts = addResolution(counts, { kind: "blank" });
			counts = addResolution(counts, { kind: "unmapped", accessKeyId: "WOx" });

			expect(counts).to.deep.equal({
				alreadyScoped: 0,
				mapped: 1,
				selfMapped: 1,
				blank: 1,
				unmapped: 1,
			});
		});

		it("counts only blank and unmapped rows as unresolved", function () {
			expect(
				unresolvedRowCount({
					alreadyScoped: 9,
					mapped: 5,
					selfMapped: 3,
					blank: 2,
					unmapped: 1,
				}),
			).to.equal(3);
		});
	});

	describe("findFinalizationBlockers", function () {
		const clean = new Map(TENANT_TABLES.map((table) => [table, emptyTenantRowCounts()]));

		it("permits NOT NULL when every table resolved", function () {
			expect(findFinalizationBlockers(clean)).to.deep.equal([]);
		});

		it("refuses when a table was never inspected", function () {
			const partial = new Map(clean);
			partial.delete("secrets");
			expect(findFinalizationBlockers(partial)).to.deep.equal(["secrets: not inspected"]);
		});

		it("refuses on a blank access key and says which table", function () {
			const withBlank = new Map(clean);
			withBlank.set("applications", { ...emptyTenantRowCounts(), blank: 2 });
			expect(findFinalizationBlockers(withBlank)[0]).to.contain("applications").and.contain("2");
		});

		it("refuses on an unmapped access key", function () {
			const withUnmapped = new Map(clean);
			withUnmapped.set("tts_services", { ...emptyTenantRowCounts(), unmapped: 1 });
			expect(findFinalizationBlockers(withUnmapped)[0]).to.contain("tts_services");
		});
	});

	describe("table ordering", function () {
		it("puts the tables that carry the tenant before the ones that inherit it", function () {
			// The derived pass reads `applications.organization_id`, so it is only correct after
			// the source pass has written it.
			expect(TENANT_TABLES.slice(0, TENANT_SOURCE_TABLES.length)).to.deep.equal([
				...TENANT_SOURCE_TABLES,
			]);
			expect(TENANT_TABLES.slice(TENANT_SOURCE_TABLES.length)).to.deep.equal([
				...TENANT_DERIVED_TABLES,
			]);
		});

		it("covers exactly the five telephony tables and not the product catalogue", function () {
			expect([...TENANT_TABLES].sort()).to.deep.equal([
				"applications",
				"intelligence_services",
				"secrets",
				"stt_services",
				"tts_services",
			]);
		});
	});
});
