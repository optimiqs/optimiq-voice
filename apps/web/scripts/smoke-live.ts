/**
 * Smoke test for the live channel THROUGH the Next origin.
 *
 *   DATABASE_URL=… PBX_DATABASE_URL=… pnpm --filter @optimiq-voice/web smoke:live
 *
 * ## The one question this exists to answer
 *
 * `apps/api` serves `/api/v1/live` as a WebSocket, and the browser reaches every other API route
 * through `next.config.mjs`'s `/api/:path*` rewrite. Whether that rewrite forwards an HTTP UPGRADE
 * is not something to assume: a rewrite is implemented on the server's `request` handler, and an
 * upgrade arrives on its `upgrade` event, which is a different event entirely. If Next does not
 * proxy it, a same-origin socket URL is a socket that never opens — and the failure looks exactly
 * like "the API is down", on a page whose REST calls are working perfectly.
 *
 * So this boots the real API and a real `next dev`, signs a user in through the Next origin (which
 * is what makes the session cookie first-party there) and opens a WebSocket at the Next origin. It
 * reports what happened either way, and `lib/live/protocol.ts`'s `liveSocketUrl` is written against
 * the answer rather than against a hope.
 *
 * `next dev`, not `next start`: rewrite destinations are baked into `routes-manifest.json` at build
 * time, so a built app would proxy to whatever `API_PROXY_ORIGIN` was when it was built.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API_ROOT = join(dirname(WEB_ROOT), "api");
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

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

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { redirect: "manual" });
			if (response.status > 0) {
				return true;
			}
		} catch {
			// Not up yet.
		}
		await delay(500);
	}
	return false;
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? "postgresql://optimiq:optimiq@localhost:5433/optimiq";
	const pbxDatabaseUrl =
		process.env.PBX_DATABASE_URL ?? "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
	const apiPort = await findFreePort();
	const webPort = await findFreePort();
	const apiUrl = `http://127.0.0.1:${apiPort}`;
	const webUrl = `http://127.0.0.1:${webPort}`;

	const bootCode = `
		import "reflect-metadata";
		const { NestFactory } = await import("@nestjs/core");
		const { FastifyAdapter } = await import("@nestjs/platform-fastify");
		const { createApiRootModule, registerAuthTransport } = await import("./src/auth/auth-bootstrap.ts");
		const { PbxModule } = await import("./src/pbx/pbx.module.ts");
		const { LiveModule } = await import("./src/live/live.module.ts");
		const { registerLiveTransport } = await import("./src/live/live-bootstrap.ts");
		const app = await NestFactory.create(
			createApiRootModule([], [PbxModule, LiveModule]),
			new FastifyAdapter(),
			{ logger: ["error"] },
		);
		app.enableShutdownHooks();
		await registerAuthTransport(app);
		await registerLiveTransport(app);
		await app.listen(${String(apiPort)}, "127.0.0.1");
		console.log("LIVE_SLICE_READY");
	`;

	let api: ChildProcess | undefined;
	let web: ChildProcess | undefined;

	try {
		console.log(`starting the API on ${apiUrl}`);
		api = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", bootCode], {
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
		});
		let apiLog = "";
		api.stdout?.on("data", (chunk: Buffer) => {
			apiLog += chunk.toString();
		});
		api.stderr?.on("data", (chunk: Buffer) => {
			apiLog += chunk.toString();
		});

		const ready = await (async () => {
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				if (apiLog.includes("LIVE_SLICE_READY")) {
					return true;
				}
				await delay(300);
			}
			return false;
		})();
		if (!check("the API booted with the live channel", ready, apiLog.slice(-400))) {
			return;
		}

		console.log(`starting next dev on ${webUrl}`);
		web = spawn(
			join(WEB_ROOT, "node_modules/.bin/next"),
			["dev", "--port", String(webPort), "--hostname", "127.0.0.1"],
			{
				cwd: WEB_ROOT,
				env: { ...process.env, API_PROXY_ORIGIN: apiUrl, NODE_ENV: "development" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (!check("next dev came up", await waitForServer(`${webUrl}/sign-in`, 180_000))) {
			return;
		}

		// Signed in THROUGH the Next origin, which is what makes the cookie first-party there — the
		// whole point of the rewrite, and the reason a socket to another origin would not carry it.
		const jar = new CookieJar();
		const email = `smoke-live-${RUN_ID}@verify.optimiq.test`;
		const password = "Smoke-Live-2026!";
		const post = async (path: string, body: unknown): Promise<Response> => {
			const response = await fetch(`${webUrl}${path}`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					cookie: jar.header(),
				},
				body: JSON.stringify(body),
				redirect: "manual",
			});
			jar.absorb(response);
			return response;
		};

		await post("/api/auth/sign-up/email", { name: "Smoke Live", email, password });
		const created = await post("/api/auth/organization/create", {
			name: `Smoke Live ${RUN_ID}`,
			slug: `smoke-live-${RUN_ID}`,
		});
		const organizationId = ((await created.json()) as { id?: string }).id ?? "";
		await post("/api/auth/organization/set-active", { organizationId });
		check("a session exists on the Next origin", jar.header().length > 0 && organizationId.length > 0);

		const me = await fetch(`${webUrl}/api/v1/me`, { headers: { cookie: jar.header() } });
		check("REST reaches the API through the /api rewrite", me.status === 200, `status ${me.status}`);

		// The question.
		const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
			const socket = new WebSocket(`${webUrl.replace("http", "ws")}/api/v1/live`, {
				headers: { cookie: jar.header(), origin: webUrl },
			});
			const timer = setTimeout(() => {
				socket.terminate();
				resolve({ ok: false, detail: "no response within 10s" });
			}, 10_000);
			socket.on("message", (data) => {
				clearTimeout(timer);
				const frame = JSON.parse(data.toString()) as { op?: string; orgId?: string };
				socket.close();
				resolve({
					ok: frame.op === "welcome" && frame.orgId === organizationId,
					detail: JSON.stringify(frame).slice(0, 160),
				});
			});
			socket.on("unexpected-response", (_request, response) => {
				clearTimeout(timer);
				resolve({ ok: false, detail: `HTTP ${String(response.statusCode)} from the Next origin` });
			});
			socket.on("error", (error: Error) => {
				clearTimeout(timer);
				resolve({ ok: false, detail: error.message });
			});
		});

		check(
			"a WebSocket upgrade is proxied by the Next /api rewrite, carrying the first-party cookie",
			result.ok,
			result.detail,
		);
		if (!result.ok) {
			console.log(
				"\n  NOTE: the Next rewrite did not forward the upgrade. `lib/live/protocol.ts`'s\n" +
					"  `liveSocketUrl` builds a same-origin URL on the assumption that it does; if this\n" +
					"  check is failing, that assumption is wrong for this Next version and the client has\n" +
					"  to be pointed at the API origin directly (which also means the session cookie must\n" +
					"  be readable there — a cross-origin socket does not send a first-party cookie).\n",
			);
		}
	} finally {
		web?.kill("SIGTERM");
		api?.kill("SIGTERM");
		await delay(500);
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("live channel smoke PASSED");
}

await main();
