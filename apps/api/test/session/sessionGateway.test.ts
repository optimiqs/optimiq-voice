import { createServer, type Server } from "node:http";
import { expect } from "chai";
import { WebSocket } from "ws";
import { SessionGateway } from "../../src/session/session-gateway";
import type { AuthPlatform } from "../../src/auth/auth.platform";
import type { AuthService } from "../../src/auth/auth.service";
import type { SessionHub } from "../../src/session/session-hub.service";
import type {
	CallEventEnvelope,
	SessionAnnounceRequest,
	SessionAnnounceResponse,
	SessionVerbRequest,
	SessionVerbResponse,
} from "@optimiq-voice/events/schemas";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The session-protocol gateway, over a real HTTP server and a real WebSocket client.
 *
 * A real socket rather than a fake, because the three things most worth proving about this surface
 * are all properties of the HANDSHAKE and of what happens when it ends: an unauthorized caller must
 * get an HTTP status and not a close frame, a caller without `calls.control` must be refused at the
 * upgrade rather than accepted and starved, and a socket that dies mid-call must hang its calls up
 * rather than leave a customer connected to a process that has forgotten them. None of those is
 * observable through a stubbed `WebSocketServer`.
 *
 * The broker side is a fake — `SessionHub`'s own upstreams are its business, and standing up NATS
 * to assert that a `claim` frame reaches `hub.claim` would be testing the broker.
 */

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";
const OTHER_ORG = "018f2b7c-0000-7000-8000-0000000000bb";

function rawSession(organizationId: string | null = ORG) {
	return {
		session: {
			id: "sess",
			userId: "user-1",
			token: "tok",
			expiresAt: new Date(Date.now() + 60_000),
			activeOrganizationId: organizationId,
		},
		user: { id: "user-1", email: "a@b.c", name: "A", emailVerified: true },
	};
}

interface HarnessOptions {
	readonly session?: ReturnType<typeof rawSession> | null;
	readonly permissions?: readonly string[];
	readonly claimable?: boolean;
	readonly verbResponse?: SessionVerbResponse;
}

/** A gateway on a real port, with a fake platform, a fake access resolver and a fake hub. */
async function harness(options: HarnessOptions = {}) {
	const verbs: SessionVerbRequest[] = [];
	const claims: { organizationId: string; application: string }[] = [];
	const releases: string[] = [];
	const taps: { callId: string; stopped: boolean }[] = [];
	let announce: ((request: SessionAnnounceRequest) => Promise<SessionAnnounceResponse>) | undefined;
	let emit: ((event: CallEventEnvelope) => void) | undefined;

	const hub = {
		isReady: true,
		claim: (
			organizationId: string,
			application: string,
			onAnnounce: (request: SessionAnnounceRequest) => Promise<SessionAnnounceResponse>,
		) => {
			claims.push({ organizationId, application });
			if (options.claimable === false) {
				return undefined;
			}
			announce = onAnnounce;
			return () => {
				releases.push(application);
			};
		},
		sendVerb: async (_instanceId: string, request: SessionVerbRequest) => {
			verbs.push(request);
			return (
				options.verbResponse ?? {
					ok: true,
					verb: request.verb,
					instanceId: "engine-1",
					endReason: "completed",
				}
			);
		},
		watchCall: (_org: string, callId: string, onEvent: (event: CallEventEnvelope) => void) => {
			const tap = { callId, stopped: false };
			taps.push(tap);
			emit = onEvent;
			return () => {
				tap.stopped = true;
			};
		},
	} as unknown as SessionHub;

	const platform = {
		auth: {
			api: {
				getSession: async () => (options.session === undefined ? rawSession() : options.session),
			},
		},
		config: { trustedOrigins: ["https://app.example.com"] },
	} as unknown as AuthPlatform;

	const authService = {
		resolveAccess: async () => ({
			organizationId: ORG,
			role: "admin",
			permissions: options.permissions ?? ["calls.control"],
		}),
	} as unknown as AuthService;

	const gateway = new SessionGateway(platform, authService, hub);
	const server: Server = createServer();
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		void gateway.handleUpgrade(request, socket, head).catch(() => socket.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;

	return {
		gateway,
		hub,
		verbs,
		claims,
		releases,
		taps,
		port,
		announce: async (request: SessionAnnounceRequest) => {
			if (announce === undefined) {
				throw new Error("nothing has claimed an application");
			}
			return await announce(request);
		},
		emit: (event: CallEventEnvelope) => {
			emit?.(event);
		},
		close: async () => {
			await gateway.onApplicationShutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Opens a client socket and collects every frame it receives. */
async function client(port: number, headers: Record<string, string> = {}) {
	const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/v1/session`, { headers });
	const frames: Record<string, unknown>[] = [];
	socket.on("message", (data) => {
		frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return {
		socket,
		frames,
		send: (frame: unknown) => {
			socket.send(JSON.stringify(frame));
		},
		/** Waits until a frame with this `op` arrives, or gives up. */
		waitFor: async (op: string): Promise<Record<string, unknown>> => {
			for (let attempt = 0; attempt < 200; attempt += 1) {
				const found = frames.find((frame) => frame.op === op);
				if (found !== undefined) {
					return found;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`no ${op} frame arrived; saw ${frames.map((f) => f.op).join(", ")}`);
		},
	};
}

/** Attempts an upgrade and resolves with the HTTP status the server refused it with. */
async function refusedStatus(port: number, headers: Record<string, string> = {}): Promise<number> {
	const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/v1/session`, { headers });
	return await new Promise<number>((resolve, reject) => {
		socket.once("unexpected-response", (_request, response) => {
			resolve(response.statusCode ?? 0);
		});
		socket.once("open", () => {
			socket.close();
			reject(new Error("the upgrade was accepted"));
		});
		socket.once("error", (error) => {
			// `unexpected-response` fires first for an HTTP refusal; anything else is a real failure.
			setTimeout(() => reject(error), 20);
		});
	});
}

describe("the session gateway's upgrade", () => {
	it("accepts an authorized caller and welcomes it with its organization", async () => {
		const h = await harness();
		const c = await client(h.port);
		const welcome = await c.waitFor("welcome");
		expect(welcome.orgId).to.equal(ORG);
		c.socket.close();
		await h.close();
	});

	/**
	 * 401 on the wire, not a close frame. It is the only thing that lets a reconnecting integration
	 * tell "your credential expired" from "the server is down" — one of those terminates a backoff
	 * loop and the other does not.
	 */
	it("refuses an anonymous caller with 401 before the handshake", async () => {
		const h = await harness({ session: null });
		expect(await refusedStatus(h.port)).to.equal(401);
		await h.close();
	});

	/**
	 * The grant is checked at the UPGRADE. A socket accepted without it could claim nothing and
	 * receive nothing, which looks — from the client's side — exactly like an integration nobody is
	 * calling, and is the single most expensive way to fail this feature.
	 */
	it("refuses a caller without calls.control with 403", async () => {
		const h = await harness({ permissions: ["cdr.read", "calls.originate"] });
		expect(await refusedStatus(h.port)).to.equal(403);
		await h.close();
	});

	it("refuses an untrusted browser origin, because CORS does not gate a WebSocket", async () => {
		const h = await harness();
		expect(await refusedStatus(h.port, { origin: "https://evil.example.com" })).to.equal(403);
		await h.close();
	});

	it("allows a client that sends no Origin at all — an integration process is not a browser", async () => {
		const h = await harness();
		const c = await client(h.port);
		await c.waitFor("welcome");
		c.socket.close();
		await h.close();
	});
});

describe("claiming an application", () => {
	it("claims for the SESSION's organization, never one the client names", async () => {
		const h = await harness();
		const c = await client(h.port);
		await c.waitFor("welcome");

		c.send({ op: "claim", applications: ["crm"], id: "c1" });
		const claimed = await c.waitFor("claimed");
		expect(claimed).to.deep.include({ applications: ["crm"], denied: [], id: "c1" });
		expect(h.claims).to.deep.equal([{ organizationId: ORG, application: "crm" }]);
		expect(ORG).to.not.equal(OTHER_ORG);

		c.socket.close();
		await h.close();
	});

	/**
	 * The no-socket failure path, from this side. A claim the hub cannot take is DENIED with a
	 * reason, so an integration finds out at startup rather than discovering it by never being
	 * called; the caller's half of the same story is the walker announcing.
	 */
	it("denies a claim the hub cannot take, with a reason", async () => {
		const h = await harness({ claimable: false });
		const c = await client(h.port);
		await c.waitFor("welcome");

		c.send({ op: "claim", applications: ["crm"] });
		const claimed = await c.waitFor("claimed");
		expect(claimed.applications).to.deep.equal([]);
		expect(claimed.denied).to.deep.equal([{ application: "crm", reason: "already-claimed" }]);

		c.socket.close();
		await h.close();
	});

	it("releases a claim without touching the calls already in flight", async () => {
		const h = await harness();
		const c = await client(h.port);
		await c.waitFor("welcome");
		c.send({ op: "claim", applications: ["crm"] });
		await c.waitFor("claimed");

		const accepted = await h.announce(announcement());
		expect(accepted.accepted).to.equal(true);

		c.send({ op: "release", applications: ["crm"] });
		const released = await c.waitFor("released");
		expect(released.applications).to.deep.equal(["crm"]);
		expect(h.releases).to.deep.equal(["crm"]);
		// The live call is untouched: releasing decides who gets the NEXT call, not who keeps this one.
		expect(h.gateway.stats.sessions).to.equal(1);

		c.socket.close();
		await h.close();
	});
});

function announcement(overrides: Partial<SessionAnnounceRequest> = {}): SessionAnnounceRequest {
	return {
		orgId: ORG,
		application: "crm",
		callId: "call-1",
		legId: "leg-1",
		instanceId: "engine-1",
		direction: "inbound",
		answered: false,
		callerIdNumber: "+15551230000",
		at: new Date().toISOString(),
		...overrides,
	};
}

describe("a session's life", () => {
	async function claimed() {
		const h = await harness();
		const c = await client(h.port);
		await c.waitFor("welcome");
		c.send({ op: "claim", applications: ["crm"] });
		await c.waitFor("claimed");
		return { h, c };
	}

	it("announces an arriving call to the socket and answers the engine with a session id", async () => {
		const { h, c } = await claimed();
		const answer = await h.announce(announcement());

		expect(answer.accepted).to.equal(true);
		const started = await c.waitFor("session.started");
		expect(started).to.include({
			application: "crm",
			callId: "call-1",
			legId: "leg-1",
			answered: false,
			callerIdNumber: "+15551230000",
		});
		expect(started.sessionId).to.equal(answer.sessionId);
		// The tap on that call's events opened with the session.
		expect(h.taps.map((tap) => tap.callId)).to.deep.equal(["call-1"]);

		c.socket.close();
		await h.close();
	});

	/**
	 * Every identifier on a relayed verb comes from the SESSION. A client supplies a session id and a
	 * verb; it does not get to say which leg, which call or which tenant — that is what makes the
	 * session id a capability rather than a hint.
	 */
	it("relays a verb with the session's own identifiers, not the client's", async () => {
		const { h, c } = await claimed();
		const answer = await h.announce(announcement());

		c.send({
			op: "verb",
			sessionId: answer.sessionId,
			verb: "play",
			arguments: { media: "sound:hello" },
			id: "v1",
		});
		const result = await c.waitFor("result");
		expect(result).to.include({ ok: true, verb: "play", id: "v1" });
		expect(h.verbs).to.deep.equal([
			{
				orgId: ORG,
				sessionId: answer.sessionId as string,
				callId: "call-1",
				legId: "leg-1",
				verb: "play",
				arguments: { media: "sound:hello" },
			},
		]);

		c.socket.close();
		await h.close();
	});

	it("refuses a verb for a session this socket does not hold", async () => {
		const { h, c } = await claimed();
		c.send({ op: "verb", sessionId: "somebody-elses", verb: "hangup" });
		const error = await c.waitFor("error");
		expect(error.code).to.equal("UNKNOWN_SESSION");
		expect(h.verbs).to.deep.equal([]);

		c.socket.close();
		await h.close();
	});

	it("fans the call's own events onto the socket, with no second vocabulary", async () => {
		const { h, c } = await claimed();
		const answer = await h.announce(announcement());

		h.emit({
			id: "e1",
			at: new Date().toISOString(),
			orgId: ORG,
			subject: `calls.evt.v1.${ORG}.call-1.channel.answered`,
			type: "channel.answered",
			source: "engine",
			data: { legId: "leg-1" },
		} as CallEventEnvelope);

		const event = await c.waitFor("event");
		expect(event).to.include({ type: "channel.answered", sessionId: answer.sessionId as string });

		c.socket.close();
		await h.close();
	});

	it("ends the session when the leg is destroyed, delivering the reason first", async () => {
		const { h, c } = await claimed();
		const answer = await h.announce(announcement());

		h.emit({
			id: "e2",
			at: new Date().toISOString(),
			orgId: ORG,
			subject: `calls.evt.v1.${ORG}.call-1.channel.destroyed`,
			type: "channel.destroyed",
			source: "engine",
			data: { legId: "leg-1" },
		} as CallEventEnvelope);

		const ended = await c.waitFor("session.ended");
		expect(ended).to.include({ sessionId: answer.sessionId as string, reason: "call-ended" });
		// The event that explained it arrived BEFORE the ending.
		expect(c.frames.findIndex((f) => f.op === "event")).to.be.lessThan(
			c.frames.findIndex((f) => f.op === "session.ended"),
		);
		expect(h.taps[0]?.stopped).to.equal(true);

		c.socket.close();
		await h.close();
	});

	/**
	 * The failure this gateway exists to prevent. A socket that dies mid-call leaves a customer
	 * connected to a process that has forgotten them; this is the only party that can see the socket
	 * close, so this is the party that ends the call.
	 */
	it("hangs a live call up when the socket closes", async () => {
		const { h, c } = await claimed();
		const answer = await h.announce(announcement());

		c.socket.close();
		for (let attempt = 0; attempt < 200 && h.verbs.length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(h.verbs).to.deep.equal([
			{
				orgId: ORG,
				sessionId: answer.sessionId as string,
				callId: "call-1",
				legId: "leg-1",
				verb: "hangup",
				arguments: { cause: "NORMAL_CLEARING" },
			},
		]);
		expect(h.releases).to.deep.equal(["crm"]);
		expect(h.taps[0]?.stopped).to.equal(true);

		await h.close();
	});

	it("refuses an offer when the socket has already gone, so the caller is announced to", async () => {
		const { h, c } = await claimed();
		c.socket.close();
		for (let attempt = 0; attempt < 100 && h.gateway.stats.connections > 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		const answer = await h.announce(announcement());
		expect(answer.accepted).to.equal(false);
		expect(answer.reason).to.equal("no-application");

		await h.close();
	});

	it("answers a bad frame with a reason instead of dropping the socket", async () => {
		const { h, c } = await claimed();
		c.socket.send("{not json");
		const error = await c.waitFor("error");
		expect(error.code).to.equal("BAD_FRAME");
		expect(c.socket.readyState).to.equal(WebSocket.OPEN);

		c.socket.close();
		await h.close();
	});

	it("answers an application-level ping, which a browser cannot send", async () => {
		const { h, c } = await claimed();
		c.send({ op: "ping", id: "p1" });
		const pong = await c.waitFor("pong");
		expect(pong.id).to.equal("p1");

		c.socket.close();
		await h.close();
	});
});
