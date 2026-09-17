import { expect } from "chai";
import { deriveSlug } from "../../src/auth/reseller/reseller.dto";
import { NotYourChildException } from "../../src/auth/reseller/reseller.errors";
import { assertChildOfReseller } from "../../src/auth/reseller/reseller.service";
import type { HierarchyRow } from "@optimiq-voice/db";

/**
 * The reseller surface's decision logic, without a database.
 *
 * Two things are load-bearing and neither needs a connection: the row check that keeps a reseller
 * inside its own subtree (`assertChildOfReseller`, the `assertMayAct` precedent), and the slug
 * derivation that must never collide with an existing organization.
 */

const RESELLER = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const CHILD = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";

function hierarchy(parentOrganizationId: string | null): HierarchyRow {
	return { organizationId: CHILD, parentOrganizationId, isReseller: false, suspendedAt: null };
}

describe("reseller row check", () => {
	it("allows a reseller to reach a child whose parent is itself", () => {
		expect(() => assertChildOfReseller(RESELLER, hierarchy(RESELLER))).to.not.throw();
	});

	it("refuses a child of a different reseller", () => {
		expect(() => assertChildOfReseller(RESELLER, hierarchy(OTHER))).to.throw(NotYourChildException);
	});

	it("refuses a top-level organization with no parent", () => {
		expect(() => assertChildOfReseller(RESELLER, hierarchy(null))).to.throw(NotYourChildException);
	});

	it("refuses an organization that has never been placed", () => {
		expect(() => assertChildOfReseller(RESELLER, null)).to.throw(NotYourChildException);
	});
});

describe("reseller slug derivation", () => {
	it("kebab-cases a display name and appends a disambiguating suffix", () => {
		const slug = deriveSlug("Acme Rockets, Inc.");
		expect(slug).to.match(/^acme-rockets-inc-[a-z0-9]{6}$/u);
	});

	it("never emits leading, trailing or doubled separators", () => {
		const slug = deriveSlug("  ***  ");
		expect(slug).to.match(/^org-[a-z0-9]{6}$/u);
	});

	it("produces a distinct slug on repeat calls for the same name", () => {
		expect(deriveSlug("Contoso")).to.not.equal(deriveSlug("Contoso"));
	});
});
