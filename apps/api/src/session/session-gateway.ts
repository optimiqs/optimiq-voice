import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { WebSocket, WebSocketServer } from "ws";
import { hasPermission } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { toAppSession, type RawAuthSession } from "../auth/app-session";
import { AuthService } from "../auth/auth.service";
import { AUTH_PLATFORM } from "../auth/auth.tokens";
import { SessionHub } from "./session-hub.service";
import {
	parseSessionFrame,
	SESSION_CLOSE_POLICY,
	SESSION_CLOSE_SERVER_SHUTDOWN,
	SESSION_HEARTBEAT_MS,
	SESSION_HEARTBEAT_TIMEOUT_MS,
	SESSION_MAX_APPLICATIONS,
	SESSION_MAX_FRAME_BYTES,
	SESSION_PATH,
	type SessionDeniedApplication,
	type SessionEndReason,
	type SessionServerFrame,
	type SessionVerbFrame,
} from "./session-protocol";
import type { AuthPlatform } from "../auth/auth.platform";
import type { AppSession } from "@optimiq-voice/auth";
import type {
	CallEventEnvelope,
	SessionAnnounceRequest,
	SessionAnnounceResponse,
} from "@optimiq-voice/events/schemas";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const logger = getLogger("api.session");

/** The grant this whole surface is behind. See its entry in `packages/auth`. */
const SESSION_PERMISSION = "calls.control" as const;

/**
 * The `/api/v1/session` WebSocket gateway — the session protocol's client terminus.
 *
 * ## Why the control plane terminates this socket and not the engine
 *
 * By precedent, and the precedent is load-bearing. `apps/api` owns every client-facing socket
 * (`live-gateway.ts`), because it is the process that holds the auth platform, the permission
 * registry and the organization membership — and a second place that resolves a session cookie is
 * exactly the thing that drifts. The engine holds none of those: it is a call runtime with a
 * broker connection, and giving it a public listener would mean either duplicating better-auth
 * inside it or trusting a header. It also has the wrong lifecycle for the job — engine instances
 * come and go with call load, and an integration's socket must not be pinned to one of them.
 *
 * So the api terminates, and everything crosses to the engine as NATS: verbs out on
 * `rpc.engine.v1.session-verb.<instance>`, offers in on `rpc.session.v1.announce.<org>.<app>`,
 * events in on the ordinary `calls.evt.v1` family.
 *
 * ## Authentication is the live gateway's, plus one permission
 *
 * The same `auth.api.getSession` call, the same `Origin` allowlist, the same pinned organization,
 * the same heartbeat revalidation — see `live-gateway.ts`, which argues each of those at length and
 * whose reasoning applies here unchanged. What is added is {@link SESSION_PERMISSION}: this socket
 * can hang up a customer's call, so it is refused at the UPGRADE to anybody who does not hold the
 * grant, rather than being accepted and refusing every frame.
 *
 * ## The per-call token seam, named rather than half-built
 *
 * `packages/auth`'s `createCallTokenVerifier` mints and verifies a token scoped to ONE call
 * (`callRef`), against the JWKS the api publishes. That is the right credential for a narrower
 * shape of this feature than the one built here — handing a single live call to a third party who
 * should not be able to touch the tenant's other calls, which is what a browser-based agent screen
 * or a customer-facing callback widget would need. This gateway is deliberately the ORGANIZATION
 * -scoped shape: a long-lived integration process that claims an application and receives every
 * call routed to it, authenticated the way every other api client is. The seam for the other is
 * exactly one branch in {@link SessionGateway.handleUpgrade} — accept a `?callToken=` in place of a
 * session, resolve it with the verifier, and pin the connection to that `callRef` with no claim
 * surface at all.
 */
@Injectable()
export class SessionGateway implements OnApplicationShutdown {
	private readonly server = new WebSocketServer({
		noServer: true,
		maxPayload: SESSION_MAX_FRAME_BYTES,
	});
	private readonly connections = new Set<SessionConnection>();
	private heartbeat: NodeJS.Timeout | undefined;
	private started = false;
	private accepted = 0;
	private refused = 0;
	private delivered = 0;

	constructor(
		@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform,
		@Inject(AuthService) private readonly authService: AuthService,
		@Inject(SessionHub) private readonly hub: SessionHub,
	) {}

	get stats(): {
		readonly connections: number;
		readonly accepted: number;
		readonly refused: number;
		readonly delivered: number;
		readonly sessions: number;
	} {
		let sessions = 0;
		for (const connection of this.connections) {
			sessions += connection.sessions.size;
		}
		return {
			connections: this.connections.size,
			accepted: this.accepted,
			refused: this.refused,
			delivered: this.delivered,
			sessions,
		};
	}

	/** Wired by `session-bootstrap.ts` onto the Fastify HTTP server's `upgrade` event. */
	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.heartbeat = setInterval(() => {
			this.sweep();
		}, SESSION_HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.heartbeat !== undefined) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		// Iterated over a COPY: `close` calls `forget`, which deletes from the set being walked.
		// oxlint-disable-next-line unicorn/no-useless-spread -- the copy is what makes this safe
		for (const connection of [...this.connections]) {
			this.endSessions(connection, "shutting-down");
			this.close(connection, SESSION_CLOSE_SERVER_SHUTDOWN, "The server is shutting down.");
		}
		this.server.close();
		await Promise.resolve();
	}

	/**
	 * The `upgrade` handler.
	 *
	 * Everything that can refuse the connection happens BEFORE `handleUpgrade`, so a refusal is an
	 * HTTP status on a socket that was never a WebSocket — which is the only way a reconnecting
	 * client can tell "sign in again" from "the server is down".
	 */
	async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const url = request.url ?? "";
		if (pathOf(url) !== SESSION_PATH) {
			// Not ours. Left alone rather than destroyed: `live-bootstrap.ts` has a listener on the same
			// event, and a gateway that consumed every upgrade would break it.
			return;
		}

		if (!this.isTrustedOrigin(request)) {
			this.refused += 1;
			this.refuse(socket, 403, "Forbidden");
			return;
		}

		let session: AppSession | null = null;
		try {
			const resolved = (await this.platform.auth.api.getSession({
				headers: fromNodeHeaders(request.headers as Record<string, string | string[] | undefined>),
			})) as RawAuthSession | null;
			session = resolved === null ? null : toAppSession(resolved);
		} catch (error) {
			logger.warn({ err: error }, "session-protocol session resolution failed");
		}
		if (session === null) {
			this.refused += 1;
			this.refuse(socket, 401, "Unauthorized");
			return;
		}

		const access = await this.authService.resolveAccess(session);
		if (
			!access.organizationId ||
			!access.role ||
			!hasPermission(access.permissions, SESSION_PERMISSION)
		) {
			// 403 rather than accepted-and-empty. A socket that can never claim anything looks
			// identical, from the client's side, to an integration nobody is calling.
			this.refused += 1;
			this.refuse(socket, 403, "Forbidden");
			return;
		}

		const organizationId = access.organizationId;
		const credentials = credentialHeadersOf(request);

		this.server.handleUpgrade(request, socket, head, (raw) => {
			const connection: SessionConnection = {
				socket: raw,
				organizationId,
				userId: session.user.id,
				credentials,
				applications: new Map(),
				sessions: new Map(),
				lastPongAt: Date.now(),
			};
			this.connections.add(connection);
			this.accepted += 1;
			this.attach(connection);
			this.send(connection, {
				op: "welcome",
				orgId: organizationId,
				heartbeatMs: SESSION_HEARTBEAT_MS,
				at: new Date().toISOString(),
			});
		});
	}

	private attach(connection: SessionConnection): void {
		connection.socket.on("pong", () => {
			connection.lastPongAt = Date.now();
		});
		connection.socket.on("message", (data) => {
			void this.onMessage(connection, typeof data === "string" ? data : data.toString());
		});
		connection.socket.on("close", () => {
			this.forget(connection);
		});
		connection.socket.on("error", (error) => {
			logger.warn({ organizationId: connection.organizationId, error }, "a session socket errored");
			this.forget(connection);
		});
	}

	private async onMessage(connection: SessionConnection, raw: string): Promise<void> {
		const parsed = parseSessionFrame(raw);
		if (parsed.frame === undefined) {
			this.send(connection, {
				op: "error",
				code: raw.length > SESSION_MAX_FRAME_BYTES ? "FRAME_TOO_LARGE" : "BAD_FRAME",
				message: parsed.reason,
			});
			return;
		}
		const frame = parsed.frame;
		switch (frame.op) {
			case "ping": {
				this.send(connection, {
					op: "pong",
					at: new Date().toISOString(),
					...(frame.id === undefined ? {} : { id: frame.id }),
				});
				return;
			}
			case "claim": {
				this.onClaim(connection, frame.applications, frame.id);
				return;
			}
			case "release": {
				this.onRelease(connection, frame.applications, frame.id);
				return;
			}
			default: {
				await this.onVerb(connection, frame);
			}
		}
	}

	private onClaim(
		connection: SessionConnection,
		applications: readonly string[],
		id: string | undefined,
	): void {
		const granted: string[] = [];
		const denied: SessionDeniedApplication[] = [];

		for (const application of applications) {
			if (connection.applications.has(application)) {
				// Already held by THIS socket. Re-granted rather than refused: a client that re-claims
				// has usually just reconnected, and the honest answer is "yes, you have it".
				granted.push(application);
				continue;
			}
			if (connection.applications.size + granted.length >= SESSION_MAX_APPLICATIONS) {
				denied.push({ application, reason: "too-many-applications" });
				continue;
			}
			const release = this.hub.claim(
				connection.organizationId,
				application,
				async (announcement) => await this.onAnnounce(connection, application, announcement),
			);
			if (release === undefined) {
				denied.push({
					application,
					reason: this.hub.isReady ? "already-claimed" : "upstream-unavailable",
				});
				continue;
			}
			connection.applications.set(application, release);
			granted.push(application);
		}

		this.send(connection, {
			op: "claimed",
			applications: granted,
			denied,
			...(id === undefined ? {} : { id }),
		});
	}

	private onRelease(
		connection: SessionConnection,
		applications: readonly string[],
		id: string | undefined,
	): void {
		const released: string[] = [];
		for (const application of applications) {
			const release = connection.applications.get(application);
			if (release === undefined) {
				continue;
			}
			release();
			connection.applications.delete(application);
			released.push(application);
			// Sessions already in flight for that application are NOT torn down. The claim decides who
			// gets the NEXT call; a caller mid-conversation is not a registration, and hanging them up
			// because an integration stopped accepting new work would be the rudest possible reading of
			// "release".
		}
		this.send(connection, {
			op: "released",
			applications: released,
			...(id === undefined ? {} : { id }),
		});
	}

	/**
	 * A call reached one of this socket's applications.
	 *
	 * The session id is minted HERE and never accepted from anywhere: it is the capability an
	 * application presents on every later verb, and one supplied by another party would be a way to
	 * address a call this socket was never given.
	 */
	private async onAnnounce(
		connection: SessionConnection,
		application: string,
		announcement: SessionAnnounceRequest,
	): Promise<SessionAnnounceResponse> {
		if (connection.socket.readyState !== WebSocket.OPEN) {
			// The socket died between the claim and this offer. Refused rather than accepted-and-lost,
			// so the engine announces to the caller instead of waiting for verbs that cannot come.
			return { accepted: false, reason: "no-application", error: "the socket is closed" };
		}
		const sessionId = randomUUID();
		const stopTap = this.hub.watchCall(connection.organizationId, announcement.callId, (event) => {
			this.onCallEvent(connection, sessionId, event);
		});
		connection.sessions.set(sessionId, {
			sessionId,
			application,
			callId: announcement.callId,
			legId: announcement.legId,
			instanceId: announcement.instanceId,
			stopTap,
		});

		this.send(connection, {
			op: "session.started",
			sessionId,
			application,
			callId: announcement.callId,
			legId: announcement.legId,
			direction: announcement.direction,
			answered: announcement.answered,
			...(announcement.callerIdNumber === undefined
				? {}
				: { callerIdNumber: announcement.callerIdNumber }),
			...(announcement.callerIdName === undefined
				? {}
				: { callerIdName: announcement.callerIdName }),
			...(announcement.dialedNumber === undefined
				? {}
				: { dialedNumber: announcement.dialedNumber }),
			...(announcement.arguments === undefined ? {} : { arguments: announcement.arguments }),
			at: announcement.at,
		});
		return { accepted: true, sessionId };
	}

	private async onVerb(connection: SessionConnection, frame: SessionVerbFrame): Promise<void> {
		const session = connection.sessions.get(frame.sessionId);
		if (session === undefined) {
			// The session id is the capability, so an unknown one is an authorization answer as much as
			// a lookup failure — and it is the same answer whether the session ended a second ago or
			// never belonged to this socket.
			this.send(connection, {
				op: "error",
				code: "UNKNOWN_SESSION",
				message: "This connection holds no session with that id.",
				...(frame.id === undefined ? {} : { id: frame.id }),
			});
			return;
		}

		const response = await this.hub.sendVerb(session.instanceId, {
			// Every identifier comes from the SESSION, never from the frame. The client supplies a
			// session id and a verb; it does not get to say which leg, which call or which tenant.
			orgId: connection.organizationId,
			sessionId: session.sessionId,
			callId: session.callId,
			legId: session.legId,
			verb: frame.verb,
			...(frame.arguments === undefined ? {} : { arguments: frame.arguments }),
		});

		const { ok, verb, ...rest } = response;
		this.send(connection, {
			op: "result",
			sessionId: session.sessionId,
			ok,
			verb,
			data: rest,
			...(frame.id === undefined ? {} : { id: frame.id }),
		});

		if (frame.verb === "hangup" && ok) {
			// The application ended the call. The engine has already released the walk; closing the
			// session here rather than waiting for `channel.destroyed` means the socket's own `hangup`
			// is acknowledged and finished in one exchange.
			this.endSession(connection, session.sessionId, "call-ended");
		}
	}

	/** Relays one call event, and closes the session when the leg is destroyed. */
	private onCallEvent(
		connection: SessionConnection,
		sessionId: string,
		event: CallEventEnvelope,
	): void {
		const session = connection.sessions.get(sessionId);
		if (session === undefined) {
			return;
		}
		this.delivered += 1;
		this.send(connection, {
			op: "event",
			sessionId,
			callId: session.callId,
			type: event.type,
			at: event.at,
			data: event.data,
		});
		const legId = (event.data as { readonly legId?: unknown }).legId;
		if (event.type === "channel.destroyed" && legId === session.legId) {
			// The event is delivered FIRST and the session closed after, so an application sees why its
			// call ended before it is told that it has.
			this.endSession(connection, sessionId, "call-ended");
		}
	}

	private endSession(
		connection: SessionConnection,
		sessionId: string,
		reason: SessionEndReason,
	): void {
		const session = connection.sessions.get(sessionId);
		if (session === undefined) {
			return;
		}
		session.stopTap();
		connection.sessions.delete(sessionId);
		this.send(connection, {
			op: "session.ended",
			sessionId,
			callId: session.callId,
			reason,
			at: new Date().toISOString(),
		});
	}

	private endSessions(connection: SessionConnection, reason: SessionEndReason): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- the loop deletes from this map
		for (const sessionId of [...connection.sessions.keys()]) {
			this.endSession(connection, sessionId, reason);
		}
	}

	/**
	 * The heartbeat sweep: ping everything, reap what did not answer, and re-check the session.
	 *
	 * The re-check is what stops a socket outliving the authorization that opened it — the same
	 * reasoning `live-gateway.ts` records, with one difference that matters more here: a revoked
	 * {@link SESSION_PERMISSION} closes the whole CONNECTION rather than dropping a topic, because
	 * every frame this socket can send is that permission being exercised.
	 */
	private sweep(): void {
		const now = Date.now();
		// oxlint-disable-next-line unicorn/no-useless-spread -- reaping mutates `this.connections`
		for (const connection of [...this.connections]) {
			if (now - connection.lastPongAt > SESSION_HEARTBEAT_TIMEOUT_MS) {
				this.forget(connection);
				connection.socket.terminate();
				continue;
			}
			try {
				connection.socket.ping();
			} catch {
				this.forget(connection);
				continue;
			}
			void this.revalidate(connection);
		}
	}

	private async revalidate(connection: SessionConnection): Promise<void> {
		try {
			const resolved = (await this.platform.auth.api.getSession({
				headers: fromNodeHeaders(connection.credentials),
			})) as RawAuthSession | null;
			const session = resolved === null ? null : toAppSession(resolved);
			if (session === null) {
				this.close(
					connection,
					SESSION_CLOSE_POLICY,
					"The session that opened this connection is no longer valid.",
				);
				return;
			}
			if (session.session.activeOrganizationId !== connection.organizationId) {
				this.close(
					connection,
					SESSION_CLOSE_POLICY,
					"The active organization changed; reconnect to control the new one's calls.",
				);
				return;
			}
			const access = await this.authService.resolveAccess(session);
			if (!hasPermission(access.permissions, SESSION_PERMISSION)) {
				this.close(connection, SESSION_CLOSE_POLICY, "This session may no longer control calls.");
			}
		} catch (error) {
			logger.warn(
				{ organizationId: connection.organizationId, error },
				"could not revalidate a session-protocol connection",
			);
		}
	}

	private isTrustedOrigin(request: IncomingMessage): boolean {
		const raw = request.headers.origin;
		const origin = Array.isArray(raw) ? raw[0] : raw;
		if (origin === undefined || origin.length === 0) {
			// No `Origin` means a non-browser client, which is what an integration process IS. Those are
			// not subject to cross-site request forgery, and the credential is still required either way.
			return true;
		}
		return this.platform.config.trustedOrigins.some((trusted) => sameOrigin(trusted, origin));
	}

	private refuse(socket: Duplex, status: number, text: string): void {
		socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
		socket.destroy();
	}

	private close(connection: SessionConnection, code: number, reason: string): void {
		this.forget(connection);
		try {
			connection.socket.close(code, reason);
		} catch {
			connection.socket.terminate();
		}
	}

	/**
	 * Drops a connection's claims and hangs its live calls up.
	 *
	 * The hangup is the part worth arguing. A socket that closed mid-call leaves a caller connected
	 * to a process that has forgotten them — the engine's own backstop deadline would eventually
	 * reap it, hours later, which is a caller listening to silence for hours. This is the party that
	 * can SEE the socket close, so this is the party that ends the calls, and it does it with
	 * `NORMAL_CLEARING` rather than an error cause because from the caller's side nothing went wrong.
	 */
	private forget(connection: SessionConnection): void {
		if (!this.connections.delete(connection)) {
			// Safe to call twice: a close event and the shutdown sweep both reach here.
			return;
		}
		for (const release of connection.applications.values()) {
			release();
		}
		connection.applications.clear();
		// oxlint-disable-next-line unicorn/no-useless-spread -- the map is cleared below this loop
		for (const session of [...connection.sessions.values()]) {
			session.stopTap();
			void this.hub.sendVerb(session.instanceId, {
				orgId: connection.organizationId,
				sessionId: session.sessionId,
				callId: session.callId,
				legId: session.legId,
				verb: "hangup",
				arguments: { cause: "NORMAL_CLEARING" },
			});
		}
		connection.sessions.clear();
	}

	private send(connection: SessionConnection, frame: SessionServerFrame): void {
		if (connection.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			connection.socket.send(JSON.stringify(frame));
		} catch (error) {
			logger.warn(
				{ organizationId: connection.organizationId, op: frame.op, error },
				"could not write a session frame",
			);
		}
	}
}

/** One call this socket is currently driving. */
interface LiveSession {
	readonly sessionId: string;
	readonly application: string;
	readonly callId: string;
	readonly legId: string;
	/** The engine instance that owns the leg. Learned from the announcement; never looked up. */
	readonly instanceId: string;
	readonly stopTap: () => void;
}

interface SessionConnection {
	readonly socket: WebSocket;
	readonly organizationId: string;
	readonly userId: string;
	/** The headers the upgrade authenticated with, replayed on every heartbeat. */
	readonly credentials: Record<string, string>;
	/** Claimed application → its release function. */
	readonly applications: Map<string, () => void>;
	readonly sessions: Map<string, LiveSession>;
	lastPongAt: number;
}

/**
 * The subset of the upgrade request's headers that carry a credential. Copied rather than holding
 * the whole `IncomingMessage`, for the retained-memory reason `live-gateway.ts` states.
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
