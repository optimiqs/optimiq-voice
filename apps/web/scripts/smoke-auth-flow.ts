/**
 * End-to-end smoke for the P4 frontend foundation.
 *
 *   pnpm --filter @optimiq-voice/web build
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *     pnpm --filter @optimiq-voice/web smoke
 *
 * Boots the real better-auth slice from `apps/api` on one ephemeral port (the same way
 * `apps/api/scripts/verify-auth-slice.ts` does), starts a Next dev server on another, and then
 * drives the whole flow THROUGH NEXT — never against the API directly.
 *
 * That distinction is the point. Everything this proves is a property of the frontend and would
 * still pass against the API if the frontend were broken:
 *
 *   · the `/api/*` rewrite in `next.config.mjs` actually reaches `apps/api`
 *   · the better-auth session cookie is set on, and replayed to, the NEXT origin — first-party,
 *     no CORS, no `SameSite=None`
 *   · `proxy.ts` finds that cookie by the prefix `lib/auth-constants.ts` declares, and redirects
 *     signed-out and signed-in visitors correctly
 *   · every route the app router claims to serve actually renders
 *   · the five role templates registered in `packages/auth` are assignable through an invitation
 *
 * Playwright is not set up in this repository, so this is fetch-level: it verifies wiring and
 * server-rendered HTML, not clicks.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PERMISSIONS as GENERATED_PERMISSIONS } from "../lib/permissions.generated";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";

/**
 * The secret is shared with `apps/api/scripts/verify-auth-slice.ts`, and that is not incidental.
 *
 * The jwt plugin stores its JWKS private key in the database ENCRYPTED WITH `AUTH_SECRET`. Boot
 * the slice against the same dev database under a different secret and `auth.api.getSession`
 * throws `Failed to decrypt private key` — the Fastify session hook catches it, resolves the
 * caller as anonymous, and every `/api/v1/*` route answers 401 while `/api/auth/*` keeps working.
 * That failure looks exactly like a broken frontend and is not one.
 *
 * So: any tool that boots the auth slice against a shared database must agree on the secret.
 * `AUTH_SECRET` from the environment wins when set, which is what a real deployment does.
 */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);
const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
	checks.push({ name, ok, detail });
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

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

/** A cookie jar scoped to one origin, so "the cookie came back to Next" is actually tested. */
class CookieJar {
	private readonly cookies = new Map<string, string>();

	absorb(response: Response): void {
		for (const raw of response.headers.getSetCookie()) {
			const [pair] = raw.split(";");
			if (!pair) {
				continue;
			}
			const separator = pair.indexOf("=");
			if (separator === -1) {
				continue;
			}
			this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
		}
	}

	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}

	names(): string[] {
		return [...this.cookies.keys()];
	}
}

interface JsonResponse {
	readonly status: number;
	readonly body: unknown;
}

async function api(
	baseUrl: string,
	method: string,
	path: string,
	options: { jar?: CookieJar; body?: unknown } = {},
): Promise<JsonResponse> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const cookie = options.jar?.header();
	if (cookie) {
		headers.cookie = cookie;
	}

	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		redirect: "manual",
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

async function page(
	baseUrl: string,
	path: string,
	jar?: CookieJar,
): Promise<{ status: number; location: string | null; html: string }> {
	const headers: Record<string, string> = { accept: "text/html" };
	const cookie = jar?.header();
	if (cookie) {
		headers.cookie = cookie;
	}
	const response = await fetch(`${baseUrl}${path}`, { headers, redirect: "manual" });
	return {
		status: response.status,
		location: response.headers.get("location"),
		html: await response.text(),
	};
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(`${baseUrl}/sign-in`, { redirect: "manual" });
			return true;
		} catch {
			await delay(250);
		}
	}
	return false;
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const apiPort = await findFreePort();
	const webPort = await findFreePort();
	const apiUrl = `http://127.0.0.1:${apiPort}`;
	const webUrl = `http://127.0.0.1:${webPort}`;

	/**
	 * The auth slice runs as its OWN process, rooted at `apps/api`.
	 *
	 * It cannot be imported from here: `@nestjs/core` and the rest of the API's dependencies do not
	 * resolve from `apps/web`, and adding them just to run a smoke test would put the whole backend
	 * in the frontend's dependency graph. `node -e` resolves bare specifiers against its working
	 * directory, so running it with `cwd: apps/api` gives the boot code the API's own resolution —
	 * and a separate process is closer to how this actually runs anyway.
	 *
	 * `@optimiq-voice/config` parses the environment at import time, so it must be complete before
	 * anything that imports it loads; every import inside the boot code is therefore dynamic.
	 */
	const apiRoot = join(dirname(WEB_ROOT), "api");
	const bootCode = `
		await import("reflect-metadata");
		const { NestFactory } = await import("@nestjs/core");
		const { FastifyAdapter } = await import("@nestjs/platform-fastify");
		const { createApiRootModule, registerAuthTransport } = await import(
			"./src/auth/auth-bootstrap.ts"
		);
		const app = await NestFactory.create(createApiRootModule([]), new FastifyAdapter(), {
			logger: ["error"],
		});
		app.enableShutdownHooks();
		await registerAuthTransport(app);
		await app.listen(${apiPort}, "127.0.0.1");
		console.log("AUTH_SLICE_READY");
	`;

	console.log(`booting the auth slice on ${apiUrl}`);
	const apiEnv: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: "test",
		DATABASE_URL: databaseUrl,
		AUTH_SECRET: TEST_SECRET,
		AUTH_URL: apiUrl,
		// Invitation links must point at the WEB app — this is what puts the frontend's own
		// /accept-invitation/<id> route into the email the server sends.
		API_APP_URL: webUrl,
	};

	const apiProcess: ChildProcess = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", bootCode],
		{ cwd: apiRoot, env: apiEnv, stdio: ["ignore", "pipe", "pipe"] },
	);
	apiProcess.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) {
			console.error(`  [api] ${text}`);
		}
	});

	let next: ChildProcess | null = null;

	try {
		const apiReady = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 90_000);
			apiProcess.stdout?.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("AUTH_SLICE_READY")) {
					clearTimeout(timer);
					resolve(true);
				}
			});
			apiProcess.on("exit", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
		if (!apiReady) {
			throw new Error("the auth slice did not start (is Postgres reachable on :5433?)");
		}

		/**
		 * `next dev`, not `next start`.
		 *
		 * Rewrite destinations are resolved when `rewrites()` runs and are then baked into
		 * `.next/routes-manifest.json` — `next start` never calls the function again. So a
		 * production server proxies to whatever `API_PROXY_ORIGIN` was set to AT BUILD TIME, and a
		 * smoke on an ephemeral port cannot use it. `next dev` evaluates the config on boot, which
		 * is also the flow a developer actually runs.
		 */
		console.log(`starting the Next dev server on ${webUrl}\n`);
		next = spawn(
			join(WEB_ROOT, "node_modules/.bin/next"),
			["dev", "--port", String(webPort), "--hostname", "127.0.0.1"],
			{
				cwd: WEB_ROOT,
				env: { ...process.env, API_PROXY_ORIGIN: apiUrl, NODE_ENV: "development" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		next.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) {
				console.error(`  [next] ${text}`);
			}
		});

		if (!(await waitForServer(webUrl, 120_000))) {
			throw new Error("the Next server did not become reachable");
		}

		const ownerEmail = `owner-${RUN_ID}@smoke.optimiq.test`;
		const inviteEmail = `member-${RUN_ID}@smoke.optimiq.test`;
		const password = "Smoke-Auth-Flow-2026!";
		const jar = new CookieJar();

		// --- 1. the public surface renders ------------------------------------------------------
		console.log("1. public routes render through Next");
		const signIn = await page(webUrl, "/sign-in");
		check("GET /sign-in returns 200", signIn.status === 200, `status ${signIn.status}`);
		check("sign-in HTML carries the form", signIn.html.includes("Sign in"));
		const signUpPage = await page(webUrl, "/sign-up");
		check("GET /sign-up returns 200", signUpPage.status === 200, `status ${signUpPage.status}`);

		// --- 2. proxy.ts guards the app for an anonymous visitor --------------------------------
		console.log("2. proxy.ts redirects an anonymous visitor");
		const guarded = await page(webUrl, "/extensions");
		check(
			"GET /extensions redirects when there is no session cookie",
			guarded.status === 307 || guarded.status === 302,
			`status ${guarded.status}`,
		);
		check(
			"the redirect preserves where they were going",
			(guarded.location ?? "").includes("/sign-in") &&
				(guarded.location ?? "").includes("redirectTo"),
			guarded.location ?? "(none)",
		);

		// --- 3. sign up through the Next rewrite -------------------------------------------------
		console.log("3. sign-up through /api/auth/* on the Next origin");
		const signUp = await api(webUrl, "POST", "/api/auth/sign-up/email", {
			jar,
			body: { name: "Smoke Owner", email: ownerEmail, password },
		});
		check("sign-up returns 200 via the rewrite", signUp.status === 200, `status ${signUp.status}`);
		check(
			"the session cookie is set on the Next origin",
			jar.names().some((name) => name.startsWith("optimiq_voice_session-v1")),
			jar.names().join(", ") || "(none)",
		);

		// --- 4. the proxy now recognizes the session --------------------------------------------
		console.log("4. proxy.ts recognizes the session cookie");
		const afterSignIn = await page(webUrl, "/sign-in", jar);
		check(
			"a signed-in visitor is redirected away from /sign-in",
			(afterSignIn.status === 307 || afterSignIn.status === 302) &&
				afterSignIn.location?.endsWith("/") === true,
			`status ${afterSignIn.status} → ${afterSignIn.location ?? "(none)"}`,
		);
		const shell = await page(webUrl, "/extensions", jar);
		check("the app shell is served with a session", shell.status === 200, `status ${shell.status}`);

		// --- 5. /api/v1/me through the rewrite ---------------------------------------------------
		console.log("5. GET /api/v1/me through the rewrite");
		const meBefore = await api(webUrl, "GET", "/api/v1/me", { jar });
		check("me returns 200", meBefore.status === 200, `status ${meBefore.status}`);
		check(
			"me reports the signed-up user",
			asString(field(field(meBefore.body, "user"), "email")) === ownerEmail,
		);
		check(
			"activeOrganization is null before one exists",
			field(meBefore.body, "activeOrganization") === null,
		);

		// --- 6. create an organization -----------------------------------------------------------
		console.log("6. create an organization and make it active");
		const created = await api(webUrl, "POST", "/api/auth/organization/create", {
			jar,
			body: { name: `Smoke Org ${RUN_ID}`, slug: `smoke-org-${RUN_ID}` },
		});
		const organizationId = asString(field(created.body, "id"));
		check(
			"organization created",
			created.status === 200 && organizationId.length > 0,
			`status ${created.status}`,
		);
		await api(webUrl, "POST", "/api/auth/organization/set-active", {
			jar,
			body: { organizationId },
		});

		const me = await api(webUrl, "GET", "/api/v1/me", { jar });
		const permissions = Array.isArray(field(me.body, "permissions"))
			? (field(me.body, "permissions") as string[])
			: [];
		check(
			"me now carries the active organization",
			asString(field(field(me.body, "activeOrganization"), "id")) === organizationId,
		);
		check("me reports the owner role", asString(field(me.body, "role")) === "owner");
		check(
			"the owner receives the full generated permission set",
			permissions.length === GENERATED_PERMISSIONS.length,
			`${permissions.length} permissions (registry: ${GENERATED_PERMISSIONS.length})`,
		);

		// --- 7. members and API keys through the rewrite -----------------------------------------
		console.log("7. members and API keys");
		const members = await api(webUrl, "GET", `/api/v1/organizations/${organizationId}/members`, {
			jar,
		});
		check("members list returns 200", members.status === 200, `status ${members.status}`);

		/**
		 * `manager` is the assertion that matters: it is one of the three templates better-auth
		 * would reject outright without the access-control registration in `packages/auth`, and it
		 * is what the invite dialog offers.
		 */
		const invite = await api(webUrl, "POST", "/api/auth/organization/invite-member", {
			jar,
			body: { email: inviteEmail, role: "manager", organizationId },
		});
		const invitationId = asString(field(invite.body, "id"));
		check(
			"a member can be invited as manager (a non-built-in role)",
			invite.status === 200 && invitationId.length > 0,
			`status ${invite.status}`,
		);

		const invitationPage = await page(webUrl, `/accept-invitation/${invitationId}`);
		check(
			"the invitation landing page is public and renders",
			invitationPage.status === 200,
			`status ${invitationPage.status}`,
		);

		// `organizationId` is mandatory because the plugin is configured with
		// `references: "organization"` — the key belongs to the tenant, not to its creator.
		const key = await api(webUrl, "POST", "/api/auth/api-key/create", {
			jar,
			body: { name: `smoke-${RUN_ID}`, organizationId },
		});
		check(
			"an organization API key can be issued",
			key.status === 200 && asString(field(key.body, "key")).startsWith("ovk_"),
			`status ${key.status}`,
		);

		/**
		 * Listing WITHOUT organizationId returns user-owned keys, which for an organization-scoped
		 * plugin is always empty — the exact bug that would make the API keys page look broken.
		 */
		const orgKeys = await api(
			webUrl,
			"GET",
			`/api/auth/api-key/list?organizationId=${organizationId}`,
			{ jar },
		);
		const listed = field(orgKeys.body, "apiKeys");
		check(
			"the organization's keys are listed when scoped by organizationId",
			Array.isArray(listed) && listed.length === 1,
			Array.isArray(listed) ? `${listed.length} keys` : "not an array",
		);

		// --- 8. switching organizations ----------------------------------------------------------
		console.log("8. switch between organizations");
		const second = await api(webUrl, "POST", "/api/auth/organization/create", {
			jar,
			body: { name: `Smoke Org Two ${RUN_ID}`, slug: `smoke-org-two-${RUN_ID}` },
		});
		const secondId = asString(field(second.body, "id"));
		await api(webUrl, "POST", "/api/auth/organization/set-active", {
			jar,
			body: { organizationId: secondId },
		});
		const meSecond = await api(webUrl, "GET", "/api/v1/me", { jar });
		check(
			"the active organization follows the switch",
			asString(field(field(meSecond.body, "activeOrganization"), "id")) === secondId,
		);

		const mine = await api(webUrl, "GET", "/api/v1/organizations", { jar });
		const list = field(mine.body, "data");
		check(
			"both organizations are listed",
			Array.isArray(list) && list.length === 2,
			Array.isArray(list) ? `${list.length} organizations` : "not an array",
		);

		// --- 9. every claimed route is actually served --------------------------------------------
		console.log("9. every app route is served");
		const routes = [
			"/",
			"/extensions",
			"/devices",
			"/numbers",
			"/trunks",
			"/routing",
			"/ivr",
			"/ring-groups",
			"/queues",
			"/voicemail",
			"/conferences",
			"/recordings",
			"/cdr",
			"/settings",
			"/settings/members",
			"/settings/api-keys",
		];
		const failures: string[] = [];
		for (const route of routes) {
			const result = await page(webUrl, route, jar);
			if (result.status !== 200) {
				failures.push(`${route} → ${result.status}`);
			}
		}
		check("all app routes return 200", failures.length === 0, failures.join(", ") || "16 routes");

		const authRoutes = [
			"/sign-in",
			"/sign-up",
			"/forgot-password",
			"/reset-password",
			"/two-factor",
			"/verify-email",
		];
		const authFailures: string[] = [];
		for (const route of authRoutes) {
			const result = await page(webUrl, route);
			if (result.status !== 200) {
				authFailures.push(`${route} → ${result.status}`);
			}
		}
		check(
			"all auth routes return 200",
			authFailures.length === 0,
			authFailures.join(", ") || "6 routes",
		);
	} finally {
		next?.kill("SIGTERM");
		apiProcess.kill("SIGTERM");
		await delay(300);
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.log("\nfailures:");
		for (const entry of failed) {
			console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`);
		}
		process.exitCode = 1;
	}
}

await main();
