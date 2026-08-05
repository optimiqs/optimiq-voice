import { expect } from "chai";
import {
	API_KEY_HEADER,
	API_KEY_MEMBERSHIP_ROLE,
	API_KEY_PRINCIPAL_ROLE,
	createApiKeySessionResolver,
} from "../../src/auth/auth-http.plugin";
import type { AuthHttpRequest } from "../../src/auth/auth-http.plugin";
import type { AuthPlatform } from "../../src/auth/auth.platform";

/**
 * `x-api-key` → `AppSession` (identity-removal Step 3, item 1 — the recorded blocker).
 *
 * `@better-auth/api-key@1.6.23` refuses to promote a key into a session unless it references a
 * user, and `packages/auth` configures `references: "organization"` on purpose. The plan's
 * recommended option (a) — resolve the key explicitly and synthesise the session — is what these
 * cases pin.
 */

interface VerifyCall {
	readonly body: { readonly key: string };
}

function platformWith(verify: (input: VerifyCall) => Promise<unknown>): {
	platform: AuthPlatform;
	calls: VerifyCall[];
} {
	const calls: VerifyCall[] = [];
	const platform = {
		auth: {
			api: {
				verifyApiKey: async (input: VerifyCall) => {
					calls.push(input);
					return await verify(input);
				},
			},
		},
	} as unknown as AuthPlatform;
	return { platform, calls };
}

function request(headers: Record<string, string | string[] | undefined>): AuthHttpRequest {
	return { method: "GET", url: "/api/v1/me", headers };
}

const validKey = {
	valid: true,
	key: {
		id: "019fd3c2-0203-76be-a6b3-b0f1914e39b6",
		name: "WOlegacy-key",
		referenceId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6",
		expiresAt: null,
	},
};

describe("@auth/apiKeySession", function () {
	it("returns null when no key header is present", async function () {
		const { platform, calls } = platformWith(async () => validKey);
		const resolve = createApiKeySessionResolver(platform);

		expect(await resolve(request({}))).to.equal(null);
		expect(calls, "an absent header must not reach better-auth").to.have.lengthOf(0);
	});

	it("returns null for a blank key header", async function () {
		const { platform, calls } = platformWith(async () => validKey);
		const resolve = createApiKeySessionResolver(platform);

		expect(await resolve(request({ [API_KEY_HEADER]: "   " }))).to.equal(null);
		expect(calls).to.have.lengthOf(0);
	});

	it("scopes the session to the key's organization", async function () {
		const { platform, calls } = platformWith(async () => validKey);
		const resolve = createApiKeySessionResolver(platform);

		const session = await resolve(request({ [API_KEY_HEADER]: "ovk_secret" }));

		expect(calls[0]?.body.key).to.equal("ovk_secret");
		expect(session?.session.activeOrganizationId).to.equal(validKey.key.referenceId);
	});

	it("acts as admin, never as owner", async function () {
		// A programmatic credential must not be able to delete the organization that issued it.
		const { platform } = platformWith(async () => validKey);
		const session = await createApiKeySessionResolver(platform)(
			request({ [API_KEY_HEADER]: "ovk_secret" }),
		);

		expect(session?.activeOrganizationRole).to.equal(API_KEY_MEMBERSHIP_ROLE);
		expect(API_KEY_MEMBERSHIP_ROLE).to.not.equal("owner");
	});

	it("marks the principal so nothing mistakes it for a person", async function () {
		const { platform } = platformWith(async () => validKey);
		const session = await createApiKeySessionResolver(platform)(
			request({ [API_KEY_HEADER]: "ovk_secret" }),
		);

		expect(session?.user.role).to.equal(API_KEY_PRINCIPAL_ROLE);
		expect(session?.user.email).to.equal("");
		expect(session?.user.id).to.equal(validKey.key.id);
		expect(session?.session.token, "no session row is created for key traffic").to.equal("");
	});

	it("rejects an invalid key", async function () {
		const { platform } = platformWith(async () => ({ valid: false, key: null }));
		expect(
			await createApiKeySessionResolver(platform)(request({ [API_KEY_HEADER]: "nope" })),
		).to.equal(null);
	});

	it("refuses to guess a tenant when the key carries no referenceId", async function () {
		const { platform } = platformWith(async () => ({
			valid: true,
			key: { ...validKey.key, referenceId: "" },
		}));
		expect(
			await createApiKeySessionResolver(platform)(request({ [API_KEY_HEADER]: "ovk_secret" })),
		).to.equal(null);
	});

	it("honours the key's own expiry when it has one", async function () {
		const expiresAt = new Date(Date.UTC(2030, 0, 1));
		const { platform } = platformWith(async () => ({
			valid: true,
			key: { ...validKey.key, expiresAt },
		}));
		const session = await createApiKeySessionResolver(platform)(
			request({ [API_KEY_HEADER]: "ovk_secret" }),
		);
		expect(session?.session.expiresAt.toISOString()).to.equal(expiresAt.toISOString());
	});

	it("takes the first value of a repeated header", async function () {
		const { platform, calls } = platformWith(async () => validKey);
		await createApiKeySessionResolver(platform)(request({ [API_KEY_HEADER]: ["first", "second"] }));
		expect(calls[0]?.body.key).to.equal("first");
	});
});
