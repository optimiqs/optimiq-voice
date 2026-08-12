import { expect } from "chai";
import {
	DEFAULT_BRANDING,
	resolveEffectiveBranding,
} from "../../src/auth/branding/branding.resolver";
import type { BrandingRow } from "@optimiq-voice/db";

/**
 * The theme cascade, without a database.
 *
 * The resolution order is `code default → reseller default → org override`, and the one field that
 * must NOT cascade is the custom domain — a host belongs to exactly one organization, so a child
 * never inherits its reseller's domain, and the resolved shape does not carry it at all.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const RESELLER = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

function row(organizationId: string, patch: Partial<BrandingRow>): BrandingRow {
	return {
		organizationId,
		productName: null,
		logoObjectKey: null,
		primaryColor: null,
		accentColor: null,
		supportEmail: null,
		customDomain: null,
		defaultLanguage: null,
		...patch,
	};
}

describe("branding theme cascade", () => {
	it("falls back to the code default when nothing is set", () => {
		expect(resolveEffectiveBranding(null, null)).to.deep.equal(DEFAULT_BRANDING);
	});

	it("lets an org override win over the reseller default and the code default", () => {
		const effective = resolveEffectiveBranding(
			row(ORG, { productName: "Child Co", primaryColor: "#010203" }),
			row(RESELLER, {
				productName: "Reseller Co",
				primaryColor: "#0a0b0c",
				accentColor: "#ffffff",
			}),
		);
		expect(effective.productName).to.equal("Child Co");
		expect(effective.primaryColor).to.equal("#010203");
		// Inherited from the reseller default where the child set nothing:
		expect(effective.accentColor).to.equal("#ffffff");
	});

	it("inherits the reseller default where the org set nothing", () => {
		const effective = resolveEffectiveBranding(
			null,
			row(RESELLER, { productName: "Reseller Co", logoObjectKey: "brand/reseller.png" }),
		);
		expect(effective.productName).to.equal("Reseller Co");
		expect(effective.logoObjectKey).to.equal("brand/reseller.png");
		// Code default fills where neither level set it:
		expect(effective.accentColor).to.equal(DEFAULT_BRANDING.accentColor);
	});

	it("leaves nullable fields null rather than inventing a value", () => {
		const effective = resolveEffectiveBranding(null, null);
		expect(effective.logoObjectKey).to.equal(null);
		expect(effective.supportEmail).to.equal(null);
	});

	it("never emits the custom domain in the resolved shape", () => {
		const effective = resolveEffectiveBranding(
			row(ORG, { customDomain: "voice.child.example" }),
			row(RESELLER, { customDomain: "voice.reseller.example" }),
		);
		expect(Object.keys(effective)).to.not.include("customDomain");
	});
});
