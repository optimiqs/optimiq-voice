import * as grpc from "@grpc/grpc-js";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import {
	findOrganizationIdInCall,
	getOrganizationIdFromCall,
	getTenantAccessKeyFromCall,
	MissingTenantScopeError,
	ORGANIZATION_METADATA_KEY,
	TENANT_ACCESS_KEY_METADATA_KEY,
} from "@optimiq-voice/common";
import {
	isOrganizationId,
	resolveTenantFromClaims,
	tenantCandidates,
	UnresolvableTenantError,
} from "../../src/core/createTenancyInterceptor";

chai.use(chaiAsPromised);

const ORGANIZATION_A = "019fd41e-e73c-73fc-8fa9-b5512fecd859";
const ORGANIZATION_B = "019fd41e-e73e-743d-96a7-1c42f48b4b29";
const LEGACY_A = "WOidentitymigrationfixturea";

const ledger: Record<string, string> = { [LEGACY_A]: ORGANIZATION_A };
const resolveLegacyAccessKey = async (accessKeyId: string) =>
	await Promise.resolve(ledger[accessKeyId] ?? null);

function callWith(entries: Record<string, string>) {
	const metadata = new grpc.Metadata();
	for (const [key, value] of Object.entries(entries)) {
		metadata.set(key, value);
	}
	return { metadata, request: {} };
}

describe("@core/tenancyInterceptor", function () {
	describe("tenantCandidates", function () {
		it("prefers the canonical organizationId claim", function () {
			expect(
				tenantCandidates({
					organizationId: ORGANIZATION_A,
					accessKeyId: LEGACY_A,
					access: [{ accessKeyId: "WOother" }],
				})[0],
			).to.equal(ORGANIZATION_A);
		});

		it("falls back to the accessKeyId slot Step 4 kept for shape compatibility", function () {
			expect(tenantCandidates({ accessKeyId: ORGANIZATION_A })).to.deep.equal([ORGANIZATION_A]);
		});

		it("reads the legacy access[] array the identity signer produced", function () {
			expect(
				tenantCandidates({ access: [{ accessKeyId: LEGACY_A }, { accessKeyId: "WOother" }] }),
			).to.deep.equal([LEGACY_A, "WOother"]);
		});

		it("de-duplicates so a repeated claim is not probed twice", function () {
			expect(
				tenantCandidates({ accessKeyId: LEGACY_A, access: [{ accessKeyId: LEGACY_A }] }),
			).to.deep.equal([LEGACY_A]);
		});

		it("returns nothing for a token that carries no tenant at all", function () {
			expect(tenantCandidates(null)).to.deep.equal([]);
			expect(tenantCandidates({})).to.deep.equal([]);
			expect(tenantCandidates({ accessKeyId: "   " })).to.deep.equal([]);
		});
	});

	describe("isOrganizationId", function () {
		it("accepts the uuid an organization id serialises to", function () {
			expect(isOrganizationId(ORGANIZATION_A)).to.be.true;
		});

		it("rejects a legacy workspace key", function () {
			expect(isOrganizationId(LEGACY_A)).to.be.false;
		});
	});

	describe("resolveTenantFromClaims", function () {
		it("uses an organization id claim without touching the ledger", async function () {
			let consulted = false;
			const organizationId = await resolveTenantFromClaims(
				{ organizationId: ORGANIZATION_A },
				{
					resolveLegacyAccessKey: async () => {
						consulted = true;
						return await Promise.resolve(null);
					},
				},
			);
			expect(organizationId).to.equal(ORGANIZATION_A);
			expect(consulted).to.be.false;
		});

		it("translates a legacy identity token through the Step 2 ledger", async function () {
			expect(
				await resolveTenantFromClaims(
					{ accessKeyId: "US14wj8q", access: [{ accessKeyId: LEGACY_A }] },
					{ resolveLegacyAccessKey },
				),
			).to.equal(ORGANIZATION_A);
		});

		it("normalises the case of an organization id claim", async function () {
			expect(
				await resolveTenantFromClaims(
					{ organizationId: ORGANIZATION_A.toUpperCase() },
					{ resolveLegacyAccessKey },
				),
			).to.equal(ORGANIZATION_A);
		});

		it("fails closed when nothing resolves, rather than serving unscoped", async function () {
			// The identity-era behaviour was `accessKeyId === undefined` passed straight into a
			// `where`, i.e. a cross-tenant read. There is deliberately no unscoped fallback.
			await expect(
				resolveTenantFromClaims(
					{ access: [{ accessKeyId: "WOnever-migrated" }] },
					{
						resolveLegacyAccessKey,
					},
				),
			).to.be.rejectedWith(UnresolvableTenantError);
		});

		it("fails closed for a call with no token at all", async function () {
			await expect(resolveTenantFromClaims(null, { resolveLegacyAccessKey })).to.be.rejectedWith(
				UnresolvableTenantError,
			);
		});
	});

	describe("reading the stamped tenant", function () {
		it("returns the organization the interceptor stamped", function () {
			const call = callWith({ [ORGANIZATION_METADATA_KEY]: ORGANIZATION_A });
			expect(getOrganizationIdFromCall(call)).to.equal(ORGANIZATION_A);
			expect(findOrganizationIdInCall(call)).to.equal(ORGANIZATION_A);
		});

		it("throws rather than returning undefined on an unscoped call", function () {
			// A tenant-scoped query built from `undefined` is how "list everything" bugs happen.
			expect(() => getOrganizationIdFromCall(callWith({}))).to.throw(MissingTenantScopeError);
			expect(findOrganizationIdInCall(callWith({}))).to.be.undefined;
		});

		it("ignores a blank stamp", function () {
			expect(() =>
				getOrganizationIdFromCall(callWith({ [ORGANIZATION_METADATA_KEY]: "   " })),
			).to.throw(MissingTenantScopeError);
		});

		it("returns the server-resolved legacy key for the Routr-facing consumers", function () {
			const call = callWith({
				[ORGANIZATION_METADATA_KEY]: ORGANIZATION_A,
				[TENANT_ACCESS_KEY_METADATA_KEY]: LEGACY_A,
			});
			expect(getTenantAccessKeyFromCall(call)).to.equal(LEGACY_A);
		});

		it("converges on the organization id for a tenant that never had a legacy key", function () {
			const call = callWith({
				[ORGANIZATION_METADATA_KEY]: ORGANIZATION_B,
				[TENANT_ACCESS_KEY_METADATA_KEY]: ORGANIZATION_B,
			});
			expect(getTenantAccessKeyFromCall(call)).to.equal(ORGANIZATION_B);
		});

		it("throws when the legacy key was never stamped", function () {
			expect(() => getTenantAccessKeyFromCall(callWith({}))).to.throw(MissingTenantScopeError);
		});
	});
});
