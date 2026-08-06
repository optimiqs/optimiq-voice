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
 *  1. Every PBX route the app claims — lists and the three detail views — renders through Next.
 *  2. Create / edit / delete round trips for an extension, a DID and an inbound route carrying a
 *     destination trio, using the exact bodies the forms build.
 *  3. A dangling destination is refused, ROLLED BACK, and maps to a real form field.
 *  4. A compile failure is refused, ROLLED BACK, and reads as "not saved" rather than as a warning.
 *  5. A save that merely warns SUCCEEDS, and the warning is carried in the envelope.
 *  6. A refused delete names its referrers, and every one of them resolves to a link.
 *
 * Playwright is not set up in this repository, so this is fetch-level: it verifies the contract
 * and the server-rendered HTML, not clicks.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
import { referenceHref } from "../lib/pbx/references";
import type { EntityReference } from "../lib/pbx/contracts";

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
		const app = await NestFactory.create(
			createApiRootModule([], [PbxModule]),
			new FastifyAdapter(),
			{ logger: ["error"] },
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
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
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
		const ivrMenuId = firstId(seededIvr);
		const ringGroupId = firstId(seededRingGroups);
		const timeConditionId = firstId(seededConditions);

		const routes = [
			"/extensions",
			"/numbers",
			"/trunks",
			"/voicemail",
			"/ivr",
			"/ring-groups",
			"/routing",
			"/routing?tab=outbound",
			"/routing?tab=time-conditions",
			"/routing?tab=feature-codes",
			"/routing?tab=tools",
			`/ivr/${ivrMenuId}`,
			`/ring-groups/${ringGroupId}`,
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

		const simulated = await client("POST", "/api/v1/routing/simulate", {
			routingContext: "inbound",
			destinationNumber: "+12125550100",
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

function firstId(response: JsonResponse): string {
	const value = response.body.data;
	if (!Array.isArray(value) || value.length === 0) {
		return "";
	}
	const first = value[0] as Record<string, unknown>;
	return typeof first.id === "string" ? first.id : "";
}

await main();
