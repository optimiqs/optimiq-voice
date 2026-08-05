/**
 * End-to-end verification of the better-auth slice (identity-removal Step 1 gate).
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *     pnpm --filter @optimiq-voice/api verify:auth
 *
 * It boots a real Nest + Fastify application on an ephemeral port against a real PostgreSQL and
 * walks the whole flow: sign up → session cookie → create organization → `GET /api/v1/me` →
 * invite + accept → permission guard 403/200 → anonymous 401.
 *
 * The root module is `createApiRootModule([])` — the auth slice ALONE. `AppModule` is excluded
 * on purpose: its `RuntimeHostService` starts the gRPC servers, the ARI client, the NATS
 * subscription and the InfluxDB writer on `onApplicationBootstrap`, none of which this gate is
 * about and none of which are available on a developer machine.
 */

import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const TEST_SECRET = "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

async function findFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "string" || address === null) {
				server.close();
				reject(new Error("could not allocate an ephemeral port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

// ---------------------------------------------------------------------------------------------
// Assertions and a tiny cookie-aware HTTP client
// ---------------------------------------------------------------------------------------------

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
	checks.push({ name, ok, detail });
	const marker = ok ? "PASS" : "FAIL";
	console.log(`  [${marker}] ${name}${detail ? ` — ${detail}` : ""}`);
}

class CookieJar {
	private readonly cookies = new Map<string, string>();

	absorb(response: Response): void {
		for (const raw of response.headers.getSetCookie()) {
			const [pair] = raw.split(";");
			if (!pair) continue;
			const separator = pair.indexOf("=");
			if (separator === -1) continue;
			this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
		}
	}

	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

interface JsonResponse {
	readonly status: number;
	readonly body: unknown;
}

async function request(
	baseUrl: string,
	method: string,
	path: string,
	options: { jar?: CookieJar; body?: unknown } = {},
): Promise<JsonResponse> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const cookieHeader = options.jar?.header();
	if (cookieHeader) {
		headers.cookie = cookieHeader;
	}

	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	options.jar?.absorb(response);

	const text = await response.text();
	let body: unknown = text;
	try {
		body = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		// Non-JSON responses are reported verbatim.
	}
	return { status: response.status, body };
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	// @optimiq-voice/config parses the environment at import time, so it must be complete before
	// anything that imports it is loaded. Every import below is therefore dynamic.
	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } =
		await import("../src/auth/auth-bootstrap.mjs");
	const { createPostgresClient } = await import("@optimiq-voice/db");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-auth-slice",
		poolMaxConnectionsOverride: 2,
	});

	console.log(`\nbooting the auth slice on ${baseUrl}\n`);
	const app = await NestFactory.create(createApiRootModule([]), new FastifyAdapter(), {
		logger: ["error", "warn"],
	});
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(100);

	const ownerEmail = `owner-${RUN_ID}@verify.optimiq.test`;
	const memberEmail = `member-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Auth-Slice-2026!";
	const ownerJar = new CookieJar();
	const memberJar = new CookieJar();
	let organizationId = "";

	try {
		// --- 1. sign up -----------------------------------------------------------------------
		console.log("1. sign-up via /api/auth/sign-up/email");
		const signUp = await request(baseUrl, "POST", "/api/auth/sign-up/email", {
			jar: ownerJar,
			body: { name: "Verify Owner", email: ownerEmail, password },
		});
		check("sign-up returns 200", signUp.status === 200, `status ${signUp.status}`);
		check(
			"sign-up sets a session cookie",
			ownerJar.header().length > 0,
			ownerJar.header().slice(0, 40),
		);

		// --- 2. /me before any organization ----------------------------------------------------
		console.log("2. GET /api/v1/me before an organization exists");
		const meBefore = await request(baseUrl, "GET", "/api/v1/me", { jar: ownerJar });
		check(
			"me returns 200 for a session with no organization",
			meBefore.status === 200,
			`status ${meBefore.status}`,
		);
		check(
			"me reports the signed-up user",
			asString(field(field(meBefore.body, "user"), "email")) === ownerEmail,
			asString(field(field(meBefore.body, "user"), "email")),
		);
		check(
			"activeOrganization is null before joining one",
			field(meBefore.body, "activeOrganization") === null,
		);

		// --- 3. create an organization ----------------------------------------------------------
		console.log("3. POST /api/auth/organization/create");
		const createOrganization = await request(baseUrl, "POST", "/api/auth/organization/create", {
			jar: ownerJar,
			body: { name: `Verify Org ${RUN_ID}`, slug: `verify-org-${RUN_ID}` },
		});
		organizationId = asString(field(createOrganization.body, "id"));
		check(
			"organization created",
			createOrganization.status === 200 && organizationId.length > 0,
			`status ${createOrganization.status} id ${organizationId}`,
		);

		await request(baseUrl, "POST", "/api/auth/organization/set-active", {
			jar: ownerJar,
			body: { organizationId },
		});

		// --- 4. /me with an active organization -------------------------------------------------
		console.log("4. GET /api/v1/me with an active organization");
		const meOwner = await request(baseUrl, "GET", "/api/v1/me", { jar: ownerJar });
		const ownerPermissions = asStringArray(field(meOwner.body, "permissions"));
		check("me returns 200", meOwner.status === 200, `status ${meOwner.status}`);
		check(
			"me carries the active organization",
			asString(field(field(meOwner.body, "activeOrganization"), "id")) === organizationId,
		);
		check(
			"me reports the owner role",
			asString(field(meOwner.body, "role")) === "owner",
			asString(field(meOwner.body, "role")),
		);
		check(
			"owner permissions include members.read",
			ownerPermissions.includes("members.read"),
			`${ownerPermissions.length} permissions`,
		);
		check("owner permissions include secrets.read", ownerPermissions.includes("secrets.read"));

		// --- 5. GET /api/v1/organizations --------------------------------------------------------
		console.log("5. GET /api/v1/organizations");
		const organizations = await request(baseUrl, "GET", "/api/v1/organizations", { jar: ownerJar });
		const organizationList = Array.isArray(field(organizations.body, "data"))
			? (field(organizations.body, "data") as unknown[])
			: [];
		check(
			"organizations returns 200",
			organizations.status === 200,
			`status ${organizations.status}`,
		);
		check(
			"the new organization is listed with role owner",
			organizationList.some(
				(entry) =>
					asString(field(entry, "id")) === organizationId &&
					asString(field(entry, "role")) === "owner",
			),
			`${organizationList.length} organization(s)`,
		);

		// --- 6. guard: 200 for the owner ----------------------------------------------------------
		console.log("6. guard — owner reads members (requires members.read)");
		const ownerMembers = await request(
			baseUrl,
			"GET",
			`/api/v1/organizations/${organizationId}/members`,
			{
				jar: ownerJar,
			},
		);
		check(
			"owner gets 200 on a members.read route",
			ownerMembers.status === 200,
			`status ${ownerMembers.status}`,
		);

		// --- 7. a second user joins as a plain member ---------------------------------------------
		console.log("7. invite a second user and accept as that user");
		const memberSignUp = await request(baseUrl, "POST", "/api/auth/sign-up/email", {
			jar: memberJar,
			body: { name: "Verify Member", email: memberEmail, password },
		});
		check(
			"member sign-up returns 200",
			memberSignUp.status === 200,
			`status ${memberSignUp.status}`,
		);

		// The invitation flow requires a verified invitee (requireEmailVerificationOnInvitation).
		// Email delivery is still a console stub, so the click-through is simulated here; the
		// session cookie cache has to be refreshed afterwards, hence the re-sign-in.
		await sql`update "user" set "email_verified" = true where "email" = ${memberEmail}`;
		await request(baseUrl, "POST", "/api/auth/sign-in/email", {
			jar: memberJar,
			body: { email: memberEmail, password },
		});

		const invite = await request(baseUrl, "POST", "/api/auth/organization/invite-member", {
			jar: ownerJar,
			body: { email: memberEmail, role: "member", organizationId },
		});
		const invitationId = asString(field(invite.body, "id"));
		check(
			"invitation created",
			invite.status === 200 && invitationId.length > 0,
			`status ${invite.status}`,
		);

		const accept = await request(baseUrl, "POST", "/api/auth/organization/accept-invitation", {
			jar: memberJar,
			body: { invitationId },
		});
		check(
			"invitation accepted",
			accept.status === 200,
			`status ${accept.status} ${accept.status === 200 ? "" : JSON.stringify(accept.body)}`,
		);

		// A fresh sign-in proves the session-create hook stamps activeOrganizationId from the
		// membership row rather than from anything the client sent.
		const memberSignIn = await request(baseUrl, "POST", "/api/auth/sign-in/email", {
			jar: memberJar,
			body: { email: memberEmail, password },
		});
		check("member signed in again", memberSignIn.status === 200, `status ${memberSignIn.status}`);

		const meMember = await request(baseUrl, "GET", "/api/v1/me", { jar: memberJar });
		const memberPermissions = asStringArray(field(meMember.body, "permissions"));
		check("member me returns 200", meMember.status === 200, `status ${meMember.status}`);
		check(
			"session hook stamped the active organization",
			asString(field(field(meMember.body, "activeOrganization"), "id")) === organizationId,
		);
		check(
			"member role is member",
			asString(field(meMember.body, "role")) === "member",
			asString(field(meMember.body, "role")),
		);
		check(
			"member permissions exclude members.read",
			!memberPermissions.includes("members.read"),
			`${memberPermissions.length} permissions`,
		);
		check("member permissions include settings.read", memberPermissions.includes("settings.read"));

		// --- 8. guard: 403 for the member ---------------------------------------------------------
		console.log("8. guard — member is refused the members.read route");
		const memberMembers = await request(
			baseUrl,
			"GET",
			`/api/v1/organizations/${organizationId}/members`,
			{
				jar: memberJar,
			},
		);
		check("member gets 403", memberMembers.status === 403, `status ${memberMembers.status}`);

		// --- 9. anonymous ---------------------------------------------------------------------------
		console.log("9. guard — anonymous requests");
		const anonymous = await request(baseUrl, "GET", "/api/v1/me");
		check("anonymous gets 401", anonymous.status === 401, `status ${anonymous.status}`);

		// --- 10. the auth surface itself ------------------------------------------------------------
		console.log("10. better-auth surface");
		const jwks = await request(baseUrl, "GET", "/api/auth/jwks");
		check("/api/auth/jwks is served", jwks.status === 200, `status ${jwks.status}`);
	} finally {
		console.log("\ncleaning up");
		try {
			if (organizationId) {
				await sql`delete from "organization" where "id" = ${organizationId}`;
			}
			await sql`delete from "user" where "email" in (${ownerEmail}, ${memberEmail})`;
		} catch (error) {
			console.error("cleanup failed", error);
		}
		await sql.end({ timeout: 5 });
		await app.close();
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("auth slice verification PASSED");
}

await main();
