import { expect } from "chai";
import { assertSsoProviderOrganization } from "@optimiq-voice/auth";
import { createSsoProviderDto, updateSsoProviderDto } from "../../src/auth/sso/sso.dto";
import type { SsoProviderConfig } from "@optimiq-voice/auth";

/**
 * Per-organization OIDC providers, and the two things that keep one tenant's IdP inside one tenant.
 *
 * A provider row is self-service: any org admin holding `sso.configure` can point one at an IdP
 * they control. `genericOAuth` then links the identity it asserts by EMAIL, and the session's
 * `activeOrganizationId` is resolved from the matched user's own membership — so without a check
 * tied to the provider, tenant A's IdP can mint a session in tenant B by asserting a B address.
 *
 *  - `emailDomain` bounds which addresses a provider may assert at all. It is required at create
 *    and can never be nulled, and a row without one may not be flipped to `enabled` — because
 *    `packages/auth` drops such a row at boot, and a feature that renders as on and is off is worse
 *    than a refused write.
 *  - `assertSsoProviderOrganization` is the callback-time half: the tenant the session landed in has
 *    to be the tenant that registered the provider.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

const VALID = {
	providerId: "okta",
	issuer: "https://idp.example.test",
	clientId: "client",
	clientSecret: "secret",
	emailDomain: "acme.test",
};

function providerIn(organizationId: string): SsoProviderConfig {
	return {
		providerId: "okta",
		organizationId,
		clientId: "client",
		clientSecret: "secret",
		issuer: "https://idp.example.test",
		emailDomain: "acme.test",
	};
}

describe("the SSO provider write bodies", () => {
	it("demands an email domain at create, and will not accept a null one", () => {
		expect(createSsoProviderDto.safeParse(VALID).success).to.equal(true);
		const { emailDomain: _omitted, ...withoutDomain } = VALID;
		expect(createSsoProviderDto.safeParse(withoutDomain).success).to.equal(false);
		expect(createSsoProviderDto.safeParse({ ...VALID, emailDomain: null }).success).to.equal(false);
	});

	it("lets a PATCH leave the domain alone but never clear it", () => {
		expect(updateSsoProviderDto.safeParse({ enabled: false }).success).to.equal(true);
		expect(updateSsoProviderDto.safeParse({ emailDomain: "acme.test" }).success).to.equal(true);
		expect(updateSsoProviderDto.safeParse({ emailDomain: null }).success).to.equal(false);
	});
});

describe("the SSO callback's tenant assertion", () => {
	it("accepts a session in the organization that registered the provider", () => {
		expect(() => {
			assertSsoProviderOrganization({
				providers: [providerIn(ORG)],
				providerId: "okta",
				organizationId: ORG,
			});
		}).to.not.throw();
	});

	it("refuses a session that landed in another tenant than the provider's owner", () => {
		expect(() => {
			assertSsoProviderOrganization({
				providers: [providerIn(ORG)],
				providerId: "okta",
				organizationId: OTHER_ORG,
			});
		}).to.throw(/another organization/u);
	});

	it("refuses a session with no active organization at all", () => {
		expect(() => {
			assertSsoProviderOrganization({
				providers: [providerIn(ORG)],
				providerId: "okta",
				organizationId: null,
			});
		}).to.throw();
	});

	it("refuses a slug that is not registered, rather than letting it through unchecked", () => {
		expect(() => {
			assertSsoProviderOrganization({
				providers: [providerIn(ORG)],
				providerId: "not-registered",
				organizationId: ORG,
			});
		}).to.throw(/not a registered provider/u);
	});
});
