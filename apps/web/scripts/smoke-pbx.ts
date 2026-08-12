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
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
 * A `multipart/form-data` upload, through the Next origin the browser uses.
 *
 * Built with the platform's own `FormData` and `Blob`, and — critically — with NO `content-type`
 * header: the runtime derives it from the body and appends the boundary token, and a hand-written
 * one cannot contain a boundary we do not know. That is exactly the constraint `apiUpload` in
 * `lib/api-client.ts` has to honour, which is why the smoke reproduces it rather than shortcutting
 * to a hand-built body. If the rewrite ever mangled a multipart request, this is what would notice.
 */
function makeUploader(baseUrl: string, jar: CookieJar) {
	return async (
		path: string,
		file: { readonly bytes: Uint8Array; readonly name: string; readonly type: string },
		fields: Readonly<Record<string, string>> = {},
	): Promise<JsonResponse> => {
		const form = new FormData();
		form.append(
			"file",
			new Blob([file.bytes as unknown as BlobPart], { type: file.type }),
			file.name,
		);
		for (const [key, value] of Object.entries(fields)) {
			form.append(key, value);
		}
		const headers: Record<string, string> = { accept: "application/json" };
		const cookie = jar.header();
		if (cookie) {
			headers.cookie = cookie;
		}
		const response = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers,
			redirect: "manual",
			body: form,
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

type Uploader = ReturnType<typeof makeUploader>;

/**
 * A minimal, VALID RIFF/WAVE file: 16-bit signed PCM, 8 kHz, mono.
 *
 * Generated rather than checked in as a binary fixture, because the server sniffs MAGIC BYTES and
 * refuses anything it cannot play — a fixture of zeroes named `.wav` would be refused, correctly,
 * and the upload path would never be exercised. A quiet ramp rather than silence so a truncated
 * body shows up as a wrong byte value rather than as another zero.
 */
function makeWav(samples = 800): Uint8Array {
	const dataBytes = samples * 2;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	const ascii = (offset: number, text: string): void => {
		for (let index = 0; index < text.length; index += 1) {
			view.setUint8(offset + index, text.charCodeAt(index));
		}
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 8000, true);
	view.setUint32(28, 16_000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	for (let index = 0; index < samples; index += 1) {
		view.setInt16(44 + index * 2, (index % 256) - 128, true);
	}
	return new Uint8Array(buffer);
}

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
	 * A real directory for the media library's uploads.
	 *
	 * Section 16 stats nothing on disk — it drives the API through the Next rewrite, which is the
	 * whole point of a smoke — but the API does write there, and pointing it at a production mount
	 * that does not exist would turn every upload into an `EACCES` that reads as a bug in the upload
	 * path. Removed in the `finally`, along with everything else this run created.
	 */
	const mediaRoot = await mkdtemp(join(tmpdir(), "optimiq-smoke-media-"));

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
		// The PBX area's own bootstrap, which registers \`@fastify/multipart\` on the adapter — the
		// media library's upload routes answer 415 without it, and a Fastify plugin cannot be
		// registered from a Nest module (see \`pbx-bootstrap.ts\`). It is a logged no-op for the NATS
		// half here, because this smoke runs no broker.
		const { registerPbxTransport } = await import("./src/pbx/pbx-bootstrap.ts");
		const { PbxModule } = await import("./src/pbx/pbx.module.ts");
		// Provisioning rides on the PBX area and is gated on the same two conditions; see
		// \`apps/api/src/main.ts\`. Mounting it here is what makes the devices screen's CONTRACT
		// checkable rather than only its markup.
		const { ProvisioningModule } = await import("./src/provisioning/provisioning.module.ts");
		// \`warn\` is on because development email delivery is a LOGGING stub — the one-time
		// verification link is written to the log rather than sent, and section 12 needs it to put a
		// second real member in the organization. See \`apps/api/src/auth/auth-email.delivery.ts\`.
		const app = await NestFactory.create(
			createApiRootModule([], [PbxModule, ProvisioningModule]),
			new FastifyAdapter(),
			{ logger: ["error", "warn"] },
		);
		app.enableShutdownHooks();
		await registerAuthTransport(app);
		await registerPbxTransport(app);
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
				/**
				 * Provisioning, configured. Without these the render endpoint answers 503 and the mint
				 * endpoint refuses — which is a state worth rendering, and the devices screen shows it as
				 * a banner, but it is not the state this section is about.
				 *
				 * `PROVISION_BASE_URL` is the API's own origin rather than the web app's: a phone fetches
				 * its configuration from wherever the SIP edge is published, which is not the hostname an
				 * administrator signs in to.
				 */
				PROVISION_SIP_SERVER: "pbx.smoke.optimiq.test",
				PROVISION_SIP_SECRET_KEY: "smoke-provisioning-root-key-0123456789",
				PROVISION_BASE_URL: apiUrl,
				/**
				 * A real, writable object root for the media library.
				 *
				 * The default (`/opt/optimiq-voice/recordings`) is a production mount that does not
				 * exist here, and an upload into it would fail with an `EACCES` that reads as a bug in
				 * the upload path rather than as a missing directory. The signing secret is the media
				 * route's — without one, minting a preview link is a named 503 rather than an
				 * unsigned fallback, which is correct and is not what section 16 is testing.
				 */
				PBX_MEDIA_OBJECT_ROOT: mediaRoot,
				PBX_VOICEMAIL_MEDIA_ROOT: mediaRoot,
				PBX_VOICEMAIL_URL_SECRET: "smoke-pbx-media-signing-secret-0123456789",
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
		const upload: Uploader = makeUploader(webUrl, jar);
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
			"/devices",
			// The profiles tab is a second view of the same subject rather than a second route, so a
			// tab that 404s or crashes would otherwise be invisible to a route list.
			"/devices?tab=profiles",
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
			// Paging groups, gated by `paging-groups.read` — which the owner used here holds. Only the
			// list is asserted: a group's detail view needs an id, and the seed does not create one.
			"/paging-groups",
			"/queues",
			"/queues?tab=agents",
			"/conferences",
			// The live moderation surface, and the only tab on this page that opens a WebSocket. It is
			// a `?tab=` view of one subject rather than a route, so a tab that 404s or crashes would
			// otherwise be invisible to a route list — and this one renders nothing at all until the
			// live topic answers, which is exactly the shape of failure a smoke run should catch.
			"/conferences?tab=live",
			"/park-lots",
			// The media library, and its second tab. Both are `?tab=` views of one page, so a tab
			// that 404s or crashes would otherwise be invisible to a route list.
			"/media",
			"/media?tab=prompts",
			"/routing",
			"/routing?tab=outbound",
			"/routing?tab=time-conditions",
			// Number translations, the sixth Routing tab. It rides `routes.*` rather than
			// `dial-plan.*` — a ruleset is only meaningful attached to a route or a trunk — which is
			// why it is here and not on `/dial-plan`.
			"/routing?tab=translations",
			"/routing?tab=feature-codes",
			"/routing?tab=tools",
			`/ivr/${ivrMenuId}`,
			`/ring-groups/${ringGroupId}`,
			`/queues/${seededQueueId}`,
			`/routing/time-conditions/${timeConditionId}`,
			// The T2 admin block. Call flows and the authorisation codes are routes of their own
			// because they are gated by resources of their own (`call-flows.*`, `pin-sets.*`); the
			// four dial-plan tables share `dial-plan.*` and are therefore tabs of one page, so a tab
			// that 404s or crashes would otherwise be invisible to a route list. The owner used here
			// holds all three families.
			"/call-flows",
			"/pin-sets",
			"/dial-plan",
			"/dial-plan?tab=streams",
			"/dial-plan?tab=directories",
			"/dial-plan?tab=speed-dials",
			// Caller screening, gated by `call-block.read` — a route of its own rather than a fifth
			// tab of `/routing`, because the two are gated by different resources. The owner used
			// here holds it.
			"/call-block",
			// The settings sub-screens, which are real routes rather than tabs.
			"/settings/emergency-addresses",
			// The organization quotas. Gated by `org-limits.read`, which is the only tab in the
			// settings area whose permission is not a settings grant — a 200 here proves the route
			// map agrees with `OrgLimitsController` about that.
			"/settings/limits",
			// The `recordings` category of the settings cascade. Reads on `settings.read` and saves
			// on `recordings.configure` — the only category with a per-category permission override,
			// so a 200 here proves the read side of that split as well as the route.
			"/settings/recordings",
			// The user level of the cascade, gated by `settings.read.own`. It renders before its
			// first request resolves, so a 200 proves the route and the shell; the `GET …/me`
			// contract is exercised below.
			"/settings/me",
			// The SIP security area and its second tab. The auth-failure ledger is only reachable —
			// and only renderable — through the query state, so a tab that 404s or crashes would
			// otherwise be invisible to a route list. Both are gated by `security.read`, which the
			// owner used here holds.
			"/security",
			"/security?tab=auth-failures",
			// The change ledger (`audit.read`) and the webhook subscriptions (`webhooks.read`). Both
			// render before their first request resolves, so a 200 here proves the route and the shell,
			// not the endpoint — the endpoint contracts are asserted by `lib/pbx/*.spec.ts` against the
			// DTOs they mirror.
			"/audit-log",
			"/webhooks",
			/**
			 * The wallboard and one queue's operator panel.
			 *
			 * Both are gated by `queues.monitor` alone — the panel inherits it by ancestry — which is
			 * neither `queues.read` nor `cdr.read`, and a 200 here is what proves the route map agrees
			 * with `live-topics.ts` and the cdr controller about that. The owner used here holds all
			 * three, so this asserts the ROUTE rather than the narrowest role; the permission split
			 * itself is asserted in `lib/page-permissions.spec.ts`.
			 *
			 * The panel is included with a real id rather than left to the list: it is the only screen
			 * in the app that mounts a live topic AND a cdr aggregate on first paint, and a crash in
			 * either would be invisible to a route list that stopped at the index.
			 */
			"/wallboard",
			`/wallboard/${seededQueueId}`,
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
			/**
			 * A record POLICY, not the `recordEnabled` boolean this body used to carry.
			 *
			 * The column was replaced and `createQueueDto` is a `strictObject`, so the old key is now a
			 * 400 naming it rather than a field quietly ignored — which is exactly what the queue form
			 * was sending until this wave. Sending the new spelling here is what keeps the smoke and the
			 * dialog telling the same story.
			 */
			recordPolicy: "none",
			/** Upper-cased by the DTO before validation, so this is also the normalisation's smoke. */
			exitKey: "2",
			defaultPriority: 0,
			enabled: true,
			// The queue form's own trio writer, so the smoke exercises the code the dialog runs — now
			// for BOTH of the queue's trios, which is the only row in the schema carrying two optional
			// ones.
			...writeDestination({ type: "extension", ref: agentExtensionId, data: null }, "timeout"),
			...writeDestination({ type: "hangup", ref: null, data: null }, "exit"),
		});
		const queueId = rowId(queue);
		check(
			"create queue -> 201 with the settings the dialog sends",
			queue.status === 201 &&
				data(queue).strategy === "longest-idle" &&
				data(queue).recordPolicy === "none" &&
				data(queue).exitKey === "2" &&
				data(queue).exitDestinationType === "hangup",
			`status ${queue.status}, ${JSON.stringify({
				recordPolicy: data(queue).recordPolicy,
				exitKey: data(queue).exitKey,
				exitDestinationType: data(queue).exitDestinationType,
			})}`,
		);

		/**
		 * The boolean the column no longer has. A strict object answers it with a 400 rather than
		 * dropping it, which is the whole reason the mirror had to change rather than being left to
		 * "the server will ignore what it does not know".
		 */
		const staleBoolean = await client("PATCH", `/api/v1/queues/${queueId}`, {
			recordEnabled: true,
		});
		check(
			"the recordEnabled boolean is refused outright, not silently ignored",
			staleBoolean.status === 400,
			`status ${staleBoolean.status}`,
		);

		/** One character, and one a phone can send. The engine compares it with `===`. */
		const badExitKey = await client("PATCH", `/api/v1/queues/${queueId}`, { exitKey: "22" });
		check(
			"a multi-digit exit key is refused, as the form refuses it",
			badExitKey.status === 400,
			`status ${badExitKey.status}`,
		);

		const lowerExitKey = await client("PATCH", `/api/v1/queues/${queueId}`, { exitKey: "d" });
		check(
			"a lower-case DTMF letter is upper-cased rather than rejected",
			lowerExitKey.status === 200 && data(lowerExitKey).exitKey === "D",
			`status ${lowerExitKey.status}, exitKey ${JSON.stringify(data(lowerExitKey).exitKey)}`,
		);

		/** Higher dequeues first, on the 0-1000 scale `queue.caller.joined` already publishes on. */
		const outOfRangePriority = await client("PATCH", `/api/v1/queues/${queueId}`, {
			defaultPriority: 1001,
		});
		check(
			"the caller-priority scale stops at 1000, as the mirror says",
			outOfRangePriority.status === 400,
			`status ${outOfRangePriority.status}`,
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
			recordPolicy: "none",
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
		 * The edit form still omits the PIN columns, and the API still refuses them.
		 *
		 * That has NOT changed now that the set-PIN endpoints exist — it is the whole point of them.
		 * A `PATCH` body that sometimes carries a digest is a `PATCH` body somebody eventually puts a
		 * plaintext PIN into, and a digest an admin pasted in is a digest nothing hashed. The dialog
		 * has no PIN control; the two dedicated dialogs do, and they are checked below.
		 */
		const pinned = await client("PATCH", `/api/v1/conferences/${conferenceId}`, {
			pinHash: "0123456789abcdef",
		});
		check(
			"a PIN digest is still refused by the DTO, which is why the edit form has no PIN control",
			pinned.status === 400,
			`status ${pinned.status}`,
		);

		/**
		 * The two PIN dialogs' contract.
		 *
		 * Both are dialogs, so there is no route to render and no server-side HTML to assert against
		 * — what this proves at fetch level is that the shape the components were written against is
		 * the shape the server answers with, through the Next rewrite the browser would use.
		 */
		const smokeWeakRoomPin = await client("POST", `/api/v1/conferences/${conferenceId}/pin`, {
			pin: "1111",
		});
		check(
			"the room-PIN dialog's weak-PIN case reads as a form error, not as a crash",
			smokeWeakRoomPin.status === 400 && typeof smokeWeakRoomPin.body.message === "string",
			`status ${smokeWeakRoomPin.status}`,
		);
		const smokeRoomPin = await client("POST", `/api/v1/conferences/${conferenceId}/pin`, {
			pin: "72609",
		});
		check(
			"setting a room PIN answers with both flags and never a digest",
			smokeRoomPin.status === 201 &&
				data(smokeRoomPin).pinSet === true &&
				data(smokeRoomPin).moderatorPinSet === false &&
				!Object.hasOwn(data(smokeRoomPin), "pinHash"),
			JSON.stringify(data(smokeRoomPin)),
		);
		const smokeModeratorPin = await client(
			"POST",
			`/api/v1/conferences/${conferenceId}/moderator-pin`,
			{ pin: "51937" },
		);
		check(
			"setting a moderator PIN reports both flags, so one dialog can render the other's state",
			smokeModeratorPin.status === 201 &&
				data(smokeModeratorPin).pinSet === true &&
				data(smokeModeratorPin).moderatorPinSet === true,
			JSON.stringify(data(smokeModeratorPin)),
		);
		const smokeClearedRoomPin = await client("DELETE", `/api/v1/conferences/${conferenceId}/pin`);
		check(
			"clearing the room PIN answers pinSet false and leaves the moderator PIN alone",
			smokeClearedRoomPin.status === 200 &&
				data(smokeClearedRoomPin).pinSet === false &&
				data(smokeClearedRoomPin).moderatorPinSet === true,
			JSON.stringify(data(smokeClearedRoomPin)),
		);
		await client("DELETE", `/api/v1/conferences/${conferenceId}/moderator-pin`);
		const conferenceRow = await client("GET", `/api/v1/conferences/${conferenceId}`);
		check(
			"and neither digest is ever on a conference row the list renders",
			!Object.hasOwn(data(conferenceRow), "pinHash") &&
				!Object.hasOwn(data(conferenceRow), "moderatorPinHash"),
			Object.keys(data(conferenceRow)).join(","),
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

		const smokeMessages = await client("GET", `/api/v1/voicemail-boxes/${smokeMailboxId}/messages`);
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
		const smokeClearPin = await client("DELETE", `/api/v1/voicemail-boxes/${smokeMailboxId}/pin`);
		check(
			"clearing it answers with pinSet false",
			smokeClearPin.status === 200 && data(smokeClearPin).pinSet === false,
			JSON.stringify(data(smokeClearPin)),
		);
		// --- 16. the media library: upload, preview, seek --------------------------------------------
		//
		// The platform's first file-upload path, and the first `<audio>` that can be scrubbed. Three
		// things are worth proving at fetch level, and none of them is provable from a rendered page:
		//
		//  1. **A multipart body survives the Next rewrite.** Everything else the smokes drive is
		//     JSON, so this is the only request whose content type carries a generated boundary. A
		//     proxy that rewrote or buffered it wrongly would break uploads in the browser only.
		//  2. **The magic-byte refusal is a form error, not a crash.** The upload dialogs render the
		//     server's sentence under the file input, so the taxonomy has to hold.
		//  3. **The preview link answers a Range request.** The `<audio>` element decides whether its
		//     scrub bar works from `accept-ranges` on the first response and from a `206` on the
		//     second — so both have to be true through the rewrite, not just against the API.
		console.log("\n16. the media library");
		const wav = makeWav();

		const smokeMohClass = await client("POST", "/api/v1/moh-classes", {
			name: `smoke-hold-${RUN_ID}`,
			description: "Smoke",
		});
		const smokeMohClassId = rowId(smokeMohClass);
		check(
			"create a hold-music class through the rewrite is 201",
			smokeMohClass.status === 201,
			`status ${smokeMohClass.status}`,
		);

		const smokeUpload = await upload(
			`/api/v1/moh-classes/${smokeMohClassId}/files`,
			{ bytes: wav, name: "hold-loop.wav", type: "audio/wav" },
			{ name: `smoke-loop-${RUN_ID}` },
		);
		check(
			"a multipart upload survives the Next rewrite and is stored",
			smokeUpload.status === 201 && typeof data(smokeUpload).objectKey === "string",
			`status ${smokeUpload.status} ${String(data(smokeUpload).objectKey ?? "")}`,
		);
		const smokeFileId = rowId(smokeUpload);

		const smokeBadUpload = await upload(`/api/v1/moh-classes/${smokeMohClassId}/files`, {
			// A DOS/PE header renamed `.wav` and declared `audio/wav` — the case the sniffer exists
			// for, and the case the dialog has to render as a sentence under the file input.
			bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			name: "trojan.wav",
			type: "audio/wav",
		});
		check(
			"a file that is not audio is refused as a form error the dialog can render",
			smokeBadUpload.status === 400 &&
				pbxErrorCode(asApiError(smokeBadUpload)) === "MEDIA_UPLOAD_REJECTED" &&
				typeof smokeBadUpload.body.message === "string",
			`status ${smokeBadUpload.status} ${String(smokeBadUpload.body.code)}`,
		);

		const smokeFiles = await client("GET", `/api/v1/moh-classes/${smokeMohClassId}/files`);
		check(
			"the files dialog's list endpoint answers with exactly what was accepted",
			smokeFiles.status === 200 && listLength(smokeFiles) === 1,
			`status ${smokeFiles.status}, ${String(listLength(smokeFiles))} file(s)`,
		);

		const smokePlayUrl = await client("POST", `/api/v1/prompts/${smokeFileId}/play-url`);
		const smokeMediaPath = String((data(smokePlayUrl) as { url?: unknown }).url ?? "");
		check(
			"minting a preview link answers with a path the player can use verbatim",
			smokePlayUrl.status === 201 && smokeMediaPath.startsWith("/api/v1/prompts/media?token="),
			`status ${smokePlayUrl.status} ${smokeMediaPath.slice(0, 40)}`,
		);

		const smokeFull = await fetch(`${webUrl}${smokeMediaPath}`, { redirect: "manual" });
		const smokeFullBody = new Uint8Array(await smokeFull.arrayBuffer());
		check(
			"the preview link streams the whole object through the rewrite",
			smokeFull.status === 200 && smokeFullBody.length === wav.length,
			`status ${smokeFull.status}, ${String(smokeFullBody.length)}/${String(wav.length)} bytes`,
		);
		check(
			"and advertises accept-ranges: bytes, which is what makes the scrub bar draggable at all",
			smokeFull.headers.get("accept-ranges") === "bytes",
			String(smokeFull.headers.get("accept-ranges")),
		);

		const smokeRange = await fetch(`${webUrl}${smokeMediaPath}`, {
			headers: { range: "bytes=44-75" },
			redirect: "manual",
		});
		const smokeRangeBody = new Uint8Array(await smokeRange.arrayBuffer());
		check(
			"a seek is answered 206 with the range's own content-length and exactly those bytes",
			smokeRange.status === 206 &&
				smokeRange.headers.get("content-range") === `bytes 44-75/${String(wav.length)}` &&
				smokeRange.headers.get("content-length") === "32" &&
				smokeRangeBody.length === 32,
			`status ${smokeRange.status} ${String(smokeRange.headers.get("content-range"))}`,
		);

		const smokePastEnd = await fetch(`${webUrl}${smokeMediaPath}`, {
			headers: { range: `bytes=${String(wav.length + 10)}-` },
			redirect: "manual",
		});
		void (await smokePastEnd.arrayBuffer());
		check(
			"a seek past the end is a 416 that tells the player the real size",
			smokePastEnd.status === 416 &&
				smokePastEnd.headers.get("content-range") === `bytes */${String(wav.length)}`,
			`status ${smokePastEnd.status} ${String(smokePastEnd.headers.get("content-range"))}`,
		);

		// The greetings dialog's contract: upload, list, and the activate verb.
		const smokeGreeting = await upload(
			`/api/v1/voicemail-boxes/${smokeMailboxId}/greetings`,
			{ bytes: wav, name: "unavailable.wav", type: "audio/wav" },
			{ kind: "unavailable", label: "Smoke greeting" },
		);
		check(
			"a greeting uploads and is active by default, which is what the checkbox promises",
			smokeGreeting.status === 201 && data(smokeGreeting).active === true,
			`status ${smokeGreeting.status}`,
		);
		const smokeGreetingId = rowId(smokeGreeting);
		const smokeDeactivated = await client(
			"POST",
			`/api/v1/voicemail-boxes/${smokeMailboxId}/greetings/${smokeGreetingId}/deactivate`,
		);
		check(
			"standing a greeting down is a verb, and answers with the row the dialog re-renders",
			smokeDeactivated.status === 200 && data(smokeDeactivated).active === false,
			`status ${smokeDeactivated.status}`,
		);
		await client(
			"DELETE",
			`/api/v1/voicemail-boxes/${smokeMailboxId}/greetings/${smokeGreetingId}`,
		);

		// The E911 screen's contract, and the selector the number dialog renders.
		const smokeAddress = await client("POST", "/api/v1/emergency-addresses", {
			label: `Smoke HQ ${RUN_ID}`,
			streetLine1: "1 Telephone Road",
			locationDetail: "Floor 3",
			locality: "Springfield",
			administrativeArea: "IL",
			postalCode: "62701",
			country: "us",
		});
		const smokeAddressId = rowId(smokeAddress);
		check(
			"an emergency address is created and is NOT validated on our say-so",
			smokeAddress.status === 201 &&
				data(smokeAddress).validated === false &&
				data(smokeAddress).country === "US",
			`status ${smokeAddress.status} validated=${String(data(smokeAddress).validated)}`,
		);
		/**
		 * A DID of its own, rather than the one section 5 created.
		 *
		 * That one has been given back to the carrier by section 8, so a `PATCH` against it is a 404 —
		 * and a smoke that reused it would report the E911 selector as broken every time the carrier
		 * section changed. One number, created here, deleted below.
		 */
		const smokeE911Number = await client("POST", "/api/v1/phone-numbers", {
			// `phone_number.e164` is unique PLATFORM-wide, not per tenant, so a smoke that reused a
			// literal would collide with its own previous run. `+1998555<run>` shares the reserved
			// `+1999555…` block section 5 uses, one prefix over.
			e164: `+1998555${RUN_DIGITS}`,
			label: "Smoke E911 DID",
			destinationType: "hangup",
			voiceEnabled: true,
			enabled: true,
		});
		const smokeE911NumberId = rowId(smokeE911Number);
		check(
			"a DID for the E911 checks is created",
			smokeE911Number.status === 201,
			`status ${smokeE911Number.status}`,
		);
		const smokeAssigned = await client("PATCH", `/api/v1/phone-numbers/${smokeE911NumberId}`, {
			emergencyAddressId: smokeAddressId,
		});
		check(
			"the number dialog's emergency selector writes through a plain PATCH",
			smokeAssigned.status === 200 && data(smokeAssigned).emergencyAddressId === smokeAddressId,
			`status ${smokeAssigned.status}`,
		);
		const smokeAddressRefused = await client(
			"DELETE",
			`/api/v1/emergency-addresses/${smokeAddressId}`,
		);
		check(
			"deleting an address a DID uses is refused with the taxonomy the delete dialog decodes",
			smokeAddressRefused.status === 409 &&
				pbxErrorCode(asApiError(smokeAddressRefused)) === "PBX_REFERENCED",
			`status ${smokeAddressRefused.status}`,
		);
		await client("PATCH", `/api/v1/phone-numbers/${smokeE911NumberId}`, {
			emergencyAddressId: null,
		});
		await client("DELETE", `/api/v1/emergency-addresses/${smokeAddressId}`);
		await client("DELETE", `/api/v1/phone-numbers/${smokeE911NumberId}`);

		/**
		 * The hold-music SELECTOR, end to end: the entity forms can now choose a class, and this is
		 * the claim that choosing one reaches the engine.
		 *
		 * A queue of its own, created here. The one section 11 built was deleted in section 15, above,
		 * and a smoke that depended on that ordering would start failing for a reason that has nothing
		 * to do with hold music.
		 *
		 * ## What can honestly be asserted at this level, and what cannot
		 *
		 * Not the artifact. `POST /routing/compile` deliberately answers with
		 * `{organizationId, snapshotHash, compiledAt, cacheKey, published, warnings}` and NOT the
		 * compiled plan — `routing.service.ts` explains why, and the reason is that a large tenant's
		 * artifact is megabytes of JSON nobody asked for. The smoke also runs no NATS broker, so the
		 * KV bucket the artifact is published into cannot be read back either.
		 *
		 * What is left is a HASH DELTA, and it is a real proof rather than a consolation prize:
		 * `snapshotHash` is SHA-256 over the canonical form of the compiler's INPUT, and two snapshots
		 * hash the same exactly when they compile to the same artifact. So a hash that moves when the
		 * queue is pointed at a class means the assignment is an input to the plan; a hash that moves
		 * again when only the class's NAME changes means the name is in there too — which is the fact
		 * that matters on a call, because a media server addresses a class by name and answers a UUID
		 * by silently playing its own default.
		 */
		const mohQueue = await client("POST", "/api/v1/queues", {
			name: `Smoke MOH queue ${RUN_ID}`,
			extensionNumber: `6${RUN_DIGITS}`,
			strategy: "longest-idle",
			enabled: true,
		});
		const mohQueueId = rowId(mohQueue);
		check(
			"a queue for the hold-music round trip is created",
			mohQueue.status === 201,
			`status ${mohQueue.status}`,
		);

		const beforeAssign = await client("POST", "/api/v1/routing/compile", {});
		const hashBeforeAssign = String(data(beforeAssign).snapshotHash ?? "");

		const mohAssigned = await client("PATCH", `/api/v1/queues/${mohQueueId}`, {
			mohClassId: smokeMohClassId,
		});
		check(
			"the queue dialog's hold-music selector writes through a plain PATCH and echoes the id",
			mohAssigned.status === 200 && data(mohAssigned).mohClassId === smokeMohClassId,
			`status ${mohAssigned.status}, mohClassId ${String(data(mohAssigned).mohClassId)}`,
		);

		const afterAssign = await client("POST", "/api/v1/routing/compile", {});
		const hashAfterAssign = String(data(afterAssign).snapshotHash ?? "");
		check(
			"assigning a class changes the snapshot hash, so the assignment reaches the plan",
			afterAssign.status === 200 &&
				hashAfterAssign.length > 0 &&
				hashAfterAssign !== hashBeforeAssign,
			`${hashBeforeAssign.slice(0, 12)} -> ${hashAfterAssign.slice(0, 12)}`,
		);

		const mohRenamed = await client("PATCH", `/api/v1/moh-classes/${smokeMohClassId}`, {
			name: `smoke-hold-renamed-${RUN_ID}`,
		});
		const afterRename = await client("POST", "/api/v1/routing/compile", {});
		const hashAfterRename = String(data(afterRename).snapshotHash ?? "");
		check(
			"renaming the class changes it again, so the NAME the media server needs is an input too",
			mohRenamed.status === 200 &&
				afterRename.status === 200 &&
				hashAfterRename.length > 0 &&
				hashAfterRename !== hashAfterAssign,
			`${hashAfterAssign.slice(0, 12)} -> ${hashAfterRename.slice(0, 12)}`,
		);

		/**
		 * The `scalarReferences` guard. The foreign key is `on delete set null`, so without this the
		 * database would take the delete and quietly return the queue to the media server's default
		 * class — the kind of change nobody notices until a caller mentions the hold music changed.
		 */
		const mohClassRefused = await client("DELETE", `/api/v1/moh-classes/${smokeMohClassId}`);
		const mohClassReferences = pbxReferences(asApiError(mohClassRefused));
		check(
			"deleting a class a queue plays is refused, naming the queue",
			mohClassRefused.status === 409 &&
				pbxErrorCode(asApiError(mohClassRefused)) === "PBX_REFERENCED" &&
				mohClassReferences.some((reference) => reference.kind === "queue"),
			`status ${mohClassRefused.status}, ${mohClassReferences.map((r) => r.kind).join(", ")}`,
		);

		const mohCleared = await client("PATCH", `/api/v1/queues/${mohQueueId}`, {
			mohClassId: null,
		});
		check(
			"an emptied selector sends null and actually clears the column",
			mohCleared.status === 200 && data(mohCleared).mohClassId === null,
			`status ${mohCleared.status}, mohClassId ${JSON.stringify(data(mohCleared).mohClassId)}`,
		);
		await client("DELETE", `/api/v1/queues/${mohQueueId}`);

		await client("DELETE", `/api/v1/moh-classes/${smokeMohClassId}/files/${smokeFileId}`);
		await client("DELETE", `/api/v1/moh-classes/${smokeMohClassId}`);
		await client("DELETE", `/api/v1/voicemail-boxes/${smokeMailboxId}`);

		// --- 17. devices: the provisioning contract, as the screen builds it ------------------------
		console.log("\n17. devices and provisioning");
		await runDeviceChecks(client);

		// --- 18. caller screening: the CRUD the call-block screen is built on ------------------------
		console.log("\n18. call blocking");
		await runCallBlockChecks(client);

		// --- 19. the settings cascade's two new surfaces --------------------------------------------
		console.log("\n19. recording retention and the user cascade");
		await runSettingsCascadeChecks(client);

		// --- 20. the T2 admin block: the verbs that are not a PATCH ----------------------------------
		console.log("\n20. the admin block: call flows, PIN sets, translations, the dial plan, limits");
		await runAdminBlockChecks(client);
	} finally {
		next?.kill("SIGTERM");
		apiProcess.kill("SIGTERM");
		await fakeTelnyx.close();
		await delay(300);
		await rm(mediaRoot, { recursive: true, force: true });
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

/**
 * The devices screen's contract, exercised with the exact bodies the forms build.
 *
 * The interesting claims are the two a unit test cannot make. First, that the create response
 * carries `provisioning.token` — the screen renders a page-level panel off that key and would show
 * nothing at all if the server put it somewhere else. Second, that the row a later read returns
 * carries only the NON-SECRET reference, which is what makes "shown once" a true statement rather
 * than a UI convention.
 */
async function runDeviceChecks(client: Client): Promise<void> {
	const catalog = await client("GET", "/api/v1/provisioning/catalog");
	const vendors = Array.isArray(data(catalog).vendors)
		? (data(catalog).vendors as Record<string, unknown>[])
		: [];
	check(
		"the vendor catalogue is served, so the picker is not hard-coded",
		catalog.status === 200 && vendors.length > 0,
		`${vendors.length} vendors`,
	);
	check(
		"every catalogue entry carries the caveats the form renders beside the vendor",
		vendors.every((entry) => Array.isArray(entry.caveats)),
	);

	const mac = `0015${Date.now().toString(16).slice(-8)}`.slice(0, 12);
	/**
	 * The body `device-dialog.tsx` sends, field for field — including the nulls a cleared optional
	 * text field becomes. A smoke that sent a hand-written body would prove the API works and
	 * nothing about whether the form is talking to it correctly.
	 */
	const created = await client("POST", "/api/v1/devices", {
		macAddress: mac.toUpperCase().replace(/(..)(?=.)/gu, "$1:"),
		vendor: "yealink",
		model: "T54W",
		label: "Smoke device",
		deviceProfileId: null,
		settings: { "local_time.time_zone": "+0" },
		enabled: true,
	});
	const deviceId = rowId(created);
	check(
		"the create body the dialog builds is accepted",
		created.status === 200 || created.status === 201,
		`status ${created.status}`,
	);
	check(
		"the MAC comes back normalized, which is what makes the uniqueness index real",
		data(created).macAddress === mac,
		String(data(created).macAddress),
	);

	const provisioning = created.body.provisioning as Record<string, unknown> | undefined;
	check(
		"create carries the once-only provisioning token the panel renders",
		typeof provisioning?.token === "string" && String(provisioning.token).includes("."),
	);
	check(
		"and the full URL, built from the API's own public base",
		typeof provisioning?.configUrl === "string" &&
			String(provisioning.configUrl).includes("/provision/"),
		String(provisioning?.configUrl),
	);

	const read = await client("GET", `/api/v1/devices/${deviceId}`);
	check(
		"a later read carries only the non-secret reference — 'shown once' is literally true",
		read.status === 200 &&
			typeof data(read).provisioningToken === "string" &&
			!String(provisioning?.token ?? "").startsWith(`${String(data(read).provisioningToken)}.x`) &&
			String(provisioning?.token ?? "").startsWith(`${String(data(read).provisioningToken)}.`),
	);

	const rotated = await client("POST", `/api/v1/devices/${deviceId}/provisioning-token`, {});
	const rotatedToken = (rotated.body.provisioning as Record<string, unknown> | undefined)?.token;
	check(
		"rotating returns a different token, which is what the confirmation dialog promises",
		rotated.status === 201 &&
			typeof rotatedToken === "string" &&
			rotatedToken !== provisioning?.token,
		`status ${rotated.status}`,
	);

	const profile = await client("POST", "/api/v1/device-profiles", {
		name: `Smoke profile ${Date.now().toString(36)}`,
		description: null,
		vendor: "yealink",
		model: null,
		settings: { "features.dnd.enable": "1" },
		enabled: true,
	});
	const profileId = rowId(profile);
	check(
		"the profile body the dialog builds is accepted",
		profile.status === 201,
		`status ${profile.status}`,
	);

	await client("PATCH", `/api/v1/devices/${deviceId}`, { deviceProfileId: profileId });
	const refused = await client("DELETE", `/api/v1/device-profiles/${profileId}`);
	check(
		"deleting a profile in use is refused with the taxonomy the delete dialog decodes",
		refused.status === 409 && pbxErrorCode(asApiError(refused)) === "PBX_REFERENCED",
		`status ${refused.status}`,
	);
	check(
		"and its referrers resolve to links the dialog can render",
		pbxReferences(asApiError(refused)).every(
			(reference: EntityReference) => referenceHref(reference) !== undefined,
		),
	);

	await client("DELETE", `/api/v1/devices/${deviceId}`);
	const cleaned = await client("DELETE", `/api/v1/device-profiles/${profileId}`);
	check(
		"and the profile deletes cleanly once nothing points at it",
		cleaned.status === 200,
		`status ${cleaned.status}`,
	);
}

/** How many rows a list envelope carries. `0` when the body is not a list at all. */
function listLength(response: JsonResponse): number {
	return Array.isArray(response.body.data) ? response.body.data.length : 0;
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

/**
 * Caller screening, exercised with the exact bodies `call-block-rule-dialog.tsx` builds.
 *
 * The claims worth making here are the three no unit test can reach, and all three are about the
 * DTO's deliberate refusals rather than about the happy path:
 *
 * 1. The pattern is validated by the ROUTER, not by the schema. An uncompilable regex has to be a
 *    refusal that ROLLS BACK and addresses `pattern`, because the form renders it on that field —
 *    a 422 that maps to no field is a form that shows nothing.
 * 2. `hitCount` and `lastHitAt` are refused with a 400 rather than dropped, which is why the form
 *    must not send them "for completeness": it would fail every save.
 * 3. Both come back on every read, because "this rule has never matched anything" is the one thing
 *    a screening list can say that no other column can.
 */
async function runCallBlockChecks(client: Client): Promise<void> {
	const pattern = `+1999${RUN_DIGITS}`.slice(0, 16);
	const created = await client("POST", "/api/v1/call-block-rules", {
		pattern,
		matchKind: "exact",
		direction: "inbound",
		action: "block",
		label: "Smoke screening rule",
		enabled: true,
	});
	const ruleId = rowId(created);
	check(
		"the create body the screening dialog builds is accepted",
		created.status === 201 && data(created).pattern === pattern,
		`status ${created.status}`,
	);

	check(
		"and the row comes back with the two counters the screen renders as evidence",
		data(created).hitCount === 0 && data(created).lastHitAt === null,
		`hitCount ${String(data(created).hitCount)}, lastHitAt ${String(data(created).lastHitAt)}`,
	);

	/**
	 * The counters are enforcement's. A form that offered them would not be ignored — it would be
	 * refused, which is why this is a 400 and not a silently dropped key.
	 */
	const forged = await client("PATCH", `/api/v1/call-block-rules/${ruleId}`, { hitCount: 400 });
	check(
		"a forged hit counter is refused by the DTO rather than dropped",
		forged.status === 400,
		`status ${forged.status}`,
	);

	/**
	 * The pattern box has no client-side regex check precisely because this refusal exists. It has
	 * to roll back and it has to name the field, or the dialog renders an error nowhere.
	 */
	const uncompilable = await client("POST", "/api/v1/call-block-rules", {
		pattern: "(",
		matchKind: "regex",
		direction: "inbound",
		action: "block",
		enabled: true,
	});
	const patternErrors = pbxFieldErrors(asApiError(uncompilable));
	check(
		"an uncompilable expression is refused and the message lands on the pattern field",
		uncompilable.status >= 400 && Boolean(patternErrors.pattern),
		`status ${uncompilable.status}, fields ${Object.keys(patternErrors).join(",") || "none"}`,
	);

	const listed = await client("GET", "/api/v1/call-block-rules?page=1&limit=25");
	const rows = Array.isArray(listed.body.data)
		? (listed.body.data as Record<string, unknown>[])
		: [];
	check(
		"the list is the paged envelope the shared list scaffold reads",
		listed.status === 200 &&
			typeof listed.body.total === "number" &&
			rows.some((row) => row.id === ruleId),
		`status ${listed.status}, ${rows.length} rows`,
	);

	/**
	 * The direction is part of the identity — the unique index is `(organization, direction,
	 * pattern)` — so the same number screened outbound is a second row rather than a conflict. The
	 * form offers three directions on exactly that basis.
	 */
	const outbound = await client("POST", "/api/v1/call-block-rules", {
		pattern,
		matchKind: "exact",
		direction: "outbound",
		action: "block",
		enabled: true,
	});
	const duplicate = await client("POST", "/api/v1/call-block-rules", {
		pattern,
		matchKind: "exact",
		direction: "inbound",
		action: "allow",
		enabled: true,
	});
	check(
		"the same pattern in another direction is a new row, and in the same direction a conflict",
		outbound.status === 201 && duplicate.status === 409,
		`outbound ${outbound.status}, duplicate ${duplicate.status}`,
	);

	await client("DELETE", `/api/v1/call-block-rules/${rowId(outbound)}`);
	const removed = await client("DELETE", `/api/v1/call-block-rules/${ruleId}`);
	check(
		"a screening rule deletes cleanly — nothing in the dial plan can point at one",
		removed.status === 200,
		`status ${removed.status}`,
	);
}

/**
 * The `recordings` settings category and the user level of the cascade.
 *
 * Two surfaces, one contract shape, and the interesting claims are about the vocabulary rather than
 * about the round trip: `0` has to mean KEEP FOR EVER on the wire the way the screen says it does,
 * and `PATCH …/me` has to REFUSE an organization-level name by naming it rather than writing a row
 * the resolver would ignore for ever.
 */
async function runSettingsCascadeChecks(client: Client): Promise<void> {
	const read = await client("GET", "/api/v1/org-settings/categories/recordings");
	check(
		"the recordings category resolves with retentionDays present, defaulting to keep-for-ever",
		read.status === 200 && typeof data(read).retentionDays === "number",
		`status ${read.status}, retentionDays ${String(data(read).retentionDays)}`,
	);

	const saved = await client("PATCH", "/api/v1/org-settings/categories/recordings", {
		retentionDays: 30,
	});
	check(
		"the retention window saves through the category facade the form uses",
		saved.status === 200 && data(saved).retentionDays === 30,
		`status ${saved.status}`,
	);

	/** `0` is a value, not an absence — the same vocabulary `CDR_RECORDING_RETENTION_DAYS` uses. */
	const forever = await client("PATCH", "/api/v1/org-settings/categories/recordings", {
		retentionDays: 0,
	});
	const outOfRange = await client("PATCH", "/api/v1/org-settings/categories/recordings", {
		retentionDays: 3_651,
	});
	check(
		"zero is accepted as keep-for-ever and the ten-year ceiling is enforced",
		forever.status === 200 && data(forever).retentionDays === 0 && outOfRange.status === 400,
		`zero ${forever.status}, over ${outOfRange.status}`,
	);

	const own = await client("GET", "/api/v1/org-settings/me");
	const ownData = data(own);
	const notifications = (ownData.notifications ?? {}) as Record<string, unknown>;
	check(
		"GET /org-settings/me answers grouped by category with the user-scoped names resolved",
		own.status === 200 &&
			typeof notifications.voicemailToEmailIncludeLink === "boolean" &&
			typeof notifications.voicemailToEmailIncludeTranscription === "boolean",
		`status ${own.status}, categories ${Object.keys(ownData).join(",") || "none"}`,
	);

	const savedOwn = await client("PATCH", "/api/v1/org-settings/me/categories/notifications", {
		voicemailToEmailIncludeLink: false,
		voicemailToEmailIncludeTranscription: true,
	});
	check(
		"the two preferences the page renders save as a user-level override",
		savedOwn.status === 200 && data(savedOwn).voicemailToEmailIncludeLink === false,
		`status ${savedOwn.status}`,
	);

	/**
	 * The refusal that keeps this page honest. An organization-level name sent to the user endpoint
	 * is a 400 NAMING the setting rather than a `user_setting` row the resolver would ignore for
	 * ever — which is why the page renders only the two the catalogue marks user-scoped, and why a
	 * third control would be a visible failure rather than a silent one.
	 */
	const refused = await client("PATCH", "/api/v1/org-settings/me/categories/notifications", {
		voicemailToEmailEnabled: false,
	});
	const refusedFields = pbxFieldErrors(asApiError(refused));
	check(
		"an organization-level setting sent to the user endpoint is refused and named",
		refused.status === 400 && Boolean(refusedFields.voicemailToEmailEnabled),
		`status ${refused.status}, fields ${Object.keys(refusedFields).join(",") || "none"}`,
	);

	// Put the organization back where the fixture left it, so a second run starts clean.
	await client("PATCH", "/api/v1/org-settings/me/categories/notifications", {
		voicemailToEmailIncludeLink: true,
		voicemailToEmailIncludeTranscription: true,
	});
}

/**
 * The T2 admin block, end to end.
 *
 * Four of the six things this exercises are verbs that are NOT a `PATCH`, and every one of them is
 * a place a screen could be wrong in a way no unit test reaches: a toggle guarded by a different
 * grant from the edit form beside it, an override that lives under `/call-flows` and writes a time
 * condition, a PIN that goes in and never comes back, and a singleton reached without an id.
 *
 * Attaching a PIN set to an outbound route, a ruleset to either end, and a star code to a time
 * condition are all writes now — the four columns the compiler already read gained DTO fields, so
 * the checks below write them and read them back. They used to pin the 400 that proved no DTO
 * declared them, which is what kept those fields read-only on screen; the same checks now fail if a
 * write is ever refused again, which is the direction that matters once the forms are pickers.
 */
async function runAdminBlockChecks(client: Client): Promise<void> {
	// --- named destinations, streams, directories and speed dials ---------------------------------
	const alias = await client("POST", "/api/v1/destination-aliases", {
		name: `Smoke alias ${RUN_ID}`,
		description: "Front desk",
		enabled: true,
		...writeDestination({ type: "hangup", ref: null, data: null }, ""),
	});
	const aliasId = rowId(alias);
	check(
		"the create body the named-destination dialog builds is accepted",
		alias.status === 201 && data(alias).destinationType === "hangup",
		`status ${alias.status}`,
	);

	/**
	 * The security check the stream form restates, proved against the server rather than trusted:
	 * the set of things a tenant may cause the media server to OPEN is a decision about what the
	 * media server will read, and `file://` is a URL.
	 */
	const badStream = await client("POST", "/api/v1/audio-streams", {
		name: `Bad stream ${RUN_ID}`,
		url: "file:///etc/passwd",
		...writeDestination({ type: "hangup", ref: null, data: null }, "fallback"),
	});
	const badStreamFields = pbxFieldErrors(asApiError(badStream));
	check(
		"a non-http stream URL is refused and the message lands on the url field",
		badStream.status === 400 && badStreamFields.url !== undefined,
		`status ${badStream.status}, fields ${Object.keys(badStreamFields).join(",")}`,
	);

	const stream = await client("POST", "/api/v1/audio-streams", {
		name: `Smoke stream ${RUN_ID}`,
		url: "https://stream.example.com/smoke.mp3",
		answerFirst: true,
		maxSeconds: 0,
		enabled: true,
		...writeDestination({ type: "hangup", ref: null, data: null }, "fallback"),
	});
	const streamId = rowId(stream);
	check(
		"a stream's REQUIRED fallback trio round-trips under the prefix the picker writes",
		stream.status === 201 && data(stream).fallbackDestinationType === "hangup",
		`status ${stream.status}`,
	);

	/** The trio is not optional here, unlike every other secondary trio in the area. */
	const noFallback = await client("POST", "/api/v1/audio-streams", {
		name: `No fallback ${RUN_ID}`,
		url: "https://stream.example.com/none.mp3",
	});
	check(
		"a stream with no fallback is refused, which is why the form marks it required",
		noFallback.status === 400 || noFallback.status === 422,
		`status ${noFallback.status}`,
	);

	const directory = await client("POST", "/api/v1/directories", {
		name: `Smoke directory ${RUN_ID}`,
		searchField: "last-name",
		minDigits: 3,
		maxFailures: 3,
		enabled: true,
	});
	const directoryId = rowId(directory);
	check(
		"a directory saves with no member list, because its entries are derived from the extensions",
		directory.status === 201 && data(directory).searchField === "last-name",
		`status ${directory.status}`,
	);

	const speedDial = await client("POST", "/api/v1/speed-dials", {
		code: `*8${RUN_DIGITS.slice(0, 2)}`,
		label: `Smoke speed dial ${RUN_ID}`,
		enabled: true,
		...writeDestination({ type: "alias", ref: aliasId, data: null }, ""),
	});
	const speedDialId = rowId(speedDial);
	check(
		"a speed dial points at a destination trio rather than a dial string, alias included",
		speedDial.status === 201 && data(speedDial).destinationRef === aliasId,
		`status ${speedDial.status}`,
	);

	// --- call flows, and the toggle that is a different grant --------------------------------------
	const flow = await client("POST", "/api/v1/call-flows", {
		name: `Smoke flow ${RUN_ID}`,
		featureCode: `*28${RUN_DIGITS.slice(0, 1)}`,
		enabled: true,
		...writeDestination({ type: "alias", ref: aliasId, data: null }, ""),
		...writeDestination({ type: "hangup", ref: null, data: null }, "night"),
	});
	const flowId = rowId(flow);
	check(
		"a call flow saves with BOTH trios and starts in day mode",
		flow.status === 201 &&
			data(flow).destinationType === "alias" &&
			data(flow).nightDestinationType === "hangup" &&
			data(flow).mode === "day",
		`status ${flow.status}, mode ${String(data(flow).mode)}`,
	);

	/**
	 * The switch is not a field. A `PATCH` carrying `mode` is a 400 naming it, which is what makes
	 * the dialog's missing mode control a contract rather than an omission.
	 */
	const patchedMode = await client("PATCH", `/api/v1/call-flows/${flowId}`, { mode: "night" });
	check(
		"a PATCH cannot move the switch, which is why the edit dialog has no mode control",
		patchedMode.status === 400,
		`status ${patchedMode.status}`,
	);

	const toggled = await client("POST", `/api/v1/call-flows/${flowId}/toggle`, { mode: "night" });
	check(
		"the toggle endpoint moves it and answers with the row the list re-renders",
		toggled.status === 201 && data(toggled).mode === "night",
		`status ${toggled.status}, mode ${String(data(toggled).mode)}`,
	);

	/** Sending the target state explicitly is what makes the button idempotent under a double click. */
	const toggledAgain = await client("POST", `/api/v1/call-flows/${flowId}/toggle`, {
		mode: "night",
	});
	check(
		"sending the mode explicitly is idempotent, so two fast clicks do not cancel out",
		toggledAgain.status === 201 && data(toggledAgain).mode === "night",
		`mode ${String(data(toggledAgain).mode)}`,
	);

	// --- the time-condition override, which lives under /call-flows -------------------------------
	const conditions = await client("GET", "/api/v1/time-conditions?page=1&limit=1");
	const conditionId = firstId(conditions);
	check(
		"a time condition row carries the override columns the list and detail page render",
		Object.hasOwn((conditions.body.data as Record<string, unknown>[])[0] ?? {}, "override"),
		Object.keys((conditions.body.data as Record<string, unknown>[])[0] ?? {}).join(","),
	);

	const forced = await client(
		"POST",
		`/api/v1/call-flows/time-conditions/${conditionId}/override`,
		{
			override: "forced-no-match",
		},
	);
	check(
		"the override endpoint writes a TIME CONDITION from under /call-flows, and answers with it",
		forced.status === 201 && data(forced).override === "forced-no-match",
		`status ${forced.status}, override ${String(data(forced).override)}`,
	);

	const released = await client(
		"POST",
		`/api/v1/call-flows/time-conditions/${conditionId}/override`,
		{ override: "auto" },
	);
	check(
		"and hands the clock back, which is the state the select's first option means",
		released.status === 201 && data(released).override === "auto",
		`override ${String(data(released).override)}`,
	);

	/**
	 * The column exists, the compiler screens it against the feature-code catalogue, and the DTO now
	 * accepts it — so the card offers it. `*291` is chosen because nothing in the seeded catalogue is
	 * a prefix of it; a code that collided would come back as a compile rollback, not a 400.
	 */
	const overrideCode = await client("PATCH", `/api/v1/time-conditions/${conditionId}`, {
		overrideFeatureCode: "*291",
	});
	check(
		"the override star code is writable, which is why the card renders an input",
		overrideCode.status === 200 && data(overrideCode).overrideFeatureCode === "*291",
		`status ${overrideCode.status}, code ${String(data(overrideCode).overrideFeatureCode)}`,
	);

	/** `null` is how the form's "no star code" option says what it means, and how it is unassigned. */
	const clearedCode = await client("PATCH", `/api/v1/time-conditions/${conditionId}`, {
		overrideFeatureCode: null,
	});
	check(
		"and null clears it, so a lamp key is unassigned without deleting the condition",
		clearedCode.status === 200 && data(clearedCode).overrideFeatureCode === null,
		`status ${clearedCode.status}, code ${String(data(clearedCode).overrideFeatureCode)}`,
	);

	// --- translation rulesets and their ordered rules ----------------------------------------------
	const ruleset = await client("POST", "/api/v1/translation-rulesets", {
		name: `Smoke ruleset ${RUN_ID}`,
		description: "E.164 normalisation",
		enabled: true,
	});
	const rulesetId = rowId(ruleset);
	check(
		"a ruleset is created through routes.write rather than a resource of its own",
		ruleset.status === 201,
		`status ${ruleset.status}`,
	);

	const strip = await client("POST", `/api/v1/translation-rulesets/${rulesetId}/rules`, {
		label: "Strip the international prefix",
		matchPattern: "^00(\\d+)$",
		replacement: "$1",
		ordinal: 0,
		enabled: true,
	});
	const plus = await client("POST", `/api/v1/translation-rulesets/${rulesetId}/rules`, {
		label: "Add the plus",
		matchPattern: "^(\\d+)$",
		replacement: "+$1",
		ordinal: 1,
		enabled: true,
	});
	check(
		"both halves of a pipeline save, including an EMPTY-capable replacement",
		strip.status === 201 && plus.status === 201,
		`status ${strip.status}/${plus.status}`,
	);

	/**
	 * The security boundary the form deliberately does not duplicate: a replacement that can emit
	 * `@` could put a second host into a request URI. It is refused by the compiler inside the write
	 * transaction, so it has to surface as a rollback the dialog can render — not as a stored rule.
	 */
	const unsafe = await client("POST", `/api/v1/translation-rulesets/${rulesetId}/rules`, {
		matchPattern: "^(\\d+)$",
		replacement: "$1@evil.example",
		ordinal: 2,
	});
	check(
		"an unsafe replacement is refused by the compiler rather than accepted by the edge",
		unsafe.status >= 400,
		`status ${unsafe.status}`,
	);

	/** The order IS the semantics here, so it is rewritten in one transaction. */
	const reordered = await client("PUT", `/api/v1/translation-rulesets/${rulesetId}/rules/reorder`, {
		ids: [rowId(plus), rowId(strip)],
	});
	check(
		"the whole pipeline is reordered in one request, as the detail page sends it",
		reordered.status === 200,
		`status ${reordered.status}`,
	);

	// --- PIN sets, and the code that goes in and never comes back ----------------------------------
	const pinSet = await client("POST", "/api/v1/pin-sets", {
		name: `Smoke codes ${RUN_ID}`,
		description: "International calling",
		maxAttempts: 3,
		digitTimeoutMs: 8000,
		enabled: true,
	});
	const pinSetId = rowId(pinSet);
	check("a PIN set is created", pinSet.status === 201, `status ${pinSet.status}`);

	const entry = await client("POST", `/api/v1/pin-sets/${pinSetId}/entries`, {
		label: "Night desk",
		ordinal: 0,
		enabled: true,
		pin: "48213",
	});
	const entryId = rowId(entry);
	check(
		"a code and its digest are created in ONE request, so there is no ungated window",
		entry.status === 201 && !Object.hasOwn(data(entry), "pinHash"),
		`status ${entry.status}, keys ${Object.keys(data(entry)).join(",")}`,
	);

	const reset = await client("PUT", `/api/v1/pin-sets/${pinSetId}/entries/${entryId}/pin`, {
		pin: "90517",
	});
	check(
		"replacing a code leaves the label and the ordinal — the identity a call record names",
		reset.status === 200 &&
			data(reset).label === "Night desk" &&
			data(reset).ordinal === 0 &&
			!Object.hasOwn(data(reset), "pinHash"),
		`status ${reset.status}`,
	);

	const entryList = await client("GET", `/api/v1/pin-sets/${pinSetId}/entries`);
	const entryRows = (entryList.body.data as Record<string, unknown>[]) ?? [];
	check(
		"and no digest is ever on a row the codes table renders",
		entryRows.every((row) => !Object.hasOwn(row, "pinHash")),
		Object.keys(entryRows[0] ?? {}).join(","),
	);

	// --- the three attachments, which the request body now carries --------------------------------
	/**
	 * The reason the outbound-route and trunk dialogs render these as pickers. The columns were
	 * always compiled; what they lacked was a DTO field, and this used to assert the 400 that proved
	 * it. Each is written and read back, because a key a strict object accepted and the repository
	 * dropped would look identical to a working write from the form's side.
	 */
	const routes = await client("GET", "/api/v1/outbound-routes?page=1&limit=1");
	const outboundRouteId = firstId(routes);
	const gated = await client("PATCH", `/api/v1/outbound-routes/${outboundRouteId}`, { pinSetId });
	const rewritten = await client("PATCH", `/api/v1/outbound-routes/${outboundRouteId}`, {
		translationRulesetId: rulesetId,
	});
	const trunks = await client("GET", "/api/v1/trunks?page=1&limit=1");
	const trunkId = firstId(trunks);
	const inbound = await client("PATCH", `/api/v1/trunks/${trunkId}`, {
		inboundTranslationRulesetId: rulesetId,
	});
	check(
		"all three attachments are writable, and each answers with the id it stored",
		gated.status === 200 &&
			data(gated).pinSetId === pinSetId &&
			rewritten.status === 200 &&
			data(rewritten).translationRulesetId === rulesetId &&
			inbound.status === 200 &&
			data(inbound).inboundTranslationRulesetId === rulesetId,
		`pinSet ${gated.status}/${String(data(gated).pinSetId)}, ruleset ${rewritten.status}/${String(data(rewritten).translationRulesetId)}, trunk ${inbound.status}/${String(data(inbound).inboundTranslationRulesetId)}`,
	);

	/**
	 * The other half of making them writable: both columns are `on delete set null` in the schema and
	 * both resources refuse the delete anyway, so a set three routes are gated by cannot vanish and
	 * quietly widen who may dial internationally. Only reachable now that a route can be attached.
	 */
	const gatedSetDelete = await client("DELETE", `/api/v1/pin-sets/${pinSetId}`);
	check(
		"a PIN set an outbound route is gated by cannot be deleted out from under it",
		gatedSetDelete.status === 409 &&
			pbxErrorCode(asApiError(gatedSetDelete)) === "PBX_REFERENCED" &&
			pbxReferences(asApiError(gatedSetDelete)).length > 0,
		`status ${gatedSetDelete.status}, ${pbxReferences(asApiError(gatedSetDelete)).length} references`,
	);

	/** `null` detaches, which is what the picker's "None" option sends. */
	const detachedPin = await client("PATCH", `/api/v1/outbound-routes/${outboundRouteId}`, {
		pinSetId: null,
		translationRulesetId: null,
	});
	const detachedTrunk = await client("PATCH", `/api/v1/trunks/${trunkId}`, {
		inboundTranslationRulesetId: null,
	});
	check(
		"and null detaches all three, which is what the pickers' None option sends",
		detachedPin.status === 200 &&
			data(detachedPin).pinSetId === null &&
			data(detachedPin).translationRulesetId === null &&
			detachedTrunk.status === 200 &&
			data(detachedTrunk).inboundTranslationRulesetId === null,
		`route ${detachedPin.status}, trunk ${detachedTrunk.status}`,
	);

	// --- organization limits: a singleton, and a usage report with two honest gaps -----------------
	const limits = await client("PUT", "/api/v1/org-limits", {
		maxExtensions: 50,
		maxTrunks: null,
		maxConcurrentCalls: 25,
		maxStorageMb: 1024,
	});
	check(
		"the limits are a PUT of the COMPLETE set, and null removes a ceiling",
		limits.status === 200 && data(limits).maxExtensions === 50 && data(limits).maxTrunks === null,
		`status ${limits.status}`,
	);

	const usage = await client("GET", "/api/v1/org-limits/usage");
	const usageEntries =
		(data(usage).entries as { limit: string; used: number; ceiling: number | null }[]) ?? [];
	const concurrent = usageEntries.find((row) => row.limit === "maxConcurrentCalls");
	check(
		"the usage report answers one line per limit, in the order the page renders them",
		usage.status === 200 &&
			usageEntries.map((row) => row.limit).join(",") ===
				"maxExtensions,maxTrunks,maxConcurrentCalls,maxStorageMb",
		usageEntries.map((row) => row.limit).join(","),
	);
	check(
		"simultaneous calls report a ceiling and zero usage, which is why the page draws no bar for them",
		concurrent?.ceiling === 25 && concurrent.used === 0,
		JSON.stringify(concurrent),
	);
	check(
		"and the exact byte total is carried beside the rounded megabytes",
		typeof data(usage).storageBytes === "number",
		String(data(usage).storageBytes),
	);

	// --- tear down, in dependency order -----------------------------------------------------------
	await client("DELETE", `/api/v1/speed-dials/${speedDialId}`);
	await client("DELETE", `/api/v1/call-flows/${flowId}`);

	/** A named destination cannot be deleted while a speed dial or a flow still names it. */
	const aliasDeleted = await client("DELETE", `/api/v1/destination-aliases/${aliasId}`);
	check(
		"the named destination deletes once nothing points at it any more",
		aliasDeleted.status === 200,
		`status ${aliasDeleted.status}`,
	);

	await client("DELETE", `/api/v1/directories/${directoryId}`);
	await client("DELETE", `/api/v1/audio-streams/${streamId}`);
	await client("DELETE", `/api/v1/pin-sets/${pinSetId}`);
	const rulesetDeleted = await client("DELETE", `/api/v1/translation-rulesets/${rulesetId}`);
	check(
		"and the ruleset deletes with its rules",
		rulesetDeleted.status === 200,
		`status ${rulesetDeleted.status}`,
	);
}
