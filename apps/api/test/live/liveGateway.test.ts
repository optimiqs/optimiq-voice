import { createServer, type Server } from "node:http";
import { expect } from "chai";
import { WebSocket } from "ws";
import { LiveGateway } from "../../src/live/live-gateway";
import { LIVE_CLOSE_TOO_SLOW } from "../../src/live/live-protocol";
import type { AuthPlatform } from "../../src/auth/auth.platform";
import type { AuthService } from "../../src/auth/auth.service";
import type { LiveHub, LiveHubListener, LiveHubMessage } from "../../src/live/live-hub.service";
import type { Permission } from "@optimiq-voice/auth";

/**
 * The live gateway's FAN-OUT properties, over a real HTTP server and real client sockets.
 *
 * Two things are asserted here that no protocol test can see, because both are about what happens
 * to N connections rather than to one frame:
 *
 * 1. every subscriber to a topic receives byte-identical bytes, which is what makes encoding the
 *    frame once per topic instead of once per socket a legitimate optimization rather than a
 *    coincidence that a future field could break; and
 * 2. a connection that stops reading is CLOSED rather than buffered without limit.
 *
 * The auth platform and the hub are fakes for the reason `sessionGateway.test.ts` gives: a test
 * that stood up better-auth and NATS to observe a fan-out loop would be observing better-auth and
 * NATS.
 */

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";

const PERMISSIONS = ["extensions.read", "cdr.read", "queues.monitor"] as unknown as Permission[];

function rawSession() {
	return {
		session: {
			id: "sess",
			userId: "user-1",
			token: "tok",
			expiresAt: new Date(Date.now() + 60_000),
			activeOrganizationId: ORG,
		},
		user: { id: "user-1", email: "a@b.c", name: "A", emailVerified: true },
	};
}

async function harness() {
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

	const emit = (message: LiveHubMessage) => {
		for (const listener of listeners) {
			listener(message);
		}
	};

	return {
		gateway,
		port,
		emit,
		close: async () => {
			await gateway.onApplicationShutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function connected(port: number): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/live`);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	return socket;
}

/** Resolves on the next frame whose `op` matches. */
function nextFrame(socket: WebSocket, op: string): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		const onMessage = (data: Buffer) => {
			const frame = JSON.parse(data.toString()) as Record<string, unknown>;
			if (frame.op === op) {
				socket.off("message", onMessage);
				resolve(frame);
			}
		};
		socket.on("message", onMessage);
	});
}

describe("live gateway fan-out", () => {
	it("delivers byte-identical event frames to every subscriber of a topic", async () => {
		const rig = await harness();
		try {
			const sockets = await Promise.all([
				connected(rig.port),
				connected(rig.port),
				connected(rig.port),
			]);
			const subscribed = sockets.map((socket) => nextFrame(socket, "subscribed"));
			for (const socket of sockets) {
				socket.send(JSON.stringify({ op: "subscribe", topics: ["registrations"] }));
			}
			await Promise.all(subscribed);

			const events = sockets.map(
				(socket) =>
					new Promise<string>((resolve) => {
						socket.on("message", (data: Buffer) => {
							const text = data.toString();
							if (text.includes('"op":"event"')) {
								resolve(text);
							}
						});
					}),
			);
			rig.emit({
				organizationId: ORG,
				source: "registrations-kv",
				kind: "put",
				at: "2026-01-01T00:00:00.000Z",
				key: `${ORG}.aor-1`,
				data: { orgId: ORG, aor: "aor-1" },
			});

			const [first, second, third] = await Promise.all(events);
			expect(second).to.equal(first);
			expect(third).to.equal(first);
			expect(JSON.parse(first)).to.deep.include({ op: "event", topic: "registrations" });
		} finally {
			await rig.close();
		}
	});

	it("closes a subscriber that stops reading rather than buffering it without limit", async () => {
		const rig = await harness();
		try {
			const socket = await connected(rig.port);
			const subscribed = nextFrame(socket, "subscribed");
			socket.send(JSON.stringify({ op: "subscribe", topics: ["registrations"] }));
			await subscribed;

			const closed = new Promise<number>((resolve) => {
				socket.once("close", (code: number) => resolve(code));
			});
			// Stop draining the socket at the TCP level. The server keeps writing into a queue that
			// nothing empties, which is exactly the suspended-laptop case the cap exists for.
			(socket as unknown as { _socket: { pause: () => void } })._socket.pause();

			const filler = "y".repeat(8 * 1024);
			// Comfortably past LIVE_MAX_BUFFERED_BYTES (4 MiB) once the kernel buffers fill.
			for (let index = 0; index < 4_000; index += 1) {
				rig.emit({
					organizationId: ORG,
					source: "registrations-kv",
					kind: "put",
					at: "2026-01-01T00:00:00.000Z",
					key: `${ORG}.aor-${index}`,
					data: { orgId: ORG, aor: `aor-${index}`, filler },
				});
			}

			expect(rig.gateway.stats.connections).to.equal(0);
			// The close frame itself cannot reach a paused client, so the code is observed after the
			// socket is allowed to drain again.
			(socket as unknown as { _socket: { resume: () => void } })._socket.resume();
			expect(await closed).to.equal(LIVE_CLOSE_TOO_SLOW);
		} finally {
			await rig.close();
		}
	});
});
