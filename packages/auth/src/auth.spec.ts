import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	type AuthEmailDelivery,
	createAuth,
	ORGANIZATION_MEMBERSHIP_ROLES,
	SESSION_COOKIE_CACHE_VERSION,
} from "./auth";
import { authSchema } from "./schema";

/**
 * Composition smoke test. `postgres.js` connects lazily, so building the auth instance exercises
 * plugin registration and option validation without any database being reachable.
 */
const email: AuthEmailDelivery = {
	sendVerification: () => Promise.resolve(),
	sendReset: () => Promise.resolve(),
	sendInvite: () => Promise.resolve(),
};

function buildAuth() {
	const client = postgres("postgresql://auth:auth@127.0.0.1:1/optimiq_voice_spec", { max: 1 });
	return createAuth({
		database: drizzle({ client }),
		secret: "spec-secret-spec-secret-spec-secret",
		baseURL: "https://api.optimiq.example",
		appURL: "https://app.optimiq.example",
		email,
		trustedOrigins: ["https://app.optimiq.example"],
	});
}

describe("createAuth", () => {
	const auth = buildAuth();
	const endpoints = Object.keys(auth.api);

	it("registers the organization plugin as the tenant model", () => {
		for (const endpoint of [
			"createOrganization",
			"setActiveOrganization",
			"createInvitation",
			"acceptInvitation",
			"removeMember",
		]) {
			expect(endpoints).toContain(endpoint);
		}
	});

	it("registers organization-scoped API keys", () => {
		expect(endpoints).toContain("createApiKey");
		expect(endpoints).toContain("verifyApiKey");
		expect(endpoints).toContain("deleteApiKey");
	});

	it("registers the platform admin surface", () => {
		expect(endpoints).toContain("listUsers");
		expect(endpoints).toContain("banUser");
		expect(endpoints).toContain("impersonateUser");
	});

	it("registers two-factor enrolment", () => {
		expect(endpoints).toContain("enableTwoFactor");
		expect(endpoints).toContain("verifyTOTP");
	});

	it("publishes JWKS so service and per-call tokens can be verified offline", () => {
		expect(endpoints).toContain("getJwks");
		expect(endpoints).toContain("getToken");
	});

	it("exposes the auth OpenAPI document by default", () => {
		expect(endpoints).toContain("generateOpenAPISchema");
	});

	it("keeps email delivery injectable rather than bound to a transport", () => {
		expect(auth.options.emailAndPassword?.sendResetPassword).toBeFunction();
		expect(auth.options.emailVerification?.sendVerificationEmail).toBeFunction();
	});

	it("generates UUID v7 identifiers for every better-auth row", () => {
		const generateId = auth.options.advanced?.database?.generateId;
		expect(generateId).toBeFunction();
		const id = (generateId as () => string)();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
	});

	it("namespaces cookies with the cache version so a bump invalidates every session", () => {
		expect(auth.options.advanced?.cookiePrefix).toContain(SESSION_COOKIE_CACHE_VERSION);
	});

	it("uses the shared Drizzle auth schema", () => {
		expect(Object.keys(authSchema)).toContain("organization");
		expect(Object.keys(authSchema)).toContain("apikey");
	});

	it("documents the better-auth membership roles our templates map onto", () => {
		expect([...ORGANIZATION_MEMBERSHIP_ROLES]).toEqual(["owner", "admin", "member"]);
	});
});
