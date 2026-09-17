/**
 * A load harness for the live WebSocket gateway's fan-out path.
 *
 * ## What it measures, and why this shape
 *
 * The gateway's cost is dominated by one loop: `fanOut` walks every connection, and for every
 * topic on it that matches the message writes a frame. With N wallboard tabs on one organization
 * all watching the same topics, that loop runs N times per upstream event — so its per-event cost
 * is the whole capacity question for the feature, and it is not visible in any unit test.
 *
 * Everything below the socket is REAL: a real `node:http` server, a real `ws` handshake, real
 * client sockets on loopback, the real `LiveGateway`. What is faked is precisely the two things a
 * fan-out benchmark must not stand up — the auth platform (a benchmark that measured
 * `auth.api.getSession` would be measuring Postgres) and `LiveHub`'s NATS upstreams (a benchmark
 * that measured a broker would be measuring the broker). The hub fake is driven through the same
 * `addListener` seam the real hub emits on, so the code path under measurement is byte-identical
 * to production from `fanOut` down.
 *
 * ## How to run
 *
 *   pnpm --filter @optimiq-voice/api exec tsx scripts/bench-live-fanout.ts
 *   CLIENTS=2000 EVENTS=20000 TOPICS=4 pnpm --filter @optimiq-voice/api exec tsx \
 *     scripts/bench-live-fanout.ts
 *
 * Environment: `CLIENTS` (default 500), `EVENTS` (default 5000), `TOPICS` (per client, default 3),
 * `PAYLOAD` (bytes of filler in each event's value, default 400).
 *
 * It prints per-event CPU, encode count, bytes written and steady-state memory. Absolute latency on
 * a loaded developer machine is noise; the numbers to compare across a change are `encodes/event`,
 * `cpu us/event` and `rss delta`.
 */
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { LiveGateway } from "../src/live/live-gateway";
import type { AuthPlatform } from "../src/auth/auth.platform";
import type { AuthService } from "../src/auth/auth.service";
import type { LiveHub, LiveHubListener, LiveHubMessage } from "../src/live/live-hub.service";
import type { Permission } from "@optimiq-voice/auth";

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";

const CLIENTS = Number(process.env.CLIENTS ?? 500);
const EVENTS = Number(process.env.EVENTS ?? 5_000);
const TOPICS = Number(process.env.TOPICS ?? 3);
const PAYLOAD = Number(process.env.PAYLOAD ?? 400);

const PERMISSIONS: readonly Permission[] = [
	"extensions.read",
	"cdr.read",
	"queues.monitor",
	"voicemail.read",
	"trunks.read",
	"conferences.read",
] as Permission[];

const ALL_TOPICS = ["registrations", "active-calls", "agent-state", "trunks", "voicemail"];

function rawSession() {
	return {
		session: {
			id: "sess",
			userId: "user-1",
			token: "tok",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORG,
		},
		user: { id: "user-1", email: "a@b.c", name: "A", emailVerified: true },
	};
}

async function main(): Promise<void> {
	const listeners = new Set<LiveHubListener>();
	const hub = {
		isReady: true,
		addListener: (listener: LiveHubListener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		acquire: () => () => undefined,
		snapshot: async () => [],
	} as unknown as LiveHub;

	const platform = {
		auth: { api: { getSession: async () => rawSession() } },
		config: { trustedOrigins: ["http://localhost"] },
	} as unknown as AuthPlatform;

	const authService = {
		resolveAccess: async () => ({ organizationId: ORG, role: "owner", permissions: PERMISSIONS }),
	} as unknown as AuthService;

	const gateway = new LiveGateway(platform, authService, hub);
	gateway.start();

	const server: Server = createServer();
	server.on("upgrade", (request, socket, head) => {
		void gateway.handleUpgrade(request, socket, head).then((claimed) => {
			if (!claimed) {
				socket.destroy();
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	// Bytes actually written by the server, counted on the client side so the number is what left
	// the process rather than what the gateway believes it sent.
	let received = 0;
	let frames = 0;

	const sockets: WebSocket[] = [];
	const topics = ALL_TOPICS.slice(0, TOPICS);
	for (let index = 0; index < CLIENTS; index += 1) {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/live`);
		socket.on("message", (data: Buffer) => {
			received += data.length;
			frames += 1;
		});
		sockets.push(socket);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		socket.send(JSON.stringify({ op: "subscribe", topics }));
	}
	await delay(500);

	const filler = "x".repeat(PAYLOAD);
	const message = (sequence: number): LiveHubMessage => ({
		organizationId: ORG,
		source: "registrations-kv",
		kind: "put",
		at: new Date().toISOString(),
		key: `${ORG}.aor-${sequence % 200}`,
		data: { orgId: ORG, aor: `aor-${sequence % 200}`, seq: sequence, filler },
	});

	received = 0;
	frames = 0;
	global.gc?.();
	const rssBefore = process.memoryUsage().rss;
	const cpuBefore = process.cpuUsage();
	const start = process.hrtime.bigint();
	for (let sequence = 0; sequence < EVENTS; sequence += 1) {
		const value = message(sequence);
		for (const listener of listeners) {
			listener(value);
		}
	}
	const elapsedNs = Number(process.hrtime.bigint() - start);
	const cpu = process.cpuUsage(cpuBefore);
	// Let the socket writes drain so `received` reflects the whole run.
	await delay(2_000);
	const rssAfter = process.memoryUsage().rss;

	const perEvent = (value: number) => (value / EVENTS).toFixed(2);
	process.stdout.write(
		[
			`clients            ${CLIENTS}`,
			`topics/client      ${topics.length}`,
			`events             ${EVENTS}`,
			`wall ms            ${(elapsedNs / 1e6).toFixed(1)}`,
			`cpu us/event       ${perEvent((cpu.user + cpu.system) / 1)}`,
			`frames delivered   ${frames} (${perEvent(frames)}/event)`,
			`bytes to clients   ${received} (${perEvent(received)}/event)`,
			`rss delta MiB      ${((rssAfter - rssBefore) / 1024 / 1024).toFixed(1)}`,
			`gateway stats      ${JSON.stringify(gateway.stats)}`,
			"",
		].join("\n"),
	);

	for (const socket of sockets) {
		socket.terminate();
	}
	await gateway.onApplicationShutdown();
	server.close();
	process.exit(0);
}

void main();
