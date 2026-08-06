import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	type AuthEmailDelivery,
	createAuth,
	ORGANIZATION_MEMBERSHIP_ROLES,
	SESSION_COOKIE_CACHE_VERSION,
} from "./auth";
import { SYSTEM_ROLE_IDS } from "./permissions";
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

function buildAuth(overrides: Partial<Parameters<typeof createAuth>[0]> = {}) {
	const client = postgres("postgresql://auth:auth@127.0.0.1:1/optimiq_voice_spec", { max: 1 });
	return createAuth({
		database: drizzle({ client }),
		secret: "spec-secret-spec-secret-spec-secret",
		baseURL: "https://api.optimiq.example",
		appURL: "https://app.optimiq.example",
		email,
		trustedOrigins: ["https://app.optimiq.example"],
		...overrides,
	});
}

/** The composed plugin object keeps the options it was constructed with. */
function organizationPluginOptions(auth: ReturnType<typeof createAuth>): {
	ac?: unknown;
	roles?: Record<string, unknown>;
	creatorRole?: string;
} {
	const plugins = auth.options.plugins as { id: string; options?: unknown }[];
	const plugin = plugins.find((candidate) => candidate.id === "organization");
	return (plugin?.options ?? {}) as {
		ac?: unknown;
		roles?: Record<string, unknown>;
		creatorRole?: string;
	};
}

/** The two-factor plugin's options, as composed. */
function twoFactorPluginOptions(auth: ReturnType<typeof createAuth>): {
	otpOptions?: {
		sendOTP?: (data: {
			user: { id: string; email?: string; name?: string };
			otp: string;
		}) => unknown;
	};
} {
	const plugins = auth.options.plugins as { id: string; options?: unknown }[];
	const plugin = plugins.find((candidate) => candidate.id === "two-factor");
	return (plugin?.options ?? {}) as {
		otpOptions?: {
			sendOTP?: (data: {
				user: { id: string; email?: string; name?: string };
				otp: string;
			}) => unknown;
		};
	};
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

	it("wires the two-factor OTP sender onto the plugin's own option name", () => {
		// `otpOptions.sendOTP` is what better-auth 1.6 reads; anything else composes silently and
		// mints codes nobody receives.
		const withOtp = buildAuth({
			email: { ...email, sendTwoFactorOtp: () => Promise.resolve() },
		});
		expect(twoFactorPluginOptions(withOtp).otpOptions?.sendOTP).toBeFunction();
		expect(Object.keys(withOtp.api)).toContain("sendTwoFactorOTP");
	});

	it("omits the OTP adapter when the host has no way to deliver a code", () => {
		// Registering it anyway would make POST /two-factor/send-otp answer 200 for a code that
		// went nowhere, which is worse than the endpoint not existing.
		expect(twoFactorPluginOptions(auth).otpOptions).toBeUndefined();
	});

	it("hands the sender the user's id, address and name", async () => {
		const seen: { id?: string; email?: string; otp?: string }[] = [];
		const withOtp = buildAuth({
			email: {
				...email,
				sendTwoFactorOtp: async ({ user, otp }) => {
					seen.push({ id: user.id, email: user.email, otp });
				},
			},
		});
		const sendOTP = twoFactorPluginOptions(withOtp).otpOptions?.sendOTP;
		await sendOTP?.({ user: { id: "u1", email: "a@b.test", name: "A" }, otp: "123456" });
		expect(seen).toEqual([{ id: "u1", email: "a@b.test", otp: "123456" }]);
	});

	it("sends nothing for a user with no address rather than inventing a recipient", async () => {
		let called = 0;
		const withOtp = buildAuth({
			email: {
				...email,
				sendTwoFactorOtp: async () => {
					called += 1;
				},
			},
		});
		const sendOTP = twoFactorPluginOptions(withOtp).otpOptions?.sendOTP;
		await sendOTP?.({ user: { id: "u1" }, otp: "123456" });
		expect(called).toBe(0);
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

	it("registers the system role templates with the organization plugin by default", () => {
		const options = organizationPluginOptions(auth);
		expect(options.ac).toBeDefined();
		for (const id of SYSTEM_ROLE_IDS) {
			expect(Object.keys(options.roles ?? {})).toContain(id);
		}
	});

	it("keeps better-auth's own roles alongside them, so invitations keep working", () => {
		const roles = Object.keys(organizationPluginOptions(auth).roles ?? {});
		for (const id of ORGANIZATION_MEMBERSHIP_ROLES) {
			expect(roles).toContain(id);
		}
	});

	it("creates organizations with an owner", () => {
		expect(organizationPluginOptions(auth).creatorRole).toBe("owner");
	});

	it("lets the creator role be overridden without losing the access control", () => {
		const custom = buildAuth({ organizationRoles: { creatorRole: "admin" } });
		const options = organizationPluginOptions(custom);
		expect(options.creatorRole).toBe("admin");
		expect(options.ac).toBeDefined();
	});

	it("falls back to better-auth's three built-in roles when opted out", () => {
		const plain = buildAuth({ organizationRoles: false });
		const options = organizationPluginOptions(plain);
		expect(options.ac).toBeUndefined();
		expect(options.roles).toBeUndefined();
		expect(options.creatorRole).toBe("owner");
	});
});
