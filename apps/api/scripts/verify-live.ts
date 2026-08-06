/**
 * End-to-end verification of the live-operations wave.
 *
 *   DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq \
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *     pnpm --filter @optimiq-voice/api verify:live
 *
 * It boots the real HTTP slice — `createApiRootModule([], [PbxModule, LiveModule])` — against a
 * real PostgreSQL and a real NATS, and drives it with a real WebSocket client holding a real
 * session cookie. Nothing here is faked: the frames are the frames a browser gets.
 *
 * What it proves, in order:
 *
 *  1. **The upgrade is authenticated.** Anonymous and forged-cookie upgrades are refused with an
 *     HTTP 401 before the handshake, and an untrusted `Origin` with a 403 — the check CORS does not
 *     do for WebSockets and without which any site the user visits could read this feed.
 *  2. **Topics are permission-filtered per session.** An owner is offered every topic; an agent is
 *     offered the queue feeds and REFUSED the organization-wide registration and call feeds, which
 *     is the same split the role templates draw for the pages.
 *  3. **Malformed frames produce an error, not a dead socket.**
 *  4. **Fan-out arrives shaped.** A KV write and a published event reach the subscriber as
 *     `snapshot` / `event` frames carrying the parsed contract.
 *  5. **Organizations are isolated.** Two tenants, two sockets, no cross-talk — asserted by
 *     writing one tenant's state while the other is subscribed and connected.
 *  6. **Unparseable upstream values are dropped rather than forwarded.**
 *  7. **The upstream is ref-counted and torn down.** `LiveHub.openSources` is read directly, so
 *     "the watch stopped" is an assertion rather than a comment.
 *  8. **The agent-session surface writes the transitions the engine refuses**, guarded by the
 *     shared state machine, and the transition arrives on the socket.
 *  9. **The queue-membership publisher projects the roster into KV** on every write that changes
 *     it — including an extension renumber, which changes an agent's dial string.
 *
 * NATS: `NATS_URL` is used when set; otherwise `nats:2.11-alpine` is started on an ephemeral port
 * and removed afterwards. Unlike `verify-pbx.ts` a missing broker is FATAL here rather than a skip
 * — a broker is the entire subject of this gate, and a green run with the interesting half skipped
 * would be worse than a red one.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

const DEFAULT_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";
const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
/** Shared with `verify-auth-slice.ts`: better-auth encrypts its JWKS keys with it. */
const TEST_SECRET = process.env.AUTH_SECRET ?? "verify-auth-slice-secret-0123456789abcdef";
const RUN_ID = Date.now().toString(36);

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

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
 * A live client that keeps every frame it was sent.
 *
 * Frames are BUFFERED rather than consumed by a callback, so an assertion can be written after the
 * thing it is asserting about happened — which is the only way to test a push protocol without a
 * race between "subscribe" and "look".
 */
class LiveClient {
	readonly frames: Record<string, unknown>[] = [];
	private readonly socket: WebSocket;
	private closed = false;
	closeCode: number | undefined;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on("message", (data) => {
			try {
				this.frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
			} catch {
				this.frames.push({ op: "__unparseable__", raw: data.toString() });
			}
		});
		socket.on("close", (code) => {
			this.closed = true;
			this.closeCode = code;
		});
	}

	static async open(
		baseUrl: string,
		cookie: string,
		options: { readonly origin?: string } = {},
	): Promise<{ client?: LiveClient; status?: number; message?: string }> {
		const url = `${baseUrl.replace(/^http/u, "ws")}/api/v1/live`;
		const headers: Record<string, string> = {};
		if (cookie.length > 0) {
			headers.cookie = cookie;
		}
		if (options.origin !== undefined) {
			headers.origin = options.origin;
		}
		const socket = new WebSocket(url, { headers });
		return await new Promise((resolve) => {
			const settle = (value: { client?: LiveClient; status?: number; message?: string }) => {
				resolve(value);
			};
			socket.once("open", () => settle({ client: new LiveClient(socket) }));
			socket.once("unexpected-response", (_request, response) => {
				settle({ status: response.statusCode });
			});
			socket.once("error", (error: Error & { message: string }) => {
				settle({ message: error.message });
			});
		});
	}

	send(frame: Record<string, unknown>): void {
		this.socket.send(JSON.stringify(frame));
	}

	/** The first frame matching `predicate`, or `undefined` after `timeoutMs`. */
	async waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		timeoutMs = 4_000,
	): Promise<Record<string, unknown> | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.frames.find(predicate);
			if (found !== undefined) {
				return found;
			}
			await delay(50);
		}
		return undefined;
	}

	matching(predicate: (frame: Record<string, unknown>) => boolean): Record<string, unknown>[] {
		return this.frames.filter(predicate);
	}

	clear(): void {
		this.frames.length = 0;
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.socket.close();
		for (let attempt = 0; attempt < 40 && !this.closed; attempt += 1) {
			await delay(25);
		}
	}
}

function eventOn(topic: string, kind?: string) {
	return (frame: Record<string, unknown>): boolean =>
		frame.op === "event" && frame.topic === topic && (kind === undefined || frame.kind === kind);
}

function snapshotOn(topic: string) {
	return (frame: Record<string, unknown>): boolean =>
		frame.op === "snapshot" && frame.topic === topic;
}

// ---------------------------------------------------------------------------------------------
// Docker-managed NATS
// ---------------------------------------------------------------------------------------------

const NATS_CONTAINER_PREFIX = "optimiq-verify-live";

async function sweepStaleNats(): Promise<void> {
	try {
		const { stdout } = await execFileAsync("docker", [
			"ps",
			"-aq",
			"--filter",
			`name=${NATS_CONTAINER_PREFIX}`,
		]);
		const stale = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (stale.length > 0) {
			await execFileAsync("docker", ["rm", "-f", ...stale]);
		}
	} catch {
		// No docker, or nothing to sweep.
	}
}

async function startNats(): Promise<{ url: string; containerId?: string }> {
	if (process.env.NATS_URL) {
		console.log(`using the broker at ${process.env.NATS_URL}`);
		return { url: process.env.NATS_URL };
	}
	const port = await findFreePort();
	await sweepStaleNats();
	const { stdout } = await execFileAsync("docker", [
		"run",
		"-d",
		"--rm",
		"--name",
		`${NATS_CONTAINER_PREFIX}-${RUN_ID}`,
		"-p",
		`${port}:4222`,
		"nats:2.11-alpine",
		"-js",
	]);
	await delay(1500);
	return { url: `nats://127.0.0.1:${port}`, containerId: stdout.trim() };
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	console.log("\nstarting NATS\n");
	let nats: { url: string; containerId?: string };
	try {
		nats = await startNats();
	} catch (error) {
		console.error(
			"A broker is required: this gate is entirely about NATS, so skipping it would be worse " +
				"than failing. Start one and set NATS_URL, or make `docker` available.\n" +
				String(error),
		);
		process.exitCode = 1;
		return;
	}

	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL = databaseUrl;
	process.env.PBX_DATABASE_URL = pbxDatabaseUrl;
	process.env.AUTH_SECRET = TEST_SECRET;
	process.env.AUTH_URL = baseUrl;
	process.env.API_APP_URL = baseUrl;
	process.env.NATS_URL = nats.url;

	await import("reflect-metadata");
	const { NestFactory } = await import("@nestjs/core");
	const { FastifyAdapter } = await import("@nestjs/platform-fastify");
	const { createApiRootModule, registerAuthTransport } = await import("../src/auth/auth-bootstrap");
	const { PbxModule } = await import("../src/pbx/pbx.module");
	const { LiveModule } = await import("../src/live/live.module");
	const { registerLiveTransport } = await import("../src/live/live-bootstrap");
	const { LiveHub } = await import("../src/live/live-hub.service");
	const { createPostgresClient } = await import("@optimiq-voice/db");
	const { connect } = await import("nats");
	const {
		AGENT_STATE_KV,
		CHANNELS_KV,
		ensureKvBuckets,
		ensureStreams,
		kvKeyFor,
		QUEUE_MEMBERSHIP_KV,
		QUEUES_STREAM,
		REGISTRATIONS_KV,
	} = await import("@optimiq-voice/events/streams");
	const { makeQueueEvent } = await import("@optimiq-voice/events/schemas");

	const sql = createPostgresClient({
		url: databaseUrl,
		applicationName: "verify-live",
		poolMaxConnectionsOverride: 2,
	});

	console.log(`booting the auth slice + PBX area + live channel on ${baseUrl}\n`);
	const app = await NestFactory.create(
		createApiRootModule([], [PbxModule, LiveModule]),
		new FastifyAdapter(),
		{ logger: ["error"] },
	);
	app.enableShutdownHooks();
	await registerAuthTransport(app);
	await registerLiveTransport(app);
	await app.listen(port, "127.0.0.1");
	await delay(400);

	const hub = app.get(LiveHub);
	const encoder = new TextEncoder();

	const ownerAEmail = `live-a-${RUN_ID}@verify.optimiq.test`;
	const ownerBEmail = `live-b-${RUN_ID}@verify.optimiq.test`;
	const agentEmail = `live-agent-${RUN_ID}@verify.optimiq.test`;
	const password = "Verify-Live-Slice-2026!";

	const jarA = new CookieJar();
	const jarB = new CookieJar();
	const jarAgent = new CookieJar();
	const clientA: Client = makeClient(baseUrl, jarA);
	const clientB: Client = makeClient(baseUrl, jarB);
	const clientAgent: Client = makeClient(baseUrl, jarAgent);

	let organizationA = "";
	let organizationB = "";
	const connection = await connect({ servers: nats.url, name: "verify-live-writer" });
	const manager = await connection.jetstreamManager();
	await ensureKvBuckets(manager, [
		REGISTRATIONS_KV,
		CHANNELS_KV,
		AGENT_STATE_KV,
		QUEUE_MEMBERSHIP_KV,
	]);
	await ensureStreams(manager, [QUEUES_STREAM]);
	const registrations = await manager.jetstream().views.kv(REGISTRATIONS_KV.name);
	const channels = await manager.jetstream().views.kv(CHANNELS_KV.name);
	const membership = await manager.jetstream().views.kv(QUEUE_MEMBERSHIP_KV.name);
	const agentStateBucket = await manager.jetstream().views.kv(AGENT_STATE_KV.name);

	const openClients: LiveClient[] = [];

	try {
		// --- 0. two tenants and an agent ---------------------------------------------------------
		console.log("0. two organizations, an owner each, and an agent in A");
		await clientA("POST", "/api/auth/sign-up/email", {
			name: "Live Owner A",
			email: ownerAEmail,
			password,
		});
		const createA = await clientA("POST", "/api/auth/organization/create", {
			name: `Live Org A ${RUN_ID}`,
			slug: `live-org-a-${RUN_ID}`,
		});
		organizationA = typeof createA.body.id === "string" ? createA.body.id : "";
		await clientA("POST", "/api/auth/organization/set-active", { organizationId: organizationA });
		check("organization A created", organizationA.length > 0, organizationA);

		await clientB("POST", "/api/auth/sign-up/email", {
			name: "Live Owner B",
			email: ownerBEmail,
			password,
		});
		const createB = await clientB("POST", "/api/auth/organization/create", {
			name: `Live Org B ${RUN_ID}`,
			slug: `live-org-b-${RUN_ID}`,
		});
		organizationB = typeof createB.body.id === "string" ? createB.body.id : "";
		await clientB("POST", "/api/auth/organization/set-active", { organizationId: organizationB });
		check("organization B created", organizationB.length > 0, organizationB);

		// An `agent`-role member of A. Invited and accepted through the real flow, then the
		// membership row is moved to the `agent` template — which is exactly what the role editor
		// writes, and the only way to get a non-owner permission set without an email round trip.
		await clientAgent("POST", "/api/auth/sign-up/email", {
			name: "Live Agent",
			email: agentEmail,
			password,
		});
		await sql`update "user" set "email_verified" = true where "email" = ${agentEmail}`;
		await clientAgent("POST", "/api/auth/sign-in/email", { email: agentEmail, password });
		const invite = await clientA("POST", "/api/auth/organization/invite-member", {
			email: agentEmail,
			role: "member",
			organizationId: organizationA,
		});
		const invitationId = typeof invite.body.id === "string" ? invite.body.id : "";
		await clientAgent("POST", "/api/auth/organization/accept-invitation", { invitationId });
		await sql`update "member" set "role" = 'agent'
			where "organization_id" = ${organizationA}
			and "user_id" = (select "id" from "user" where "email" = ${agentEmail})`;
		await clientAgent("POST", "/api/auth/sign-in/email", { email: agentEmail, password });
		await clientAgent("POST", "/api/auth/organization/set-active", {
			organizationId: organizationA,
		});
		const agentMe = await clientAgent("GET", "/api/v1/me");
		const agentPermissions = Array.isArray(agentMe.body.permissions)
			? (agentMe.body.permissions as string[])
			: [];
		check(
			"the agent session resolves to the agent role",
			agentPermissions.includes("queues.monitor") && !agentPermissions.includes("cdr.read"),
			`${String(agentPermissions.length)} permissions`,
		);

		// --- 1. the upgrade is authenticated ------------------------------------------------------
		console.log("\n1. the upgrade refuses what it should");
		const anonymous = await LiveClient.open(baseUrl, "");
		check(
			"an anonymous upgrade is refused with 401 before the handshake",
			anonymous.client === undefined && anonymous.status === 401,
			`status ${String(anonymous.status ?? "-")}`,
		);

		const forged = await LiveClient.open(baseUrl, "optimiq_voice_session-v1.session_token=nope");
		check(
			"a forged session cookie is refused with 401",
			forged.client === undefined && forged.status === 401,
			`status ${String(forged.status ?? "-")}`,
		);

		const crossSite = await LiveClient.open(baseUrl, jarA.header(), {
			origin: "https://evil.example",
		});
		check(
			"an untrusted Origin is refused with 403 — the check CORS does not do for WebSockets",
			crossSite.client === undefined && crossSite.status === 403,
			`status ${String(crossSite.status ?? "-")}`,
		);

		const trustedOrigin = await LiveClient.open(baseUrl, jarA.header(), { origin: baseUrl });
		check("the app's own origin is accepted", trustedOrigin.client !== undefined);
		if (trustedOrigin.client) {
			openClients.push(trustedOrigin.client);
			await trustedOrigin.client.close();
		}

		// --- 2. welcome and the permission map ----------------------------------------------------
		console.log("\n2. the welcome frame states what this session may watch");
		const opened = await LiveClient.open(baseUrl, jarA.header());
		if (opened.client === undefined) {
			check("an owner upgrade succeeds", false, `status ${String(opened.status ?? "-")}`);
			throw new Error("cannot continue without a live connection");
		}
		const owner = opened.client;
		openClients.push(owner);
		check("an owner upgrade succeeds", true);

		const welcome = await owner.waitFor((frame) => frame.op === "welcome");
		check("a welcome frame arrives", welcome !== undefined);
		check(
			"the welcome names the session's organization, never one the client sent",
			welcome?.orgId === organizationA,
			String(welcome?.orgId ?? ""),
		);
		check(
			"the welcome advertises a heartbeat interval",
			typeof welcome?.heartbeatMs === "number" && (welcome.heartbeatMs as number) > 0,
			String(welcome?.heartbeatMs ?? ""),
		);
		const ownerTopics = (welcome?.topics as string[] | undefined) ?? [];
		check(
			"an owner is offered every topic kind",
			["registrations", "active-calls", "queue", "agent-state"].every((kind) =>
				ownerTopics.includes(kind),
			),
			ownerTopics.join(","),
		);

		const agentOpened = await LiveClient.open(baseUrl, jarAgent.header());
		if (agentOpened.client === undefined) {
			check("an agent upgrade succeeds", false, `status ${String(agentOpened.status ?? "-")}`);
			throw new Error("cannot continue without the agent connection");
		}
		const agentLive = agentOpened.client;
		openClients.push(agentLive);
		const agentWelcome = await agentLive.waitFor((frame) => frame.op === "welcome");
		const agentTopics = (agentWelcome?.topics as string[] | undefined) ?? [];
		check(
			"an agent is offered the queue feeds and nothing else",
			[...agentTopics].sort().join(",") === "agent-state,queue",
			agentTopics.join(","),
		);

		// --- 3. subscribe: grants, denials and bad frames ------------------------------------------
		console.log("\n3. subscribe, deny and refuse");
		owner.send({ op: "subscribe", topics: ["registrations", "active-calls"], id: "s1" });
		const subscribed = await owner.waitFor(
			(frame) => frame.op === "subscribed" && frame.id === "s1",
		);
		check(
			"an owner's subscribe is granted",
			Array.isArray(subscribed?.topics) &&
				(subscribed.topics as string[]).includes("registrations") &&
				(subscribed.topics as string[]).includes("active-calls"),
			JSON.stringify(subscribed?.topics ?? []),
		);
		check("the reply echoes the correlation id", subscribed?.id === "s1");

		agentLive.send({
			op: "subscribe",
			topics: ["registrations", "active-calls", "agent-state"],
			id: "a1",
		});
		const agentSubscribed = await agentLive.waitFor(
			(frame) => frame.op === "subscribed" && frame.id === "a1",
		);
		const denied = (agentSubscribed?.denied as { topic: string; reason: string; permission?: string }[]) ?? [];
		check(
			"an agent is granted agent-state",
			((agentSubscribed?.topics as string[]) ?? []).includes("agent-state"),
			JSON.stringify(agentSubscribed?.topics ?? []),
		);
		check(
			"an agent is refused registrations, naming the permission that would grant it",
			denied.some(
				(entry) =>
					entry.topic === "registrations" &&
					entry.reason === "forbidden" &&
					entry.permission === "extensions.read",
			),
			JSON.stringify(denied),
		);
		check(
			"an agent is refused active-calls — cdr.read.own does not open an org-wide feed",
			denied.some(
				(entry) =>
					entry.topic === "active-calls" &&
					entry.reason === "forbidden" &&
					entry.permission === "cdr.read",
			),
			JSON.stringify(denied),
		);

		owner.send({ op: "subscribe", topics: ["cdr", "queue:not-a-uuid", "queue:*"], id: "s2" });
		const badTopics = await owner.waitFor((frame) => frame.op === "subscribed" && frame.id === "s2");
		const badDenied = (badTopics?.denied as { topic: string; reason: string }[]) ?? [];
		check(
			"an unknown topic is denied rather than guessed at",
			badDenied.filter((entry) => entry.reason === "unknown-topic").length === 3,
			JSON.stringify(badDenied),
		);

		owner.send({ op: "ping", id: "p1" });
		const pong = await owner.waitFor((frame) => frame.op === "pong" && frame.id === "p1");
		check("a ping is answered with a pong", pong !== undefined);

		// Raw sends: the socket must survive frames that are not this protocol.
		(owner as unknown as { socket: WebSocket }).socket?.send?.("not json");
		owner.send({ op: "destroy-everything" } as never);
		const badFrame = await owner.waitFor(
			(frame) => frame.op === "error" && frame.code === "BAD_FRAME",
		);
		check("a frame that is not this protocol produces an error frame", badFrame !== undefined);
		owner.send({ op: "ping", id: "p2" });
		check(
			"…and the socket survives it",
			(await owner.waitFor((frame) => frame.op === "pong" && frame.id === "p2")) !== undefined,
		);

		// --- 4. registration fan-out ---------------------------------------------------------------
		console.log("\n4. registrations fan out, shaped and org-scoped");
		const aorHashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const bindingA = {
			orgId: organizationA,
			aor: "sip:1001@a.example",
			aorHash: aorHashA,
			contact: "sip:1001@192.0.2.10:5060",
			transport: "udp",
			registeredAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			expiresInSeconds: 300,
		};
		owner.clear();
		await registrations.put(
			kvKeyFor.registration(organizationA, aorHashA),
			encoder.encode(JSON.stringify(bindingA)),
		);
		const registrationEvent = await owner.waitFor(eventOn("registrations", "put"));
		check("a registration write reaches the subscriber", registrationEvent !== undefined);
		check(
			"…carrying the parsed binding, not raw bytes",
			(registrationEvent?.data as { aor?: string } | undefined)?.aor === "sip:1001@a.example",
			JSON.stringify(registrationEvent?.data ?? {}).slice(0, 120),
		);
		check(
			"…and the KV key, which is the only identity a later delete can carry",
			registrationEvent?.key === kvKeyFor.registration(organizationA, aorHashA),
			String(registrationEvent?.key ?? ""),
		);

		await registrations.delete(kvKeyFor.registration(organizationA, aorHashA));
		const registrationGone = await owner.waitFor(eventOn("registrations", "delete"));
		check("a de-registration reaches the subscriber as a delete", registrationGone !== undefined);
		check(
			"…naming the key that went away, since a deletion has no value to send",
			registrationGone?.key === kvKeyFor.registration(organizationA, aorHashA) &&
				registrationGone.data === null,
			`${String(registrationGone?.key ?? "")} data=${JSON.stringify(registrationGone?.data)}`,
		);

		// Written back so the snapshot check below has something to find. The buffer is cleared
		// BEFORE the write and awaited after it: `waitFor` scans the whole buffer, so waiting on a
		// buffer that still holds the earlier `put` would return instantly and the clear below would
		// land while this frame was still in flight — which is the classic way a push-protocol test
		// attributes one assertion's traffic to the next.
		owner.clear();
		await registrations.put(
			kvKeyFor.registration(organizationA, aorHashA),
			encoder.encode(JSON.stringify(bindingA)),
		);
		await owner.waitFor(eventOn("registrations", "put"));

		owner.clear();
		await registrations.put(
			kvKeyFor.registration(organizationA, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
			encoder.encode(JSON.stringify({ orgId: organizationA, aor: "broken" })),
		);
		await delay(600);
		check(
			"an entry that does not match its contract is dropped, not forwarded",
			owner.matching(eventOn("registrations")).length === 0,
			`${String(owner.matching(eventOn("registrations")).length)} frame(s)`,
		);

		// --- 5. organization isolation -------------------------------------------------------------
		console.log("\n5. two tenants, no cross-talk");
		const bOpened = await LiveClient.open(baseUrl, jarB.header());
		if (bOpened.client === undefined) {
			check("organization B connects", false, `status ${String(bOpened.status ?? "-")}`);
			throw new Error("cannot continue without B's connection");
		}
		const ownerB = bOpened.client;
		openClients.push(ownerB);
		ownerB.send({ op: "subscribe", topics: ["registrations", "active-calls"], id: "b1" });
		await ownerB.waitFor((frame) => frame.op === "subscribed" && frame.id === "b1");
		ownerB.clear();
		owner.clear();

		await registrations.put(
			kvKeyFor.registration(organizationA, "cccccccccccccccccccccccccccccccc"),
			encoder.encode(
				JSON.stringify({ ...bindingA, aorHash: "cccccccccccccccccccccccccccccccc" }),
			),
		);
		const aSaw = await owner.waitFor(eventOn("registrations", "put"));
		await delay(400);
		check("A's own registration reaches A", aSaw !== undefined);
		check(
			"…and reaches nobody in B",
			ownerB.matching(eventOn("registrations")).length === 0,
			`${String(ownerB.matching(eventOn("registrations")).length)} frame(s) leaked`,
		);

		const bindingB = {
			...bindingA,
			orgId: organizationB,
			aor: "sip:2001@b.example",
			aorHash: "dddddddddddddddddddddddddddddddd",
		};
		owner.clear();
		ownerB.clear();
		await registrations.put(
			kvKeyFor.registration(organizationB, bindingB.aorHash),
			encoder.encode(JSON.stringify(bindingB)),
		);
		const bSaw = await ownerB.waitFor(eventOn("registrations", "put"));
		await delay(400);
		check("B's own registration reaches B", bSaw !== undefined);
		check(
			"…and reaches nobody in A",
			owner.matching(eventOn("registrations")).length === 0,
			`${String(owner.matching(eventOn("registrations")).length)} frame(s) leaked`,
		);

		/**
		 * A value naming one tenant filed under another's key. The key filter constrains the KEY; the
		 * schema check constrains the VALUE, and only the second catches this.
		 */
		owner.clear();
		await registrations.put(
			kvKeyFor.registration(organizationA, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
			encoder.encode(
				JSON.stringify({ ...bindingB, aorHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }),
			),
		);
		await delay(600);
		check(
			"an entry whose VALUE names another organization is refused, not just mis-keyed",
			owner.matching(eventOn("registrations")).length === 0,
		);

		// --- 6. snapshots --------------------------------------------------------------------------
		console.log("\n6. a fresh subscribe is answered with the current state");
		const resub = await LiveClient.open(baseUrl, jarA.header());
		if (resub.client === undefined) {
			check("a second connection for A opens", false);
			throw new Error("cannot continue");
		}
		const late = resub.client;
		openClients.push(late);
		await late.waitFor((frame) => frame.op === "welcome");
		late.send({ op: "subscribe", topics: ["registrations"], id: "l1" });
		const snapshot = await late.waitFor(snapshotOn("registrations"));
		const snapshotRows =
			(snapshot?.data as { key: string; value: { aor?: string; orgId?: string } }[] | undefined) ??
			[];
		check("a snapshot arrives on subscribe", snapshot !== undefined);
		check(
			"…holding the registrations written before this client existed",
			snapshotRows.some((row) => row.value.aor === "sip:1001@a.example"),
			`${String(snapshotRows.length)} row(s)`,
		);
		check(
			"…as key/value pairs, so a later delete can be matched to a row",
			snapshotRows.every((row) => typeof row.key === "string" && row.key.startsWith(organizationA)),
			JSON.stringify(snapshotRows.map((row) => row.key)),
		);
		check(
			"…and only this organization's",
			snapshotRows.every((row) => row.value.orgId === organizationA),
			JSON.stringify(snapshotRows.map((row) => row.value.orgId)),
		);

		// --- 7. active calls -----------------------------------------------------------------------
		console.log("\n7. channels fan out on the active-calls topic");
		owner.clear();
		const callId = "0195c0f0-1c2f-7000-8000-0000000000c1";
		const legId = "0195c0f0-1c2f-7000-8000-0000000000c2";
		await channels.put(
			kvKeyFor.channel(organizationA, callId, legId),
			encoder.encode(
				JSON.stringify({
					channelId: legId,
					callId,
					organizationId: organizationA,
					direction: "inbound",
					state: "executing",
					callState: "active",
					flags: ["answered"],
					profile: { destinationNumber: "1001", context: "optimiq-inbound" },
					variables: {},
					createdAt: Date.now(),
				}),
			),
		);
		const channelEvent = await owner.waitFor(eventOn("active-calls", "put"));
		check("a live channel reaches the active-calls subscriber", channelEvent !== undefined);
		check(
			"…carrying the call it belongs to",
			(channelEvent?.data as { callId?: string } | undefined)?.callId === callId,
		);

		// --- 8. queue events ------------------------------------------------------------------------
		console.log("\n8. queue events are filtered to the queue that asked for them");
		const queueOne = "0195c0f0-1c2f-7000-8000-0000000000e1";
		const queueTwo = "0195c0f0-1c2f-7000-8000-0000000000e2";
		owner.send({ op: "subscribe", topics: [`queue:${queueOne}`], id: "q1" });
		await owner.waitFor((frame) => frame.op === "subscribed" && frame.id === "q1");
		owner.clear();

		const joined = makeQueueEvent("caller.joined", {
			orgId: organizationA,
			queueId: queueOne,
			source: "engine",
			data: {
				callId,
				legId,
				position: 1,
				priority: 0,
				callerNumber: "+15550001",
			},
		});
		await connection.publish(joined.subject, encoder.encode(JSON.stringify(joined)));
		const joinedFrame = await owner.waitFor(eventOn(`queue:${queueOne}`, "caller.joined"));
		check("a caller.joined reaches the queue's subscriber", joinedFrame !== undefined);

		const otherQueue = makeQueueEvent("caller.joined", {
			orgId: organizationA,
			queueId: queueTwo,
			source: "engine",
			data: { callId, legId, position: 1, priority: 0 },
		});
		owner.clear();
		await connection.publish(otherQueue.subject, encoder.encode(JSON.stringify(otherQueue)));
		await delay(500);
		check(
			"another queue's caller.joined does not",
			owner.matching(eventOn(`queue:${queueOne}`)).length === 0,
			`${String(owner.matching(eventOn(`queue:${queueOne}`)).length)} frame(s)`,
		);

		// --- 9. the agent-session surface -----------------------------------------------------------
		console.log("\n9. the control plane writes the transitions the engine refuses");
		const extension = await clientA("POST", "/api/v1/extensions", {
			number: "1001",
			label: "Live Agent Phone",
			sipSecretRef: "secret://verify-live/1001",
		});
		const extensionId = String((extension.body.data as { id?: string } | undefined)?.id ?? "");
		const agentUser = await sql<{ id: string }[]>`select "id" from "user" where "email" = ${agentEmail}`;
		const linkedUserId = agentUser[0]?.id ?? "";
		const queueRow = await clientA("POST", "/api/v1/queues", {
			name: `Support ${RUN_ID}`,
			strategy: "longest-idle",
		});
		const queueId = String((queueRow.body.data as { id?: string } | undefined)?.id ?? "");
		const agentRow = await clientA("POST", "/api/v1/queue-agents", {
			name: `Live Agent ${RUN_ID}`,
			contactKind: "extension",
			extensionId,
			userId: linkedUserId,
		});
		const agentId = String((agentRow.body.data as { id?: string } | undefined)?.id ?? "");
		check("an agent linked to a user was created", agentId.length > 0 && linkedUserId.length > 0);

		await clientA("POST", `/api/v1/queues/${queueId}/tiers`, {
			queueAgentId: agentId,
			level: 1,
			position: 1,
		});

		agentLive.send({ op: "subscribe", topics: ["agent-state"], id: "a2" });
		await agentLive.waitFor((frame) => frame.op === "subscribed" && frame.id === "a2");
		agentLive.clear();

		const login = await clientAgent("POST", `/api/v1/queue-agents/${agentId}/session/login`, {});
		check("an agent logs THEMSELVES in with queues.join.own", login.status === 201 || login.status === 200, `status ${login.status}`);
		const loginData = login.body.data as { status?: string; live?: boolean } | undefined;
		check("…and the response reports the live status", loginData?.status === "available", JSON.stringify(loginData ?? {}));

		const loginEvent = await agentLive.waitFor(eventOn("agent-state", "put"));
		check("…and the transition arrives on the socket", loginEvent !== undefined);
		check(
			"…written by the api, not the engine",
			(loginEvent?.data as { source?: string } | undefined)?.source === "api",
			JSON.stringify(loginEvent?.data ?? {}).slice(0, 120),
		);

		const kvEntry = await agentStateBucket.get(kvKeyFor.agentState(organizationA, agentId));
		check(
			"…and is in the agent-state bucket the engine reads",
			kvEntry !== null && JSON.parse(new TextDecoder().decode(kvEntry.value)).status === "available",
		);

		const again = await clientAgent("POST", `/api/v1/queue-agents/${agentId}/session/login`, {});
		check(
			"a repeated login is a no-op rather than an error",
			(again.status === 200 || again.status === 201) && again.body.changed === false,
			`status ${again.status} changed=${String(again.body.changed)}`,
		);

		const paused = await clientAgent("POST", `/api/v1/queue-agents/${agentId}/session/pause`, {
			reason: "Lunch",
		});
		check("an agent pauses with a reason", paused.status === 200 || paused.status === 201);
		check(
			"…and the reason is on the live state",
			(paused.body.data as { reason?: string } | undefined)?.reason === "Lunch",
			JSON.stringify(paused.body.data ?? {}),
		);

		const badResume = await clientAgent(
			"POST",
			`/api/v1/queue-agents/${agentId}/session/login`,
			{},
		);
		check(
			"logging in from a break is allowed — it is what login means",
			badResume.status === 200 || badResume.status === 201,
			`status ${badResume.status}`,
		);

		const otherExtension = await clientA("POST", "/api/v1/extensions", {
			number: "1002",
			label: "Second Agent Phone",
			sipSecretRef: "secret://verify-live/1002",
		});
		const otherAgent = await clientA("POST", "/api/v1/queue-agents", {
			name: `Other Agent ${RUN_ID}`,
			contactKind: "extension",
			extensionId: String((otherExtension.body.data as { id?: string } | undefined)?.id ?? ""),
		});
		const otherAgentId = String((otherAgent.body.data as { id?: string } | undefined)?.id ?? "");
		check("a second, unlinked agent was created", otherAgentId.length > 0, `status ${otherAgent.status}`);
		const forbidden = await clientAgent(
			"POST",
			`/api/v1/queue-agents/${otherAgentId}/session/login`,
			{},
		);
		check(
			"queues.join.own does not reach somebody else's seat",
			forbidden.status === 403 && forbidden.body.code === "QUEUE_AGENT_SESSION_FORBIDDEN",
			`status ${forbidden.status} ${String(forbidden.body.code ?? "")}`,
		);

		const supervisorLogin = await clientA(
			"POST",
			`/api/v1/queue-agents/${otherAgentId}/session/login`,
			{},
		);
		check(
			"an owner may move anybody's availability",
			supervisorLogin.status === 200 || supervisorLogin.status === 201,
			`status ${supervisorLogin.status}`,
		);

		const me = await clientAgent("GET", "/api/v1/queue-agents/session/me");
		check(
			"an agent can find their own seat",
			me.status === 200 && (me.body.data as { agentId?: string } | undefined)?.agentId === agentId,
			JSON.stringify(me.body.data ?? {}),
		);

		const strangerMe = await clientB("GET", "/api/v1/queue-agents/session/me");
		check(
			"a member with no seat gets null rather than an error",
			strangerMe.status === 200 && strangerMe.body.data === null,
			JSON.stringify(strangerMe.body),
		);

		const namedStatus = await clientA("POST", `/api/v1/queue-agents/${agentId}/session/pause`, {
			status: "available",
		});
		check(
			"a body that tries to name a status is refused — the action is the path",
			namedStatus.status === 400,
			`status ${namedStatus.status}`,
		);

		// --- 10. the queue-membership projection ----------------------------------------------------
		console.log("\n10. the roster reaches the bucket the engine distributes from");
		await delay(700);
		const rosterEntry = await membership.get(kvKeyFor.queueMembership(organizationA, queueId));
		const roster =
			rosterEntry === null
				? undefined
				: (JSON.parse(new TextDecoder().decode(rosterEntry.value)) as {
						agents: { contact: string; agentId: string; level: number }[];
						revision?: number;
					});
		check("the queue has a roster in the queue-membership bucket", roster !== undefined);
		check(
			"…holding the tiered agent",
			roster?.agents.some((agent) => agent.agentId === agentId) === true,
			JSON.stringify(roster?.agents.map((agent) => agent.agentId) ?? []),
		);
		check(
			"…with the dial string resolved from the extension, not the extension id",
			roster?.agents[0]?.contact === "PJSIP/1001",
			String(roster?.agents[0]?.contact ?? ""),
		);

		await clientA("PATCH", `/api/v1/extensions/${extensionId}`, { number: "1099" });
		await delay(700);
		const renumbered = await membership.get(kvKeyFor.queueMembership(organizationA, queueId));
		const afterRenumber =
			renumbered === null
				? undefined
				: (JSON.parse(new TextDecoder().decode(renumbered.value)) as {
						agents: { contact: string }[];
						revision?: number;
					});
		check(
			"renumbering an extension moves the roster that dials it",
			afterRenumber?.agents[0]?.contact === "PJSIP/1099",
			String(afterRenumber?.agents[0]?.contact ?? ""),
		);
		check(
			"…and advances the revision the engine logs",
			(afterRenumber?.revision ?? 0) > (roster?.revision ?? 0),
			`${String(roster?.revision)} -> ${String(afterRenumber?.revision)}`,
		);

		const removed = await clientA("DELETE", `/api/v1/queues/${queueId}`);
		await delay(700);
		const goneRoster = await membership.get(kvKeyFor.queueMembership(organizationA, queueId));
		check(
			"deleting a queue removes its roster",
			removed.status === 200 && (goneRoster === null || goneRoster.value.length === 0),
			`status ${removed.status}`,
		);

		// --- 11. ref-counted teardown ---------------------------------------------------------------
		console.log("\n11. the upstream is opened once and closed when the last client leaves");
		const openWhileWatching = hub.openSources;
		check(
			"upstreams are open while clients are subscribed",
			openWhileWatching.length > 0,
			openWhileWatching.map((entry) => `${entry.key}=${String(entry.refs)}`).join(" "),
		);
		const registrationSources = openWhileWatching.filter((entry) =>
			entry.key.endsWith("/registrations-kv"),
		);
		check(
			"one organization's registrations watch is opened ONCE however many tabs want it",
			registrationSources.filter((entry) => entry.key.startsWith(organizationA)).length === 1,
			registrationSources.map((entry) => `${entry.key}=${String(entry.refs)}`).join(" "),
		);
		check(
			"…and its ref count matches the number of subscribers holding it",
			(registrationSources.find((entry) => entry.key.startsWith(organizationA))?.refs ?? 0) >= 2,
			String(registrationSources.find((entry) => entry.key.startsWith(organizationA))?.refs ?? 0),
		);

		owner.send({ op: "unsubscribe", topics: ["registrations"], id: "u1" });
		const unsubscribed = await owner.waitFor(
			(frame) => frame.op === "unsubscribed" && frame.id === "u1",
		);
		check("an unsubscribe is acknowledged", unsubscribed !== undefined);
		await delay(200);
		check(
			"…and drops the reference without closing a watch another client holds",
			hub.openSources.some(
				(entry) => entry.key === `${organizationA}/registrations-kv` && entry.refs >= 1,
			),
			hub.openSources.map((entry) => `${entry.key}=${String(entry.refs)}`).join(" "),
		);

		for (const client of openClients) {
			await client.close();
		}
		await delay(500);
		check(
			"every upstream is closed once the last client disconnects",
			hub.openSources.length === 0,
			hub.openSources.map((entry) => `${entry.key}=${String(entry.refs)}`).join(" ") || "(none)",
		);
	} catch (error) {
		check("the run completed without an unexpected error", false, String(error));
	} finally {
		console.log("\ncleaning up");
		for (const client of openClients) {
			await client.close();
		}
		try {
			await connection.drain();
		} catch {
			// Already closed.
		}
		try {
			await app.close();
			if (organizationA) {
				await sql`delete from "organization" where "id" = ${organizationA}`;
			}
			if (organizationB) {
				await sql`delete from "organization" where "id" = ${organizationB}`;
			}
			await sql`delete from "user" where "email" in (${ownerAEmail}, ${ownerBEmail}, ${agentEmail})`;
			const { createPbxDatabaseClient, sql: pbxSql } = await import("@optimiq-voice/pbx-db");
			const pbx = createPbxDatabaseClient({
				url: pbxDatabaseUrl,
				applicationName: "verify-live-cleanup",
				poolMaxConnectionsOverride: 2,
			});
			try {
				for (const organizationId of [organizationA, organizationB].filter(Boolean)) {
					await pbx.withTenantScope(organizationId, async (transaction) => {
						for (const table of ["queue_tier", "queue_agent", "queue", "extension"]) {
							await transaction.execute(pbxSql`delete from ${pbxSql.identifier(table)}`);
						}
					});
				}
			} finally {
				await pbx.close();
			}
		} catch (error) {
			console.error("cleanup failed", error);
		}
		await sql.end({ timeout: 5 });
		if (nats.containerId !== undefined) {
			try {
				await execFileAsync("docker", ["rm", "-f", nats.containerId]);
			} catch (error) {
				console.error("could not remove the NATS container", error);
			}
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) {
		console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log("live-operations verification PASSED");
}

await main();
