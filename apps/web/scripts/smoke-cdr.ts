/**
 * End-to-end smoke for the P5 reporting screens.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   CDR_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_cdr \
 *     pnpm --filter @optimiq-voice/web smoke:cdr
 *
 * `verify:cdr` proves the WRITER and the API against a real broker. This proves the FRONTEND's
 * understanding of what that API returns, which is a different claim: that `/cdr` and
 * `/recordings` render through Next, that the cursor envelope the screens read is the envelope the
 * server sends, and — the part no unit test can reach — that a signed recording URL minted through
 * the Next rewrite is fetchable through the same origin an `<audio src>` would use.
 *
 * So it boots the auth slice plus `CdrModule`, seeds a realistic history with the API's own
 * `seed-cdr-demo.ts`, starts Next, and drives everything through the NEXT origin.
 *
 * The durable writers are switched OFF (`CDR_WRITER_ENABLED=false`): no broker is started, because
 * the broker round trip is `verify:cdr`'s subject and requiring Docker here would make the
 * frontend smoke fail for a backend reason.
 *
 * Playwright is not set up in this repository, so this is fetch-level: it verifies the contract and
 * the server-rendered HTML, not clicks.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildCallTree, flattenCallTree } from "../lib/cdr/format";
import type { CallLegRow } from "../lib/cdr/contracts";

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_CDR_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_cdr";

const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RECORDING_SECRET = "smoke-cdr-recording-signing-key-0123456789abcde";
const RUN_ID = Date.now().toString(36);
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

function rows(response: JsonResponse): Record<string, unknown>[] {
	const value = response.body.data;
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function data(response: JsonResponse): Record<string, unknown> {
	const value = response.body.data;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
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
async function seedCdr(
	organizationId: string,
	cdrDatabaseUrl: string,
	recordingRoot: string,
	options: { readonly purge?: boolean } = {},
): Promise<boolean> {
	return await new Promise((resolve) => {
		const seed = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"scripts/seed-cdr-demo.ts",
				"--organization",
				organizationId,
				...(options.purge === true ? ["--purge"] : []),
			],
			{
				cwd: API_ROOT,
				env: {
					...process.env,
					CDR_DATABASE_URL: cdrDatabaseUrl,
					CDR_RECORDING_ROOT: recordingRoot,
				},
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
	const cdrDatabaseUrl = process.env.CDR_DATABASE_URL ?? DEFAULT_CDR_DATABASE_URL;
	const apiPort = await findFreePort();
	const webPort = await findFreePort();
	const apiUrl = `http://127.0.0.1:${apiPort}`;
	const webUrl = `http://127.0.0.1:${webPort}`;
	const recordingRoot = await mkdtemp(join(tmpdir(), "optimiq-smoke-cdr-"));

	const bootCode = `
		await import("reflect-metadata");
		const { NestFactory } = await import("@nestjs/core");
		const { FastifyAdapter } = await import("@nestjs/platform-fastify");
		const { createApiRootModule, registerAuthTransport } = await import(
			"./src/auth/auth-bootstrap.ts"
		);
		const { CdrModule } = await import("./src/cdr/cdr.module.ts");
		const app = await NestFactory.create(
			createApiRootModule([], [CdrModule]),
			new FastifyAdapter(),
			{ logger: ["error"] },
		);
		app.enableShutdownHooks();
		await registerAuthTransport(app);
		await app.listen(${apiPort}, "127.0.0.1");
		console.log("CDR_AREA_READY");
	`;

	console.log(`booting the auth slice + CDR area on ${apiUrl}`);
	const apiProcess: ChildProcess = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", bootCode],
		{
			cwd: API_ROOT,
			env: {
				...process.env,
				NODE_ENV: "test",
				DATABASE_URL: databaseUrl,
				CDR_DATABASE_URL: cdrDatabaseUrl,
				AUTH_SECRET: TEST_SECRET,
				AUTH_URL: apiUrl,
				API_APP_URL: webUrl,
				CDR_WRITER_ENABLED: "false",
				CDR_RECORDING_URL_SECRET: RECORDING_SECRET,
				CDR_RECORDING_URL_TTL_SECONDS: "60",
				CDR_RECORDING_ROOT: recordingRoot,
				// No NATS: this smoke is about the screens, and the broker round trip is verify:cdr's.
				NATS_URL: "",
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
				if (chunk.toString().includes("CDR_AREA_READY")) {
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
			throw new Error("the API did not start (is Postgres reachable on :5433 with both databases?)");
		}

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
		const email = `cdr-smoke-${RUN_ID}@smoke.optimiq.test`;
		const password = "Smoke-Cdr-Flow-2026!";

		console.log("0. an owner with an organization");
		await client("POST", "/api/auth/sign-up/email", { name: "CDR Smoke", email, password });
		const created = await client("POST", "/api/auth/organization/create", {
			name: `CDR Smoke ${RUN_ID}`,
			slug: `cdr-smoke-${RUN_ID}`,
		});
		const organizationId = typeof created.body.id === "string" ? created.body.id : "";
		await client("POST", "/api/auth/organization/set-active", { organizationId });
		check("organization created and active", organizationId.length > 0, organizationId);

		console.log("\n0b. seed a demo call history");
		const seeded = await seedCdr(organizationId, cdrDatabaseUrl, recordingRoot);
		check("seed-cdr-demo.ts populated the organization", seeded);

		console.log("\n1. both reporting routes render through Next");
		for (const path of ["/cdr", "/recordings"]) {
			const rendered = await page(webUrl, path, jar);
			check(`${path} renders`, rendered.status === 200, `status ${String(rendered.status)}`);
		}
		const cdrHtml = (await page(webUrl, "/cdr", jar)).html;
		check("the call history page carries its heading", cdrHtml.includes("Call history"));
		check(
			"the call history page is no longer a placeholder",
			!cdrHtml.includes("arrives with the engine wave"),
		);
		const recordingsHtml = (await page(webUrl, "/recordings", jar)).html;
		check("the recordings page carries its heading", recordingsHtml.includes("Recordings"));
		check(
			"the recordings page is no longer a placeholder",
			!recordingsHtml.includes("arrives with the engine wave"),
		);
		check(
			"neither reporting nav entry is still marked Soon",
			!cdrHtml.includes(">Soon<") || !recordingsHtml.includes(">Soon<"),
		);
		const deepLink = await page(webUrl, "/cdr?range=7d&disposition=answered&q=Dana", jar);
		check(
			"a filtered call-history URL is a real, renderable link",
			deepLink.status === 200,
			`status ${String(deepLink.status)}`,
		);

		console.log("\n2. the envelope the screens read is the envelope the server sends");
		const list = await client("GET", "/api/v1/cdr?limit=50");
		check("the call list is reachable through the Next rewrite", list.status === 200);
		check(
			"it is a cursor envelope, not the PBX paged one",
			"nextCursor" in list.body && "range" in list.body && !("totalPages" in list.body),
			Object.keys(list.body).join(", "),
		);
		check("the seeded history is listed", rows(list).length >= 6, `${String(rows(list).length)} rows`);
		const firstRow = rows(list)[0] ?? {};
		for (const field of ["callId", "leg", "originatingLegId", "disposition", "hangupCause", "billsecMs"]) {
			check(`the row carries ${field}, which the table reads`, field in firstRow);
		}

		console.log("\n3. the leg tree the detail view draws");
		const ringGroupCall = rows(list).find((row) => row.destinationType === "ring_group");
		const callId = String(ringGroupCall?.callId ?? "");
		const call = await client("GET", `/api/v1/cdr/calls/${callId}`);
		check("the ring-group call resolves to all of its legs", call.status === 200);
		const legs = Array.isArray(data(call).legs) ? (data(call).legs as unknown as CallLegRow[]) : [];
		check("it has three legs", legs.length === 3, `${String(legs.length)} legs`);
		// The app's OWN tree builder against the REAL payload: a unit test proves the algorithm, and
		// only this proves the algorithm is being fed the columns it expects.
		const tree = flattenCallTree(buildCallTree(legs));
		check("every leg appears exactly once in the tree", tree.length === legs.length);
		check(
			"the two B-legs sit one level under the A-leg",
			tree.filter((node) => node.depth === 1).length === 2,
			tree.map((node) => `${node.leg.leg}@${String(node.depth)}`).join(" "),
		);

		console.log("\n4. filters and paging, as the screen issues them");
		const answered = await client("GET", "/api/v1/cdr?disposition=answered&limit=50");
		check(
			"the outcome filter narrows to answered legs",
			rows(answered).length > 0 && rows(answered).every((row) => row.disposition === "answered"),
		);
		const pageOne = await client("GET", "/api/v1/cdr?limit=2");
		check("a page returns the limit and a cursor", rows(pageOne).length === 2 && typeof pageOne.body.nextCursor === "string");
		const pageTwo = await client(
			"GET",
			`/api/v1/cdr?limit=2&cursor=${encodeURIComponent(String(pageOne.body.nextCursor))}`,
		);
		const firstIds = rows(pageOne).map((row) => String(row.id));
		check(
			"the next page does not repeat the first",
			rows(pageTwo).every((row) => !firstIds.includes(String(row.id))),
		);

		console.log("\n5. recordings and the signed media URL");
		const recordings = await client("GET", "/api/v1/recordings?limit=50");
		check("the recordings list is reachable through the rewrite", recordings.status === 200);
		check("the seeded recording is listed", rows(recordings).length === 1);
		const recordingId = String(rows(recordings)[0]?.id ?? "");
		const minted = await client("POST", `/api/v1/recordings/${recordingId}/download-url`, {});
		check(
			"a signed URL can be minted through the rewrite",
			minted.status === 201 || minted.status === 200,
			`status ${String(minted.status)}`,
		);
		const signedUrl = String(data(minted).url ?? "");
		check(
			"the URL is same-origin and relative, so an <audio src> can use it directly",
			signedUrl.startsWith("/api/v1/recordings/media?token="),
			signedUrl.slice(0, 48),
		);
		check(
			"the URL does not contain the recording id, so nothing is enumerable",
			!signedUrl.includes(recordingId),
		);

		// The fetch that matters: through the NEXT origin, with NO cookie, exactly as the browser's
		// media loader would issue it.
		const media = await fetch(`${webUrl}${signedUrl}`);
		check(
			"the signed URL streams the media through Next, anonymously",
			media.status === 200,
			`status ${String(media.status)}`,
		);
		check(
			"the media is served as audio",
			(media.headers.get("content-type") ?? "").startsWith("audio/"),
			String(media.headers.get("content-type")),
		);
		const bytes = Buffer.from(await media.arrayBuffer());
		check("the bytes are the seeded object", bytes.subarray(0, 4).toString("ascii") === "RIFF");

		const tampered = signedUrl.replace(/token=(.)/u, (match, first: string) =>
			`token=${first === "A" ? "B" : "A"}`,
		);
		const tamperedResponse = await fetch(`${webUrl}${tampered}`);
		check(
			"a token with one character changed is refused",
			tamperedResponse.status === 403,
			`status ${String(tamperedResponse.status)}`,
		);
		const noToken = await fetch(`${webUrl}/api/v1/recordings/media`);
		check("the media route with no token is refused", noToken.status === 403, `status ${String(noToken.status)}`);

		// The ledger has no delete endpoint by design, so the fixture is torn down through the same
		// owner-principal script that created it. Leaving it would make every run add six more legs
		// to a developer's database.
		if (organizationId.length > 0) {
			await seedCdr(organizationId, cdrDatabaseUrl, recordingRoot, { purge: true });
		}
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
