import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { WebSocket, WebSocketServer } from "ws";
import { getLogger } from "@optimiq-voice/logging";
import { toAppSession, type RawAuthSession } from "../auth/app-session";
import { AuthService } from "../auth/auth.service";
import { AUTH_PLATFORM } from "../auth/auth.tokens";
import { LiveHub } from "./live-hub.service";
import {
	LIVE_CLOSE_POLICY,
	LIVE_CLOSE_SERVER_SHUTDOWN,
	LIVE_HEARTBEAT_MS,
	LIVE_HEARTBEAT_TIMEOUT_MS,
	LIVE_MAX_FRAME_BYTES,
	LIVE_MAX_TOPICS_PER_CONNECTION,
	LIVE_PATH,
	parseClientFrame,
	type LiveDeniedTopic,
	type LiveServerFrame,
} from "./live-protocol";
import {
	allowedTopicKinds,
	mayReadTopic,
	parseLiveTopic,
	permissionForTopic,
	sourcesForTopic,
	type LiveSource,
	type LiveTopic,
} from "./live-topics";
import type { AuthPlatform } from "../auth/auth.platform";
import type { LiveHubMessage } from "./live-hub.service";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const logger = getLogger("api.live");

/**
 * The `/api/v1/live` WebSocket gateway.
 *
 * ## Why a raw `ws` server on the HTTP upgrade, and NOT a `@nestjs/websockets` gateway
 *
 * Three reasons, in the order they were decisive:
 *
 * 1. **The session already has exactly one resolver, and it is a Fastify hook.**
 *    `auth-http.plugin.ts`'s `preHandler` calls `auth.api.getSession` once per request and puts the
 *    result on the request; nothing else in `apps/api` parses a cookie. A Nest WS gateway does not
 *    run Fastify's request lifecycle — the upgrade never reaches a `preHandler` — so authenticating
 *    a socket through one would mean a second place that reads a session cookie. With
 *    `noServer: true` the upgrade request is an `IncomingMessage` whose headers go straight into the
 *    SAME `auth.api.getSession` call, so there is still one resolver and the socket is authenticated
 *    by the identical code path an HTTP request is.
 *
 * 2. **An unauthorized upgrade must be refused with an HTTP status, not a close frame.**
 *    A Nest gateway accepts the handshake and then disconnects, which a browser reports as "the
 *    connection was closed" with no status a client can branch on. `noServer` hands over the raw
 *    socket BEFORE the handshake, so an anonymous caller gets `401 Unauthorized` on the wire and a
 *    reconnecting client can tell "sign in again" from "the server is down" — which is the entire
 *    difference between a backoff loop that terminates and one that does not.
 *
 * 3. **`@SubscribeMessage` is a message router, and this is a subscription manager.** The unit of
 *    state here is the CONNECTION (its topic set, its heartbeat, the upstream leases it holds), and
 *    Nest's model gives handlers a message and a socket with nowhere to put that. It would be a
 *    `Map<WebSocket, …>` inside a gateway class — which is this class, with an adapter in the way.
 *
 * The cost of the decision is that `@nestjs/platform-ws` conventions do not apply here and this
 * file owns its own lifecycle. That is stated rather than hidden: `registerLiveTransport` in
 * `live-bootstrap.ts` is called from `main.ts` next to `registerAuthTransport`, for the same reason
 * and at the same point in boot.
 *
 * ## Origin is checked, because CORS does not apply to WebSockets
 *
 * A browser will happily open a `ws://` connection from any origin and send the session cookie with
 * it — the same-origin policy does not gate the handshake. Without an `Origin` check any website
 * the user visits could open this socket and read their organization's live call feed. The
 * allowlist is better-auth's own `trustedOrigins`, so there is one list rather than two.
 *
 * ## The organization is the SESSION's, never the client's
 *
 * `activeOrganizationId` is resolved at upgrade and pinned for the life of the socket. A client
 * that switches organizations gets closed with {@link LIVE_CLOSE_ORGANIZATION_CHANGED} on its next
 * heartbeat rather than being re-scoped, because re-scoping a live socket means the frames already
 * in flight belong to the previous tenant.
 */
@Injectable()
export class LiveGateway implements OnApplicationShutdown {
	private readonly server = new WebSocketServer({
		noServer: true,
		maxPayload: LIVE_MAX_FRAME_BYTES,
	});
	private readonly connections = new Set<LiveConnection>();
	private heartbeat: NodeJS.Timeout | undefined;
	private detachListener: (() => void) | undefined;
	private accepted = 0;
	private refused = 0;
	private delivered = 0;

	constructor(
		@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform,
		@Inject(AuthService) private readonly authService: AuthService,
		@Inject(LiveHub) private readonly hub: LiveHub,
	) {}

	get stats(): {
		readonly connections: number;
		readonly accepted: number;
		readonly refused: number;
		readonly delivered: number;
	} {
		return {
			connections: this.connections.size,
			accepted: this.accepted,
			refused: this.refused,
			delivered: this.delivered,
		};
	}

	/** Wired by `live-bootstrap.ts` onto the Fastify HTTP server's `upgrade` event. */
	start(): void {
		if (this.detachListener !== undefined) {
			return;
		}
		this.detachListener = this.hub.addListener((message) => {
			this.fanOut(message);
		});
		this.heartbeat = setInterval(() => {
			this.sweep();
		}, LIVE_HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.heartbeat !== undefined) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		this.detachListener?.();
		this.detachListener = undefined;
		// Iterated over a COPY: `close` calls `forget`, which deletes from the set being walked.
		// oxlint-disable-next-line unicorn/no-useless-spread -- the copy is what makes this safe
		for (const connection of [...this.connections]) {
			this.close(connection, LIVE_CLOSE_SERVER_SHUTDOWN, "The server is shutting down.");
		}
		this.server.close();
		await Promise.resolve();
	}

	/**
	 * The `upgrade` handler.
	 *
	 * Everything that can refuse the connection happens BEFORE `handleUpgrade`, so a refusal is an
	 * HTTP response on a socket that was never a WebSocket. Guard-then-execute, at the transport.
	 */
	async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const url = request.url ?? "";
		if (pathOf(url) !== LIVE_PATH) {
			// Not ours. Left alone rather than destroyed: another feature may own this path, and a
			// gateway that closed every upgrade it did not recognise would be an outage for it.
			return;
		}

		if (!this.isTrustedOrigin(request)) {
			this.refuse(socket, 403, "Forbidden");
			logger.warn(
				{
					origin: request.headers.origin,
				},
				"refused a live upgrade from an untrusted origin",
			);
			return;
		}

		let session: AppSession | null = null;
		try {
			const resolved = (await this.platform.auth.api.getSession({
				headers: fromNodeHeaders(request.headers as Record<string, string | string[] | undefined>),
			})) as RawAuthSession | null;
			session = resolved === null ? null : toAppSession(resolved);
		} catch (error) {
			logger.warn({ err: error }, "live session resolution failed");
		}

		if (session === null) {
			this.refused += 1;
			this.refuse(socket, 401, "Unauthorized");
			return;
		}

		// The same resolution the HTTP guard performs, and for the same reason: the membership role
		// is what grants permissions, and a session with no active organization has no tenant to
		// scope a live feed to. Refused with 403 rather than accepted-and-empty, so a client is not
		// left watching a socket that can never carry anything.
		const access = await this.authService.resolveAccess(session);
		if (!access.organizationId || !access.role) {
			this.refused += 1;
			this.refuse(socket, 403, "Forbidden");
			return;
		}

		const permissions = access.permissions;
		const organizationId = access.organizationId;
		// The credential is kept so the heartbeat can re-resolve the session through the SAME
		// `auth.api.getSession` call that opened it — see `revalidate`. Only the headers that carry
		// one are retained: nothing else about the upgrade request outlives the handshake.
		const credentials = credentialHeadersOf(request);

		this.server.handleUpgrade(request, socket, head, (raw) => {
			const connection: LiveConnection = {
				socket: raw,
				organizationId,
				userId: session.user.id,
				credentials,
				permissions,
				topics: new Map(),
				alive: true,
				lastPongAt: Date.now(),
			};
			this.connections.add(connection);
			this.accepted += 1;
			this.attach(connection);
			this.send(connection, {
				op: "welcome",
				orgId: organizationId,
				topics: [...allowedTopicKinds(permissions)],
				heartbeatMs: LIVE_HEARTBEAT_MS,
				at: new Date().toISOString(),
			});
		});
	}

	private attach(connection: LiveConnection): void {
		connection.socket.on("pong", () => {
			connection.alive = true;
			connection.lastPongAt = Date.now();
		});
		connection.socket.on("message", (data) => {
			void this.onMessage(connection, typeof data === "string" ? data : data.toString());
		});
		connection.socket.on("close", () => {
			this.forget(connection);
		});
		connection.socket.on("error", (error) => {
			logger.warn({ organizationId: connection.organizationId, error }, "a live socket errored");
			this.forget(connection);
		});
	}

	private async onMessage(connection: LiveConnection, raw: string): Promise<void> {
		const parsed = parseClientFrame(raw);
		if (parsed.frame === undefined) {
			this.send(connection, {
				op: "error",
				code: raw.length > LIVE_MAX_FRAME_BYTES ? "FRAME_TOO_LARGE" : "BAD_FRAME",
				message: parsed.reason,
			});
			return;
		}
		const frame = parsed.frame;
		if (frame.op === "ping") {
			this.send(connection, {
				op: "pong",
				at: new Date().toISOString(),
				...(frame.id === undefined ? {} : { id: frame.id }),
			});
			return;
		}
		if (frame.op === "unsubscribe") {
			const removed: string[] = [];
			for (const name of frame.topics) {
				const held = connection.topics.get(name);
				if (held === undefined) {
					continue;
				}
				held.release();
				connection.topics.delete(name);
				removed.push(name);
			}
			this.send(connection, {
				op: "unsubscribed",
				topics: removed,
				...(frame.id === undefined ? {} : { id: frame.id }),
			});
			return;
		}

		const granted: string[] = [];
		const denied: LiveDeniedTopic[] = [];
		const toSnapshot: { readonly name: string; readonly topic: LiveTopic }[] = [];

		for (const name of frame.topics) {
			if (connection.topics.has(name)) {
				// Already subscribed. Re-granted rather than refused, and re-snapshotted below: a
				// client that re-subscribes is a client that has just reconnected or lost confidence
				// in its cache, and the honest answer to both is a fresh snapshot.
				granted.push(name);
				toSnapshot.push({ name, topic: connection.topics.get(name)!.topic });
				continue;
			}
			if (connection.topics.size + granted.length >= LIVE_MAX_TOPICS_PER_CONNECTION) {
				denied.push({ topic: name, reason: "too-many-topics" });
				continue;
			}
			const topic = parseLiveTopic(name);
			if (topic === undefined) {
				denied.push({ topic: name, reason: "unknown-topic" });
				continue;
			}
			if (!mayReadTopic(connection.permissions, topic)) {
				denied.push({
					topic: name,
					reason: "forbidden",
					permission: permissionForTopic(topic),
				});
				continue;
			}
			const sources = sourcesForTopic(topic);
			const release = this.hub.acquire(connection.organizationId, sources);
			connection.topics.set(name, { topic, sources, release });
			granted.push(name);
			toSnapshot.push({ name, topic });
		}

		this.send(connection, {
			op: "subscribed",
			topics: granted,
			denied,
			...(frame.id === undefined ? {} : { id: frame.id }),
		});

		if (!this.hub.isReady && granted.length > 0) {
			this.send(connection, {
				op: "error",
				code: "UPSTREAM_UNAVAILABLE",
				message:
					"Subscribed, but this deployment has no broker connection, so no live updates will " +
					"arrive. The screen is not frozen; there is nothing upstream.",
				...(frame.id === undefined ? {} : { id: frame.id }),
			});
			return;
		}

		for (const { name, topic } of toSnapshot) {
			await this.sendSnapshot(connection, name, topic);
		}
	}

	/**
	 * Sends the current bucket contents for a topic.
	 *
	 * One frame per topic, containing an array, rather than one frame per row: a wallboard's initial
	 * state is a table, and delivering it as three hundred separate `event` frames would make the
	 * client's first paint a three-hundred-step reduction and would be indistinguishable, from the
	 * client's side, from three hundred things having just happened.
	 */
	private async sendSnapshot(
		connection: LiveConnection,
		name: string,
		topic: LiveTopic,
	): Promise<void> {
		for (const source of sourcesForTopic(topic)) {
			if (!SNAPSHOT_SOURCES.has(source)) {
				// A stream source has no current value — there is no "state of a change" to send.
				continue;
			}
			const rows = await this.hub.snapshot(connection.organizationId, source);
			const filtered =
				topic.kind === "queue"
					? rows.filter((row) => belongsToQueue(row.value, topic.queueId))
					: rows;
			this.send(connection, {
				op: "snapshot",
				topic: name,
				at: new Date().toISOString(),
				data: filtered,
			});
		}
	}

	/**
	 * Routes one upstream message to the sockets that asked for it.
	 *
	 * The organization check is first and is redundant with the per-organization upstream — the hub
	 * only ever opens `<org>.*` watches — which is exactly why it is here: a fan-out loop is the last
	 * place a tenancy mistake would be visible, and the cost of the comparison is one string equality
	 * per connection.
	 */
	private fanOut(message: LiveHubMessage): void {
		for (const connection of this.connections) {
			if (connection.organizationId !== message.organizationId) {
				continue;
			}
			for (const [name, held] of connection.topics) {
				if (!held.sources.includes(message.source)) {
					continue;
				}
				if (held.topic.kind === "queue" && !isForQueue(message, held.topic.queueId)) {
					continue;
				}
				this.delivered += 1;
				this.send(connection, {
					op: "event",
					topic: name,
					kind: message.kind,
					at: message.at,
					data: message.data,
					...(message.key === undefined ? {} : { key: message.key }),
				});
			}
		}
	}

	/**
	 * The heartbeat sweep: ping everything, reap what did not answer, and re-check the session.
	 *
	 * The session re-check is what stops a socket outliving the authorization that opened it. An
	 * HTTP request re-resolves the session every time; a WebSocket resolves it once and could then
	 * stream a tenant's calls for as long as the process lives — through a sign-out, a role change
	 * or an organization switch. Re-resolving on the heartbeat bounds that to one interval.
	 */
	private sweep(): void {
		const now = Date.now();
		// Same reason as the shutdown sweep: reaping a connection mutates `this.connections`.
		// oxlint-disable-next-line unicorn/no-useless-spread -- the copy is what makes this safe
		for (const connection of [...this.connections]) {
			if (now - connection.lastPongAt > LIVE_HEARTBEAT_TIMEOUT_MS) {
				// Two missed heartbeats. TCP will keep a socket through a dead NAT for minutes; this is
				// the only thing that will not.
				this.forget(connection);
				connection.socket.terminate();
				continue;
			}
			connection.alive = false;
			try {
				connection.socket.ping();
			} catch {
				this.forget(connection);
				continue;
			}
			void this.revalidate(connection);
		}
	}

	private async revalidate(connection: LiveConnection): Promise<void> {
		try {
			const resolved = (await this.platform.auth.api.getSession({
				headers: fromNodeHeaders(connection.credentials),
			})) as RawAuthSession | null;
			const session = resolved === null ? null : toAppSession(resolved);
			if (session === null) {
				this.close(
					connection,
					LIVE_CLOSE_POLICY,
					"The session that opened this connection is no longer valid.",
				);
				return;
			}
			if (session.session.activeOrganizationId !== connection.organizationId) {
				this.close(
					connection,
					LIVE_CLOSE_POLICY,
					"The active organization changed; reconnect to receive the new one's activity.",
				);
				return;
			}
			const access = await this.authService.resolveAccess(session);
			connection.permissions = access.permissions;
			// A permission that was revoked mid-connection drops the topics it granted, rather than
			// the whole socket: a supervisor demoted to agent keeps their queue feed and loses the
			// registrations one, which is what the same change would do to their pages.
			// oxlint-disable-next-line unicorn/no-useless-spread -- the loop deletes from this map
			for (const [name, held] of [...connection.topics]) {
				if (!mayReadTopic(connection.permissions, held.topic)) {
					held.release();
					connection.topics.delete(name);
					this.send(connection, {
						op: "unsubscribed",
						topics: [name],
					});
				}
			}
		} catch (error) {
			logger.warn(
				{
					organizationId: connection.organizationId,
					error,
				},
				"could not revalidate a live session",
			);
		}
	}

	private isTrustedOrigin(request: IncomingMessage): boolean {
		const raw = request.headers.origin;
		const origin = Array.isArray(raw) ? raw[0] : raw;
		if (origin === undefined || origin.length === 0) {
			// No `Origin` means a non-browser client (a verification harness, a CLI, a server-side
			// proxy). Those are not subject to cross-site request forgery — nobody's browser can be
			// tricked into being them — and the session cookie is still required either way.
			return true;
		}
		return this.platform.config.trustedOrigins.some((trusted) => sameOrigin(trusted, origin));
	}

	private refuse(socket: Duplex, status: number, text: string): void {
		socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
		socket.destroy();
	}

	private close(connection: LiveConnection, code: number, reason: string): void {
		this.forget(connection);
		try {
			connection.socket.close(code, reason);
		} catch {
			connection.socket.terminate();
		}
	}

	/** Drops a connection's leases. Safe to call twice — the leases are idempotent. */
	private forget(connection: LiveConnection): void {
		for (const held of connection.topics.values()) {
			held.release();
		}
		connection.topics.clear();
		this.connections.delete(connection);
	}

	private send(connection: LiveConnection, frame: LiveServerFrame): void {
		if (connection.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			connection.socket.send(JSON.stringify(frame));
		} catch (error) {
			logger.warn(
				{
					organizationId: connection.organizationId,
					op: frame.op,
					error,
				},
				"could not write a live frame",
			);
		}
	}
}

interface HeldTopic {
	readonly topic: LiveTopic;
	readonly sources: readonly LiveSource[];
	readonly release: () => void;
}

interface LiveConnection {
	readonly socket: WebSocket;
	readonly organizationId: string;
	readonly userId: string;
	/** The headers the upgrade authenticated with, replayed on every heartbeat. */
	readonly credentials: Record<string, string>;
	permissions: readonly Permission[];
	readonly topics: Map<string, HeldTopic>;
	alive: boolean;
	lastPongAt: number;
}

/** The sources a `snapshot` frame can be built from. The stream sources have no current value. */
const SNAPSHOT_SOURCES: ReadonlySet<LiveSource> = new Set<LiveSource>([
	"registrations-kv",
	"channels-kv",
	"agent-state-kv",
	"queue-waiting-kv",
	// The rooms. A console opening mid-meeting gets every running conference, its cluster-wide member
	// count and its lock in one frame — which is what makes the topic usable at all, since the
	// participant deltas that follow describe changes to a picture that has to already exist.
	"conference-claims-kv",
]);

/**
 * Whether an agent-state or queue-event message concerns one queue.
 *
 * An `agent.state` transition carries `queueIds` when the publisher knew them, and carries none
 * when it applies to every queue the agent serves — so an ABSENT list means "yes", not "no". Getting
 * that backwards would make a queue's agent panel stop updating for exactly the transitions the
 * engine publishes, which never name a queue.
 */
function isForQueue(message: LiveHubMessage, queueId: string): boolean {
	const data = message.data;
	if (typeof data !== "object" || data === null) {
		return false;
	}
	const record = data as Record<string, unknown>;
	if (typeof record.subject === "string") {
		// A queue event's subject is `queue.evt.v1.<org>.<queueId|_all>.<type>`.
		const parts = record.subject.split(".");
		const scope = parts[4];
		if (scope !== undefined && scope !== "_all" && scope !== queueId) {
			return false;
		}
	}
	const payload = (record.data ?? record) as Record<string, unknown>;
	const queueIds = payload.queueIds;
	if (Array.isArray(queueIds)) {
		return queueIds.includes(queueId);
	}
	if (typeof payload.queueId === "string") {
		return payload.queueId === queueId;
	}
	return true;
}

/** The same question for a snapshot row, which is an `agent-state` entry rather than an event. */
function belongsToQueue(row: unknown, queueId: string): boolean {
	if (typeof row !== "object" || row === null) {
		return false;
	}
	const record = row as Record<string, unknown>;
	// An agent-state entry names a queue only while the agent is on a call from one. An agent
	// sitting available belongs to every queue they are tiered into, which the entry does not know —
	// so the entry is included and the client joins it against the roster it already has.
	return typeof record.queueId !== "string" || record.queueId === queueId;
}

/**
 * The subset of the upgrade request's headers that carry a credential.
 *
 * Copied rather than holding the whole `IncomingMessage`: that object references the socket, the
 * parser and the raw buffers, and keeping one alive per connection for the life of a wallboard
 * session is a retained-memory bug waiting to be found.
 */
function credentialHeadersOf(request: IncomingMessage): Record<string, string> {
	const carried: Record<string, string> = {};
	for (const name of ["cookie", "authorization", "x-api-key"]) {
		const raw = request.headers[name];
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (typeof value === "string" && value.length > 0) {
			carried[name] = value;
		}
	}
	return carried;
}

function pathOf(url: string): string {
	const query = url.indexOf("?");
	return query === -1 ? url : url.slice(0, query);
}

function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return a === b;
	}
}
