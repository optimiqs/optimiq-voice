/**
 * End-to-end smoke for the P4 PBX screens.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/web smoke:pbx
 *
 * `smoke-auth-flow.ts` proves the frontend's WIRING — the rewrite, the cookie, the guard, that
 * every route renders. This proves the frontend's UNDERSTANDING of the PBX contract, which is a
 * different claim and needs a different test: that the bodies these screens build are accepted,
 * that the envelopes they read are shaped as they assume, and — the part no unit test can reach —
 * that the error taxonomy the forms decode is the taxonomy the server actually emits.
 *
 * So it boots the real auth slice PLUS `PbxModule` (the same module `verify-pbx.ts` gates),
 * seeds the demo fixture, starts Next, and drives everything through the NEXT origin. Where a
 * check is about how the UI would render a response, it calls the app's own
 * `lib/pbx/errors.ts` on the real body rather than asserting on a status code — a 422 that maps
 * to no field is a form that shows nothing, and only running the real mapper against the real
 * body can catch that.
 *
 * What it proves, in order:
 *
 *  1. Every PBX route the app claims — lists and the four detail views — renders through Next.
 *  2. Create / edit / delete round trips for an extension, a DID and an inbound route carrying a
 *     destination trio, using the exact bodies the forms build.
 *  3. A dangling destination is refused, ROLLED BACK, and maps to a real form field.
 *  4. A compile failure is refused, ROLLED BACK, and reads as "not saved" rather than as a warning.
 *  5. A save that merely warns SUCCEEDS, and the warning is carried in the envelope.
 *  6. A refused delete names its referrers, and every one of them resolves to a link.
 *  7. The T2 area end to end: a queue, an agent, a tier joining the two, a conference room, a park
 *     lot, and a call-park feature code wired to that lot through the param-fields declaration the
 *     form reads instead of a JSON textarea.
 *  8. `queues.manage-agents` is a DIFFERENT grant from `queues.write`, enforced by the API — proved
 *     with a second real session holding neither.
 *  9. The voicemail mailbox surface the messages drawer and the PIN dialog are built on: the
 *     message list and its counts, and that a mailbox row never carries a PIN digest in either
 *     direction.
 *
 * Playwright is not set up in this repository, so this is fetch-level: it verifies the contract
 * and the server-rendered HTML, not clicks.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startFakeTelnyxServer } from "@optimiq-voice/telnyx/fake";
import { ApiError } from "../lib/api-client";
import { writeDestination } from "../lib/pbx/destinations";
import {
	isCompileRollback,
	pbxDiagnostics,
	pbxErrorCode,
	pbxFieldErrors,
	pbxFormMessage,
	pbxReferences,
} from "../lib/pbx/errors";
import { buildParamsBody, paramFieldsFor } from "../lib/pbx/feature-code-params";
import { referenceHref } from "../lib/pbx/references";
import type { EntityReference, FeatureCodeParamFields } from "../lib/pbx/contracts";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";

/**
 * Shared with `verify-auth-slice.ts` and `smoke-auth-flow.ts`, and that is not incidental: the jwt
 * plugin stores its JWKS private key in the database encrypted with `AUTH_SECRET`, so two tools
 * pointing at one development database MUST agree on it or every session resolution fails with a
 * blanket 401 that looks exactly like a broken frontend.
 */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

/**
 * A DIGITS-ONLY run suffix.
 *
 * `RUN_ID` is base-36 and therefore contains letters, which is fine for a slug and fatal for an
 * extension number or a DID — `internalNumber` is digits only and `e164` wants `+` then digits.
 * Deriving telephone identifiers from the slug is exactly the mistake this smoke exists to catch,
 * so it is not repeated here.
 */
const RUN_DIGITS = String(Date.now()).slice(-4);
const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API_ROOT = join(dirname(WEB_ROOT), "api");

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
	checks.push({ name, ok, detail });
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
	return ok;
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
}

interface JsonResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

function makeClient(baseUrl: string, jar: CookieJar) {
	return async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) {
			headers["content-type"] = "application/json";
		}
		const cookie = jar.header();
		if (cookie) {
			headers.cookie = cookie;
		}
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			redirect: "manual",
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		jar.absorb(response);
		const text = await response.text();
		let parsed: unknown = null;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			parsed = { raw: text };
		}
		return {
			status: response.status,
			body:
				typeof parsed === "object" && parsed !== null
					? (parsed as Record<string, unknown>)
					: { value: parsed },
		};
	};
}

type Client = ReturnType<typeof makeClient>;

/**
 * Rebuilds the `ApiError` the app's own client would have thrown, so the error helpers under test
 * are run against the REAL body rather than against a fixture that could drift from it.
 */
function asApiError(response: JsonResponse): ApiError {
	const message = typeof response.body.message === "string" ? response.body.message : "failed";
	return new ApiError(response.status, message, response.body);
}

function data(response: JsonResponse): Record<string, unknown> {
	const value = response.body.data;
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function rowId(response: JsonResponse): string {
	const value = data(response).id;
	return typeof value === "string" ? value : "";
}

function warningCodes(response: JsonResponse): string[] {
	const value = response.body.warnings;
	return Array.isArray(value)
		? (value as { code?: string }[]).map((warning) => warning.code ?? "")
		: [];
}

function total(response: JsonResponse): number {
	return typeof response.body.total === "number" ? response.body.total : -1;
}

async function page(
	baseUrl: string,
	path: string,
	jar: CookieJar,
): Promise<{ status: number; html: string }> {
	const response = await fetch(`${baseUrl}${path}`, {
		headers: { accept: "text/html", cookie: jar.header() },
		redirect: "manual",
	});
	return { status: response.status, html: await response.text() };
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

/** Runs the API's own seed script, in the API's own process, exactly as a developer would. */
async function seedDemo(organizationId: string, pbxDatabaseUrl: string): Promise<boolean> {
	return await new Promise((resolve) => {
		const seed = spawn(
			process.execPath,
			["--import", "tsx", "scripts/seed-pbx-demo.ts", "--organization", organizationId],
			{
				cwd: API_ROOT,
				env: { ...process.env, PBX_DATABASE_URL: pbxDatabaseUrl },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		seed.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) {
				console.error(`  [seed] ${text}`);
			}
		});
		seed.on("exit", (code) => resolve(code === 0));
		seed.on("error", () => resolve(false));
	});
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const apiPort = await findFreePort();
	const webPort = await findFreePort();
	const apiUrl = `http://127.0.0.1:${apiPort}`;
	const webUrl = `http://127.0.0.1:${webPort}`;

	/**
	 * A fake carrier, in THIS process, reachable by the API's process over loopback.
	 *
	 * Nobody working on this repository has a Telnyx key, and the operations this section drives —
	 * buy a number, provision a trunk — are billable and irreversible. `@optimiq-voice/telnyx/fake`
	 * is the same server the client's own unit tests and `verify:carrier` use, so the three cannot
	 * drift: if the frontend's understanding of the carrier contract diverges from the client's, one
	 * of them fails here.
	 */
	const fakeTelnyx = await startFakeTelnyxServer();

	/**
	 * The API runs as its OWN process, rooted at `apps/api`.
	 *
	 * It cannot be imported from here — `@nestjs/core` and the rest do not resolve from `apps/web`,
	 * and adding them would put the whole backend in the frontend's dependency graph. `node -e`
	 * resolves bare specifiers against its working directory, so running it with `cwd: apps/api`
	 * gives the boot code the API's own resolution.
	 *
	 * `@optimiq-voice/config` parses the environment at import time and `PbxModule` reads it in a
	 * provider factory, so every import inside the boot code is dynamic.
	 */
	const bootCode = `
		await import("reflect-metadata");
		const { NestFactory } = await import("@nestjs/core");
		const { FastifyAdapter } = await import("@nestjs/platform-fastify");
		const { createApiRootModule, registerAuthTransport } = await import(
			"./src/auth/auth-bootstrap.ts"
		);
		const { PbxModule } = await import("./src/pbx/pbx.module.ts");
		// \`warn\` is on because development email delivery is a LOGGING stub — the one-time
		// verification link is written to the log rather than sent, and section 12 needs it to put a
		// second real member in the organization. See \`apps/api/src/auth/auth-email.delivery.ts\`.
		const app = await NestFactory.create(
			createApiRootModule([], [PbxModule]),
			new FastifyAdapter(),
			{ logger: ["error", "warn"] },
		);
		app.enableShutdownHooks();
		await registerAuthTransport(app);
		await app.listen(${apiPort}, "127.0.0.1");
		console.log("PBX_SLICE_READY");
	`;

	console.log(`booting the auth slice + PBX area on ${apiUrl}`);
	const apiProcess: ChildProcess = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", bootCode],
		{
			cwd: API_ROOT,
			env: {
				...process.env,
				NODE_ENV: "test",
				DATABASE_URL: databaseUrl,
				PBX_DATABASE_URL: pbxDatabaseUrl,
				AUTH_SECRET: TEST_SECRET,
				AUTH_URL: apiUrl,
				API_APP_URL: webUrl,
				// The carrier, pointed at the fake. Without these the carrier endpoints answer 503 —
				// which is also a state worth rendering, and section 13 checks that separately by
				// reading `carrier/status` rather than by booting a second API.
				TELNYX_API_KEY: "smoke-pbx-carrier-key",
				TELNYX_API_BASE: fakeTelnyx.baseUrl,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	/**
	 * The API's log, kept so the verification link can be read out of it.
	 *
	 * Development email delivery is a stub that LOGS the one-time link instead of sending it, which
	 * is the only way to complete a signup from a script — and completing one is the only way to get
	 * a second real session, which is the only way to prove `queues.manage-agents` is enforced rather
	 * than merely declared. Reading a token out of a log is not something production code should ever
	 * do; it is exactly what a smoke against a logging mailer must.
	 *
	 * Both streams are captured because which one a Nest `warn` lands on is a framework detail, and
	 * this must not break the day it changes.
	 */
	let apiLog = "";

	apiProcess.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		apiLog += text;
		const trimmed = text.trim();
		// The stub mailer's warnings are expected noise here — they are the point, not a problem.
		if (trimmed && !trimmed.includes("STUB email delivery")) {
			console.error(`  [api] ${trimmed}`);
		}
	});

	apiProcess.stdout?.on("data", (chunk: Buffer) => {
		apiLog += chunk.toString();
	});

	async function verificationTokenFor(email: string): Promise<string | undefined> {
		const deadline = Date.now() + 10_000;
		const pattern = new RegExp(
			`verification link for ${email.replaceAll(/[.+]/gu, String.raw`\$&`)}[^\\n]*?token=([\\w.-]+)`,
			"u",
		);
		while (Date.now() < deadline) {
			const match = pattern.exec(apiLog);
			if (match?.[1]) {
				return match[1];
			}
			await delay(200);
		}
		return undefined;
	}

	let next: ChildProcess | null = null;

	try {
		const apiReady = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 120_000);
			apiProcess.stdout?.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("PBX_SLICE_READY")) {
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
			throw new Error(
				"the API did not start (is Postgres reachable on :5433 with both databases?)",
			);
		}

		/**
		 * `next dev`, not `next start`: rewrite destinations are baked into the routes manifest at
		 * build time, so a production server proxies to whatever `API_PROXY_ORIGIN` was set to when
		 * it was built. `next dev` evaluates the config on boot, which an ephemeral port needs.
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

		if (!(await waitForServer(webUrl, 180_000))) {
			throw new Error("the Next server did not become reachable");
		}

		const jar = new CookieJar();
		const client: Client = makeClient(webUrl, jar);
		const email = `pbx-smoke-${RUN_ID}@smoke.optimiq.test`;
		const password = "Smoke-Pbx-Flow-2026!";

		// --- 0. an owner with an organization ----------------------------------------------------
		console.log("0. sign up and create an organization, through the Next rewrite");
		await client("POST", "/api/auth/sign-up/email", { name: "PBX Smoke", email, password });
		const created = await client("POST", "/api/auth/organization/create", {
			name: `PBX Smoke ${RUN_ID}`,
			slug: `pbx-smoke-${RUN_ID}`,
		});
		const organizationId = typeof created.body.id === "string" ? created.body.id : "";
		await client("POST", "/api/auth/organization/set-active", { organizationId });
		check("organization created and active", organizationId.length > 0, organizationId);

		console.log("\n0b. seed the demo PBX fixture");
		const seeded = await seedDemo(organizationId, pbxDatabaseUrl);
		check("seed-pbx-demo.ts populated the organization", seeded);

		const seededExtensions = await client("GET", "/api/v1/extensions?page=1&limit=20");
		check(
			"the seeded rows are visible through the Next rewrite",
			seededExtensions.status === 200 && total(seededExtensions) === 3,
			`status ${seededExtensions.status}, total ${total(seededExtensions)}`,
		);
		check(
			"the list envelope is the shape the tables assume",
			["data", "total", "page", "limit", "totalPages"].every((key) =>
				Object.hasOwn(seededExtensions.body, key),
			),
			Object.keys(seededExtensions.body).join(", "),
		);

		// --- 1. every PBX route renders -----------------------------------------------------------
		console.log("\n1. every PBX screen renders through Next");
		const seededIvr = await client("GET", "/api/v1/ivr-menus?page=1&limit=1");
		const seededRingGroups = await client("GET", "/api/v1/ring-groups?page=1&limit=1");
		const seededConditions = await client("GET", "/api/v1/time-conditions?page=1&limit=1");
		const seededQueues = await client("GET", "/api/v1/queues?page=1&limit=1");
		const ivrMenuId = firstId(seededIvr);
		const ringGroupId = firstId(seededRingGroups);
		const timeConditionId = firstId(seededConditions);
		const seededQueueId = firstId(seededQueues);

		const seededTrunks = await client("GET", "/api/v1/trunks?page=1&limit=1");
		const seededTrunkId = firstId(seededTrunks);

		const routes = [
			"/extensions",
			"/numbers",
			// The order tab is a second view of the same subject rather than a second route, so it is
			// only reachable — and only renderable — through the query state. A tab that 404s or
			// crashes would otherwise be invisible to a route list.
			"/numbers?tab=order",
			"/trunks",
			`/trunks/${seededTrunkId}`,
			"/voicemail",
			"/ivr",
			"/ring-groups",
			"/queues",
			"/queues?tab=agents",
			"/conferences",
			"/park-lots",
			"/routing",
			"/routing?tab=outbound",
			"/routing?tab=time-conditions",
			"/routing?tab=feature-codes",
			"/routing?tab=tools",
			`/ivr/${ivrMenuId}`,
			`/ring-groups/${ringGroupId}`,
			`/queues/${seededQueueId}`,
			`/routing/time-conditions/${timeConditionId}`,
		];
		const routeFailures: string[] = [];
		for (const route of routes) {
			const result = await page(webUrl, route, jar);
			if (result.status !== 200) {
				routeFailures.push(`${route} → ${result.status}`);
			}
		}
		check(
			"all PBX routes return 200",
			routeFailures.length === 0,
			routeFailures.join(", ") || `${routes.length} routes`,
		);

		// --- 2. an extension, end to end ----------------------------------------------------------
		console.log("\n2. extension: create, edit, delete");
		const extensionBody = {
			number: `9${RUN_DIGITS}`,
			label: "Smoke Extension",
			sipSecretRef: `secret://smoke/${RUN_ID}`,
			callerIdName: "Smoke Extension",
			callerIdNumber: null,
			outboundCallerIdNumber: null,
			tollClass: "national",
			recordPolicy: "none",
			voicemailEnabled: true,
			doNotDisturb: false,
			enabled: true,
		};
		const extension = await client("POST", "/api/v1/extensions", extensionBody);
		const extensionId = rowId(extension);
		check(
			"create extension -> 201 with a mutation envelope",
			extension.status === 201 && Array.isArray(extension.body.warnings),
			`status ${extension.status}`,
		);

		const renamed = await client("PATCH", `/api/v1/extensions/${extensionId}`, {
			label: "Smoke Extension (renamed)",
			callerIdName: null,
		});
		check(
			"edit extension -> 200, and a null clears the field",
			renamed.status === 200 &&
				data(renamed).label === "Smoke Extension (renamed)" &&
				data(renamed).callerIdName === null,
			`status ${renamed.status}`,
		);

		/**
		 * The duplicate must land on the `number` control. A 409 the form cannot attach to an input
		 * is a dialog that fails with no visible reason.
		 */
		const duplicate = await client("POST", "/api/v1/extensions", extensionBody);
		const duplicateFields = pbxFieldErrors(asApiError(duplicate));
		check(
			"a duplicate number is a 409 the form can put on the number field",
			duplicate.status === 409 &&
				pbxErrorCode(asApiError(duplicate)) === "PBX_CONFLICT" &&
				typeof duplicateFields.number === "string",
			`status ${duplicate.status}, fields ${JSON.stringify(Object.keys(duplicateFields))}`,
		);

		// --- 3. a DID with a destination trio -----------------------------------------------------
		console.log("\n3. number: create with a destination trio, edit, delete");
		const numberBody = {
			e164: `+1999555${RUN_DIGITS}`,
			label: "Smoke DID",
			callerIdNamePrefix: null,
			recordEnabled: false,
			voiceEnabled: true,
			faxEnabled: false,
			enabled: true,
			// Built by the app's own trio writer, so the smoke exercises the code the form uses.
			...writeDestination({ type: "extension", ref: extensionId, data: null }, ""),
		};
		const number = await client("POST", "/api/v1/phone-numbers", numberBody);
		const numberId = rowId(number);
		check(
			"create number -> 201 with the trio the picker produced",
			number.status === 201 &&
				data(number).destinationType === "extension" &&
				data(number).destinationRef === extensionId,
			`status ${number.status}`,
		);

		/** Switching a trio to a value-backed type must drop the ref, or the write is a 422. */
		const repointed = await client("PATCH", `/api/v1/phone-numbers/${numberId}`, {
			...writeDestination(
				{ type: "external", ref: extensionId, data: { value: "+12125550199" } },
				"",
			),
		});
		check(
			"switching the trio to a literal drops the stale ref",
			repointed.status === 200 &&
				data(repointed).destinationType === "external" &&
				data(repointed).destinationRef === null,
			`status ${repointed.status}`,
		);
		await client("PATCH", `/api/v1/phone-numbers/${numberId}`, {
			...writeDestination({ type: "extension", ref: extensionId, data: null }, ""),
		});

		// --- 4. an inbound route carrying two trios -----------------------------------------------
		console.log("\n4. inbound route: primary + failover destinations");
		const inbound = await client("POST", "/api/v1/inbound-routes", {
			name: `Smoke route ${RUN_ID}`,
			priority: 500,
			matchKind: "exact",
			matchPattern: numberBody.e164,
			phoneNumberId: numberId,
			recordEnabled: false,
			enabled: true,
			...writeDestination({ type: "ivr", ref: ivrMenuId, data: null }, ""),
			...writeDestination({ type: "extension", ref: extensionId, data: null }, "failover"),
		});
		const inboundId = rowId(inbound);
		check(
			"create inbound route -> 201 with both trios stored",
			inbound.status === 201 &&
				data(inbound).destinationType === "ivr" &&
				data(inbound).failoverDestinationType === "extension",
			`status ${inbound.status}`,
		);

		const gated = await client("PATCH", `/api/v1/inbound-routes/${inboundId}`, {
			timeConditionId,
			priority: 400,
		});
		check(
			"edit inbound route -> 200 and the time-condition gate is applied",
			gated.status === 200 && data(gated).timeConditionId === timeConditionId,
			`status ${gated.status}`,
		);

		// --- 5. a dangling destination is refused AND rolled back ---------------------------------
		console.log("\n5. a dangling destination is refused, rolled back, and lands on a field");
		const before = total(await client("GET", "/api/v1/inbound-routes?page=1&limit=1"));
		const dangling = await client("POST", "/api/v1/inbound-routes", {
			name: `Dangling ${RUN_ID}`,
			matchKind: "any",
			...writeDestination(
				{ type: "ring-group", ref: "0193f2aa-0000-7000-8000-0000deadbeef", data: null },
				"",
			),
		});
		const danglingError = asApiError(dangling);
		const danglingFields = pbxFieldErrors(danglingError);
		check(
			"a dangling destinationRef is a 422 the picker can put on the ref control",
			dangling.status === 422 && typeof danglingFields.destinationRef === "string",
			`status ${dangling.status}, code ${pbxErrorCode(danglingError)}, fields ${JSON.stringify(
				Object.keys(danglingFields),
			)}`,
		);
		const after = total(await client("GET", "/api/v1/inbound-routes?page=1&limit=1"));
		check("the refused route was NOT written", before === after, `${before} then ${after}`);

		// --- 6. a compile failure reads as "not saved" --------------------------------------------
		console.log("\n6. ROUTING_COMPILE_FAILED is a rollback, and says so");
		const conditionsBefore = total(await client("GET", "/api/v1/time-conditions?page=1&limit=1"));
		const badZone = await client("POST", "/api/v1/time-conditions", {
			name: `Nowhere ${RUN_ID}`,
			timezone: "Mars/Olympus_Mons",
			...writeDestination({ type: "extension", ref: extensionId, data: null }, ""),
		});
		const badZoneError = asApiError(badZone);
		check(
			"an unsound configuration is refused with ROUTING_COMPILE_FAILED",
			badZone.status === 422 && isCompileRollback(badZoneError),
			`status ${badZone.status}, code ${pbxErrorCode(badZoneError)}`,
		);
		check(
			"the compiler's error diagnostics reach the client",
			pbxDiagnostics(badZoneError).length > 0,
			`${pbxDiagnostics(badZoneError).length} diagnostics`,
		);
		/**
		 * The single most important sentence in this area: a rollback and a warning look almost
		 * identical on the wire and mean opposite things.
		 */
		const rollbackMessage = pbxFormMessage(badZoneError) ?? "";
		check(
			"the UI copy says the change was NOT saved",
			rollbackMessage.includes("rolled back") && rollbackMessage.includes("Nothing was saved"),
			rollbackMessage.slice(0, 80),
		);
		const conditionsAfter = total(await client("GET", "/api/v1/time-conditions?page=1&limit=1"));
		check(
			"the rolled-back condition is not in the database",
			conditionsBefore === conditionsAfter,
			`${conditionsBefore} then ${conditionsAfter}`,
		);

		// --- 7. a warning is a SUCCESS ------------------------------------------------------------
		console.log("\n7. a save that only warns succeeds, and carries the warning");
		const emptyGroup = await client("POST", "/api/v1/ring-groups", {
			name: `Smoke empty group ${RUN_ID}`,
			strategy: "simultaneous",
			enabled: true,
		});
		const emptyGroupId = rowId(emptyGroup);
		check(
			"an empty ring group is CREATED (201), not refused",
			emptyGroup.status === 201 && emptyGroupId.length > 0,
			`status ${emptyGroup.status}`,
		);
		check(
			"and the envelope carries the empty-ring-group warning",
			warningCodes(emptyGroup).includes("empty-ring-group"),
			JSON.stringify(warningCodes(emptyGroup)),
		);
		check(
			"a warning is never mistaken for a failure",
			!isCompileRollback(asApiError(emptyGroup)) && emptyGroup.status < 400,
			`status ${emptyGroup.status}`,
		);

		const member = await client("POST", `/api/v1/ring-groups/${emptyGroupId}/destinations`, {
			ordinal: 0,
			...writeDestination({ type: "extension", ref: extensionId, data: null }, ""),
		});
		check(
			"adding a member clears the warning",
			member.status === 201 && !warningCodes(member).includes("empty-ring-group"),
			`status ${member.status}, warnings ${JSON.stringify(warningCodes(member))}`,
		);

		// --- 8. a refused delete names rows the UI can link to -------------------------------------
		console.log("\n8. a refused delete names its referrers, and every one resolves to a link");
		const refused = await client("DELETE", `/api/v1/extensions/${extensionId}`);
		const refusedError = asApiError(refused);
		const references: readonly EntityReference[] = pbxReferences(refusedError);
		check(
			"deleting a referenced extension is a 409 naming the referrers",
			refused.status === 409 && references.length > 0,
			`status ${refused.status}, ${references.length} references`,
		);
		const unlinkable = references.filter((reference) => referenceHref(reference) === undefined);
		check(
			"every referrer resolves to somewhere the user can go and fix it",
			unlinkable.length === 0,
			unlinkable.map((reference) => reference.kind).join(", ") ||
				references.map((reference) => reference.kind).join(", "),
		);

		// --- 9. tear the fixture down, in dependency order ----------------------------------------
		console.log("\n9. delete: routes first, then the rows they pointed at");
		const routeDeleted = await client("DELETE", `/api/v1/inbound-routes/${inboundId}`);
		check(
			"delete inbound route -> 200",
			routeDeleted.status === 200,
			`status ${routeDeleted.status}`,
		);

		const groupDeleted = await client("DELETE", `/api/v1/ring-groups/${emptyGroupId}`);
		check("delete ring group -> 200", groupDeleted.status === 200, `status ${groupDeleted.status}`);

		/**
		 * Deleting a DID CASCADES its narrowed inbound routes — the one delete in this area that
		 * does. The confirmation copy says so, and this is the check that keeps that copy true.
		 */
		const numberDeleted = await client("DELETE", `/api/v1/phone-numbers/${numberId}`);
		check("delete number -> 200", numberDeleted.status === 200, `status ${numberDeleted.status}`);

		const extensionDeleted = await client("DELETE", `/api/v1/extensions/${extensionId}`);
		check(
			"delete extension -> 200 once nothing points at it",
			extensionDeleted.status === 200,
			`status ${extensionDeleted.status}`,
		);

		// --- 10. compile and simulate --------------------------------------------------------------
		console.log("\n10. the routing tools");
		const compiled = await client("POST", "/api/v1/routing/compile", {});
		check(
			"POST /routing/compile returns a snapshot the panel can render",
			compiled.status === 200 && typeof data(compiled).snapshotHash === "string",
			`status ${compiled.status}`,
		);

		// The seed derives a run-unique DID (e164 is now platform-globally unique),
		// so read it back from the API rather than hardcoding it.
		const seededNumbers = await client("GET", "/api/v1/phone-numbers?limit=1");
		const seededRows = data(seededNumbers);
		const seededDid =
			Array.isArray(seededRows) && seededRows.length > 0
				? String((seededRows[0] as Record<string, unknown>).e164)
				: "";
		const simulated = await client("POST", "/api/v1/routing/simulate", {
			routingContext: "inbound",
			destinationNumber: seededDid,
		});
		check(
			"POST /routing/simulate resolves the seeded DID",
			simulated.status === 200 && data(simulated).matched === true,
			`status ${simulated.status}, matched ${String(data(simulated).matched)}`,
		);
		check(
			"simulate returns diagnostics the panel can list",
			Array.isArray(data(simulated).diagnostics),
			typeof data(simulated).diagnostics,
		);

		// --- 11. a queue, an agent, and the tier that joins them -----------------------------------
		console.log("\n11. queue: settings, an agent, and a membership");

		/**
		 * The agent's own extension, created here rather than reused: section 9 deleted the one
		 * section 2 built, and a smoke that silently depends on teardown order is a smoke that fails
		 * for the wrong reason.
		 */
		const agentExtension = await client("POST", "/api/v1/extensions", {
			number: `8${RUN_DIGITS}`,
			label: "Smoke Agent Extension",
			sipSecretRef: `secret://smoke-agent/${RUN_ID}`,
			tollClass: "internal",
			recordPolicy: "none",
			enabled: true,
		});
		const agentExtensionId = rowId(agentExtension);

		const queue = await client("POST", "/api/v1/queues", {
			name: `Smoke queue ${RUN_ID}`,
			extensionNumber: `7${RUN_DIGITS}`,
			strategy: "longest-idle",
			maxWaitSeconds: 300,
			maxWaitNoAgentSeconds: 30,
			wrapUpSeconds: 10,
			announcePositionEnabled: true,
			announceFrequencySeconds: 30,
			tierRulesApply: true,
			tierRuleWaitSeconds: 10,
			recordEnabled: false,
			enabled: true,
			// The queue form's own trio writer, so the smoke exercises the code the dialog runs.
			...writeDestination({ type: "extension", ref: agentExtensionId, data: null }, "timeout"),
		});
		const queueId = rowId(queue);
		check(
			"create queue -> 201 with the settings the dialog sends",
			queue.status === 201 && data(queue).strategy === "longest-idle",
			`status ${queue.status}`,
		);

		/**
		 * `resettable`: an emptied numeric control sends `null` and means "put it back to the server
		 * default", NOT "clear it to NULL". Every knob on the queue form is one of these, so a `null`
		 * that came back as `null` would mean the whole form clears columns it meant to reset.
		 */
		const reset = await client("PATCH", `/api/v1/queues/${queueId}`, { wrapUpSeconds: null });
		check(
			"a null on a resettable knob restores the default rather than nulling the column",
			reset.status === 200 && typeof data(reset).wrapUpSeconds === "number",
			`status ${reset.status}, wrapUpSeconds ${JSON.stringify(data(reset).wrapUpSeconds)}`,
		);

		const agent = await client("POST", "/api/v1/queue-agents", {
			name: `Smoke agent ${RUN_ID}`,
			contactKind: "extension",
			extensionId: agentExtensionId,
			contact: null,
			status: "logged-out",
			maxNoAnswer: 3,
			enabled: true,
		});
		const agentId = rowId(agent);
		check(
			"create agent -> 201 at the TOP-LEVEL endpoint, carrying no queue",
			agent.status === 201 && data(agent).queueId === undefined,
			`status ${agent.status}`,
		);

		/** The reachability pair, refused server-side exactly as the form refuses it. */
		const unreachable = await client("POST", "/api/v1/queue-agents", {
			name: `Unreachable ${RUN_ID}`,
			contactKind: "extension",
			extensionId: null,
			contact: null,
		});
		const unreachableFields = pbxFieldErrors(asApiError(unreachable));
		check(
			"an agent with no way to be dialled is refused, on the extension control",
			unreachable.status === 400 && typeof unreachableFields.extensionId === "string",
			`status ${unreachable.status}, fields ${JSON.stringify(Object.keys(unreachableFields))}`,
		);

		const tier = await client("POST", `/api/v1/queues/${queueId}/tiers`, {
			queueAgentId: agentId,
			level: 1,
			position: 1,
		});
		const tierId = rowId(tier);
		check(
			"staff the queue -> 201, and the tier carries (level, position)",
			tier.status === 201 && data(tier).level === 1 && data(tier).position === 1,
			`status ${tier.status}`,
		);

		const movedTier = await client("PATCH", `/api/v1/queues/${queueId}/tiers/${tierId}`, {
			level: 2,
			position: 5,
		});
		check(
			"a membership can be moved between levels",
			movedTier.status === 200 && data(movedTier).level === 2 && data(movedTier).position === 5,
			`status ${movedTier.status}`,
		);

		const tierList = await client("GET", `/api/v1/queues/${queueId}/tiers`);
		check(
			"the tier list is an unpaginated collection, as the child panel assumes",
			tierList.status === 200 &&
				Array.isArray(tierList.body.data) &&
				(tierList.body.data as unknown[]).length === 1,
			`status ${tierList.status}`,
		);

		/**
		 * A tier has NO reorder endpoint, deliberately: its place is `(level, position)`, which the
		 * caller states because it decides who is offered the call first. The detail page has no drag
		 * handle for exactly this reason, and this is the check that keeps that true.
		 */
		const reorder = await client("PUT", `/api/v1/queues/${queueId}/tiers/reorder`, {
			ids: [tierId],
		});
		check(
			"there is no reorder endpoint for tiers, so the UI must not offer one",
			reorder.status === 404 || reorder.status === 405,
			`status ${reorder.status}`,
		);

		// --- 12. `queues.manage-agents` is not `queues.write` ---------------------------------------
		console.log("\n12. staffing the floor is a different grant from editing the queue");

		const agentEmail = `pbx-smoke-agent-${RUN_ID}@smoke.optimiq.test`;
		const invited = await client("POST", "/api/auth/organization/invite-member", {
			email: agentEmail,
			role: "agent",
			organizationId,
		});
		const invitationId = typeof invited.body.id === "string" ? invited.body.id : "";

		/** A SECOND real session, because a permission the API does not enforce is decoration. */
		const agentJar = new CookieJar();
		const agentClient: Client = makeClient(webUrl, agentJar);
		const agentSignUp = await agentClient("POST", "/api/auth/sign-up/email", {
			name: "PBX Smoke Agent",
			email: agentEmail,
			password,
		});
		/**
		 * `requireEmailVerificationOnInvitation` is on, so an unverified account cannot join an
		 * organization — which is the right policy and an obstacle for a script. The stub mailer logs
		 * the link, so the token is read back out of the API's log.
		 */
		const verificationToken = await verificationTokenFor(agentEmail);
		const verified = await agentClient(
			"GET",
			`/api/auth/verify-email?token=${verificationToken ?? ""}`,
		);
		const accepted = await agentClient("POST", "/api/auth/organization/accept-invitation", {
			invitationId,
		});
		const activated = await agentClient("POST", "/api/auth/organization/set-active", {
			organizationId,
		});
		check(
			"the invited agent verifies, accepts, and lands on the organization",
			invited.status === 200 &&
				agentSignUp.status === 200 &&
				verified.status < 400 &&
				accepted.status === 200 &&
				activated.status === 200,
			`invite ${invited.status}, sign-up ${agentSignUp.status}, verify ${verified.status}, accept ${
				accepted.status
			} ${JSON.stringify(accepted.body).slice(0, 120)}, activate ${activated.status}`,
		);

		const agentMe = await agentClient("GET", "/api/v1/me");
		const agentPermissions = Array.isArray(agentMe.body.permissions)
			? (agentMe.body.permissions as string[])
			: [];
		check(
			"the agent role resolves to queues.read and park-lots.read but neither write grant",
			agentPermissions.includes("queues.read") &&
				agentPermissions.includes("park-lots.read") &&
				!agentPermissions.includes("queues.write") &&
				!agentPermissions.includes("queues.manage-agents"),
			`${agentPermissions.length} permissions`,
		);

		const agentReadsQueues = await agentClient("GET", "/api/v1/queues?page=1&limit=1");
		const agentReadsLots = await agentClient("GET", "/api/v1/park-lots?page=1&limit=1");
		check(
			"and can READ both lists, which is why those pages are gated on the read grant",
			agentReadsQueues.status === 200 && agentReadsLots.status === 200,
			`queues ${agentReadsQueues.status}, park-lots ${agentReadsLots.status}`,
		);

		/** The manage-agents-gated action: the UI hides this button, and the API refuses it. */
		const refusedTier = await agentClient("POST", `/api/v1/queues/${queueId}/tiers`, {
			queueAgentId: agentId,
			level: 1,
			position: 2,
		});
		check(
			"staffing a queue without queues.manage-agents is refused",
			refusedTier.status === 403,
			`status ${refusedTier.status}`,
		);

		const refusedAgent = await agentClient("POST", "/api/v1/queue-agents", {
			name: "Should not exist",
			contactKind: "external",
			contact: "+12125550111",
		});
		const refusedSettings = await agentClient("PATCH", `/api/v1/queues/${queueId}`, {
			maxWaitSeconds: 10,
		});
		check(
			"and so are creating an agent and editing the queue's own settings",
			refusedAgent.status === 403 && refusedSettings.status === 403,
			`agent ${refusedAgent.status}, settings ${refusedSettings.status}`,
		);

		// --- 13. a conference room -----------------------------------------------------------------
		console.log("\n13. conference: create and edit, with no PIN anywhere on the wire");
		const conference = await client("POST", "/api/v1/conferences", {
			name: `Smoke room ${RUN_ID}`,
			roomNumber: `9${RUN_DIGITS}`,
			maxMembers: 25,
			recordEnabled: false,
			announceJoinLeave: true,
			waitForModerator: false,
			enabled: true,
		});
		const conferenceId = rowId(conference);
		check(
			"create conference -> 201 with the body the dialog builds",
			conference.status === 201 && data(conference).roomNumber === `9${RUN_DIGITS}`,
			`status ${conference.status}`,
		);

		/**
		 * The form omits the PIN columns because the API does not accept them. If that ever changed
		 * silently, a dialog with no PIN control would be hiding a setting users need — so the
		 * refusal is asserted rather than assumed.
		 */
		const pinned = await client("PATCH", `/api/v1/conferences/${conferenceId}`, {
			pinHash: "0123456789abcdef",
		});
		check(
			"a PIN digest is refused by the DTO, which is why the form has no PIN control",
			pinned.status === 400,
			`status ${pinned.status}`,
		);

		const resized = await client("PATCH", `/api/v1/conferences/${conferenceId}`, {
			maxMembers: 60,
		});
		check(
			"edit conference -> 200",
			resized.status === 200 && data(resized).maxMembers === 60,
			`status ${resized.status}`,
		);

		// --- 14. a park lot, and the feature code wired to it via param-fields ---------------------
		console.log("\n14. park lot + a call-park code pointed at it through the param declaration");
		const slotStart = 7000 + (Number(RUN_DIGITS) % 900);
		const lot = await client("POST", "/api/v1/park-lots", {
			name: `Smoke lot ${RUN_ID}`,
			slotStart,
			slotEnd: slotStart + 9,
			timeoutSeconds: 120,
			enabled: true,
			...writeDestination({ type: "extension", ref: agentExtensionId, data: null }, "timeout"),
		});
		const lotId = rowId(lot);
		check(
			"create park lot -> 201 with the slot range and the timeout trio",
			lot.status === 201 &&
				data(lot).slotStart === slotStart &&
				data(lot).timeoutDestinationType === "extension",
			`status ${lot.status}`,
		);

		/** The range check the schema mirrors: it lands on `slotEnd`, not on the row. */
		const backwards = await client("POST", "/api/v1/park-lots", {
			name: `Backwards ${RUN_ID}`,
			slotStart: slotStart + 9,
			slotEnd: slotStart,
		});
		const backwardsFields = pbxFieldErrors(asApiError(backwards));
		check(
			"a slot range that runs backwards is refused on the last-slot control",
			backwards.status === 400 && typeof backwardsFields.slotEnd === "string",
			`status ${backwards.status}, fields ${JSON.stringify(Object.keys(backwardsFields))}`,
		);

		/**
		 * The whole point of `param-fields`: the feature-code form renders a park-lot PICKER instead
		 * of a JSON textarea, and it can only do that if the server declares the key. So the
		 * declaration is fetched and the body is built by the app's own `buildParamsBody` — the same
		 * function the dialog calls.
		 */
		const declaration = await client("GET", "/api/v1/feature-codes/param-fields");
		const fields = declaration.body.data as FeatureCodeParamFields | undefined;
		const parkFields = paramFieldsFor(fields, "call-park");
		check(
			"GET /feature-codes/param-fields declares call-park's lotId as an entity ref into park",
			declaration.status === 200 &&
				parkFields.length === 1 &&
				parkFields[0]?.name === "lotId" &&
				parkFields[0]?.kind === "entity" &&
				parkFields[0]?.entityType === "park",
			`status ${declaration.status}, ${JSON.stringify(parkFields)}`,
		);
		check(
			"and declares no parameters for an action that takes none, so the form shows no controls",
			paramFieldsFor(fields, "redial").length === 0,
			JSON.stringify(paramFieldsFor(fields, "redial")),
		);

		const parkCode = await client("POST", "/api/v1/feature-codes", {
			code: `*8${RUN_DIGITS}`,
			action: "call-park",
			params: buildParamsBody(parkFields, { lotId }),
			label: "Park a call",
			enabled: true,
		});
		const parkCodeId = rowId(parkCode);
		const storedParams = data(parkCode).params as Record<string, unknown> | null;
		check(
			"the picker's choice reaches the server as params.lotId",
			parkCode.status === 201 && storedParams?.lotId === lotId,
			`status ${parkCode.status}, params ${JSON.stringify(storedParams)}`,
		);

		/** A typo the old free-form bag would have accepted, saved, and silently never read. */
		const typo = await client("POST", "/api/v1/feature-codes", {
			code: `*9${RUN_DIGITS}`,
			action: "call-park",
			params: { lot_id: lotId },
		});
		const typoFields = pbxFieldErrors(asApiError(typo));
		check(
			"an undeclared parameter key is refused and lands on the parameters section",
			typo.status === 400 && typeof typoFields.params === "string",
			`status ${typo.status}, fields ${JSON.stringify(Object.keys(typoFields))}`,
		);

		/**
		 * Switching the action retires the old one's parameters. The form sends `action` with a
		 * `params` built from the NEW action's (empty) field list, which is `null` — and the server
		 * agrees that is what replacing an action means.
		 */
		const repointedCode = await client("PATCH", `/api/v1/feature-codes/${parkCodeId}`, {
			action: "redial",
			params: buildParamsBody(paramFieldsFor(fields, "redial"), { lotId }),
		});
		check(
			"changing the action clears the parameters the old one was pointed at",
			repointedCode.status === 200 && !data(repointedCode).params,
			`status ${repointedCode.status}, params ${JSON.stringify(data(repointedCode).params)}`,
		);

		await client("PATCH", `/api/v1/feature-codes/${parkCodeId}`, {
			action: "call-park",
			params: buildParamsBody(parkFields, { lotId }),
		});

		/**
		 * `feature_code.params.lotId` names a lot from inside a `jsonb` column, so no foreign key can
		 * express it and the generic reverse scan cannot see it. The API has a dedicated scan for
		 * exactly this, which is what makes the park-lot delete confirmation's copy true.
		 */
		const refusedLot = await client("DELETE", `/api/v1/park-lots/${lotId}`);
		const lotReferences: readonly EntityReference[] = pbxReferences(asApiError(refusedLot));
		check(
			"deleting a lot a call-park code pins is refused, naming the code",
			refusedLot.status === 409 &&
				lotReferences.some((reference) => reference.kind === "feature-code"),
			`status ${refusedLot.status}, ${lotReferences.map((r) => r.kind).join(", ")}`,
		);
		check(
			"and that referrer resolves to the feature-codes tab, prefilled",
			lotReferences.every((reference) => referenceHref(reference) !== undefined),
			lotReferences.map((reference) => referenceHref(reference) ?? "—").join(", "),
		);

		// --- 15. tear the T2 fixture down, in dependency order -------------------------------------
		console.log("\n15. delete the T2 fixture");
		await client("DELETE", `/api/v1/feature-codes/${parkCodeId}`);
		const lotDeleted = await client("DELETE", `/api/v1/park-lots/${lotId}`);
		check(
			"delete park lot -> 200 once no code pins it",
			lotDeleted.status === 200,
			`status ${lotDeleted.status}`,
		);
		const conferenceDeleted = await client("DELETE", `/api/v1/conferences/${conferenceId}`);
		check(
			"delete conference -> 200",
			conferenceDeleted.status === 200,
			`status ${conferenceDeleted.status}`,
		);
		const tierDeleted = await client("DELETE", `/api/v1/queues/${queueId}/tiers/${tierId}`);
		check("delete membership -> 200", tierDeleted.status === 200, `status ${tierDeleted.status}`);
		const agentDeleted = await client("DELETE", `/api/v1/queue-agents/${agentId}`);
		check("delete agent -> 200", agentDeleted.status === 200, `status ${agentDeleted.status}`);
		const queueDeleted = await client("DELETE", `/api/v1/queues/${queueId}`);
		check("delete queue -> 200", queueDeleted.status === 200, `status ${queueDeleted.status}`);
		await client("DELETE", `/api/v1/extensions/${agentExtensionId}`);

		// --- 13. the carrier surface ---------------------------------------------------------------
		//
		// Driven through the Next origin like everything else, against the in-package fake carrier.
		// The claim is the frontend's, not the API's: that the bodies `lib/carrier/client.ts` builds
		// are accepted, and that the shapes it destructures are the shapes that come back.
		console.log("\n13. the carrier surface");

		const carrierStatus = await client("GET", "/api/v1/carrier/status");
		check(
			"carrier status is readable",
			carrierStatus.status === 200,
			`status ${carrierStatus.status}`,
		);
		const statusBody = (carrierStatus.body.data ?? {}) as Record<string, unknown>;
		check(
			"the carrier reports itself configured, with a SIP domain the UI can show",
			statusBody.configured === true && typeof statusBody.sipDomain === "string",
			String(statusBody.sipDomain),
		);

		const numberSearch = await client(
			"GET",
			"/api/v1/carrier/available-numbers?country=US&areaCode=212&limit=2",
		);
		check("number search is 200", numberSearch.status === 200, `status ${numberSearch.status}`);
		const offered = Array.isArray(numberSearch.body.data)
			? (numberSearch.body.data as Record<string, unknown>[])
			: [];
		/**
		 * The frontend's field names, not the carrier's. `OrderNumberPanel` reads `e164`,
		 * `monthlyCost` and `features`; a response carrying `phone_number` and `cost_information`
		 * would render an empty table with no error, which is the failure this catches.
		 */
		check(
			"search results use the shape the order panel reads",
			offered.length === 2 &&
				typeof offered[0]?.e164 === "string" &&
				Array.isArray(offered[0]?.features),
			Object.keys(offered[0] ?? {}).join(","),
		);

		const orderTarget = String(offered[0]?.e164 ?? "");
		const ordered = await client("POST", "/api/v1/carrier/number-orders", {
			e164: orderTarget,
			label: "Smoke ordered",
			...writeDestination({ type: "hangup", ref: null, data: null }, ""),
		});
		check("ordering a searched number is 201", ordered.status === 201, `status ${ordered.status}`);
		const orderedRow = (ordered.body.data ?? {}) as Record<string, unknown>;
		check(
			"the ordered row carries the carrier badge the list renders",
			orderedRow.carrierProvider === "telnyx" && typeof orderedRow.carrierRef === "string",
			String(orderedRow.carrierProvider),
		);
		check(
			"the order envelope carries warnings, like every other mutation",
			Array.isArray(ordered.body.warnings),
			JSON.stringify(ordered.body.warnings),
		);

		/**
		 * The destination trio is required on the order for the same reason it is on the number form:
		 * a DID that bills monthly and rings nobody is the worst version of an unset destination. The
		 * panel validates it client-side, so this proves the server agrees rather than trusting it.
		 */
		const withoutDestination = await client("POST", "/api/v1/carrier/number-orders", {
			e164: String(offered[1]?.e164 ?? ""),
			label: "No destination",
		});
		check(
			"an order with no destination is refused",
			withoutDestination.status === 400,
			`status ${withoutDestination.status}`,
		);
		check(
			"and it maps to a form field rather than to nothing",
			Object.keys(pbxFieldErrors(asApiError(withoutDestination))).length > 0,
			JSON.stringify(Object.keys(pbxFieldErrors(asApiError(withoutDestination)))),
		);

		const provisionTrunkTarget = await client("POST", "/api/v1/trunks", {
			name: `Smoke carrier trunk ${RUN_ID}`,
			sipDomain: "unprovisioned.invalid",
			sipProxy: "sip:unprovisioned.invalid:5060",
		});
		const provisionTrunkId = rowId(provisionTrunkTarget);
		const provisioned = await client(
			"POST",
			`/api/v1/trunks/${provisionTrunkId}/provision-telnyx`,
			{},
		);
		check(
			"provisioning a trunk is 201",
			provisioned.status === 201,
			`status ${provisioned.status}`,
		);
		const credentials = (provisioned.body.carrier ?? {}) as Record<string, unknown>;
		/**
		 * Every field the provisioning panel renders, present in one check: a missing one is a blank
		 * row in the "shown once" box, and the password is the one thing that cannot be re-read from
		 * this side afterwards.
		 */
		check(
			"the response carries every credential the panel shows",
			typeof credentials.sipUri === "string" &&
				typeof credentials.sipUsername === "string" &&
				typeof credentials.sipPassword === "string" &&
				typeof credentials.registerExpiresSeconds === "number" &&
				credentials.reprovisioned === false,
			Object.keys(credentials).join(","),
		);

		const provisionedTrunkPage = await page(webUrl, `/trunks/${provisionTrunkId}`, jar);
		check(
			"the provisioned trunk's detail page renders",
			provisionedTrunkPage.status === 200,
			`status ${provisionedTrunkPage.status}`,
		);

		const releasedNumber = await client(
			"DELETE",
			`/api/v1/carrier/numbers/${String(orderedRow.id)}`,
		);
		check(
			"releasing a carrier number is 200",
			releasedNumber.status === 200,
			`status ${releasedNumber.status}`,
		);
		/**
		 * Specifically NOT "no warnings at all".
		 *
		 * Compile-on-write returns every warning the organization's configuration currently carries,
		 * and the demo fixture ships several — extensions with voicemail enabled and no mailbox. So
		 * the claim that matters is narrower and truer: the release itself did not add one. A
		 * `carrier-release-failed` warning means the row is gone here but the number is still billed
		 * there, which is the one outcome this check exists to catch.
		 */
		check(
			"the release added no carrier warning, so the number really went back",
			!warningCodes(releasedNumber).some((code) => code.startsWith("carrier-release")),
			warningCodes(releasedNumber).join(","),
		);
		await client("DELETE", `/api/v1/trunks/${provisionTrunkId}`);

		// --- 9. the voicemail mailbox surface -----------------------------------------------------
		//
		// The messages drawer and the PIN dialog are the two things on the voicemail screen that talk
		// to endpoints the rest of the PBX area does not. Both are dialogs, so there is no route to
		// render and no server-side HTML to assert against — what this can prove at fetch level is
		// that the CONTRACT behind them is the one the components were written against, through the
		// Next rewrite the browser would use.
		console.log("\n9. the voicemail mailbox surface");
		const smokeMailbox = await client("POST", "/api/v1/voicemail-boxes", {
			mailboxNumber: "7451",
			label: "Smoke mailbox",
		});
		const smokeMailboxId = rowId(smokeMailbox);
		check(
			"create a mailbox through the rewrite is 201",
			smokeMailbox.status === 201,
			`status ${smokeMailbox.status}`,
		);
		check(
			"the row the list renders carries no PIN digest",
			!Object.hasOwn(data(smokeMailbox), "pinHash"),
			Object.keys(data(smokeMailbox)).join(","),
		);

		const smokeMessages = await client(
			"GET",
			`/api/v1/voicemail-boxes/${smokeMailboxId}/messages`,
		);
		check(
			"the messages drawer's list endpoint answers",
			smokeMessages.status === 200,
			`status ${smokeMessages.status}`,
		);
		const smokeMailboxSummary = (smokeMessages.body.mailbox ?? {}) as Record<string, unknown>;
		check(
			"and carries the counts the drawer's header renders",
			smokeMailboxSummary.newCount === 0 && smokeMailboxSummary.savedCount === 0,
			JSON.stringify(smokeMailboxSummary),
		);

		const smokeWeakPin = await client("POST", `/api/v1/voicemail-boxes/${smokeMailboxId}/pin`, {
			pin: "1111",
		});
		check(
			"the PIN dialog's weak-PIN case reads as a form error, not as a crash",
			smokeWeakPin.status === 400 && typeof smokeWeakPin.body.message === "string",
			`status ${smokeWeakPin.status}`,
		);
		const smokeSetPin = await client("POST", `/api/v1/voicemail-boxes/${smokeMailboxId}/pin`, {
			pin: "72609",
		});
		check(
			"setting a PIN answers with pinSet and never the digest",
			smokeSetPin.status === 201 &&
				data(smokeSetPin).pinSet === true &&
				!Object.hasOwn(data(smokeSetPin), "pinHash"),
			JSON.stringify(data(smokeSetPin)),
		);
		const smokeClearPin = await client(
			"DELETE",
			`/api/v1/voicemail-boxes/${smokeMailboxId}/pin`,
		);
		check(
			"clearing it answers with pinSet false",
			smokeClearPin.status === 200 && data(smokeClearPin).pinSet === false,
			JSON.stringify(data(smokeClearPin)),
		);
		await client("DELETE", `/api/v1/voicemail-boxes/${smokeMailboxId}`);
	} finally {
		next?.kill("SIGTERM");
		apiProcess.kill("SIGTERM");
		await fakeTelnyx.close();
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

function firstId(response: JsonResponse): string {
	const value = response.body.data;
	if (!Array.isArray(value) || value.length === 0) {
		return "";
	}
	const first = value[0] as Record<string, unknown>;
	return typeof first.id === "string" ? first.id : "";
}

await main();
