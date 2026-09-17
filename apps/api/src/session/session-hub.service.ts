import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection, type Subscription } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import {
	callEventSchema,
	SESSION_VERB_RPC,
	sessionAnnounceRequestSchema,
	sessionVerbResponseSchema,
} from "@optimiq-voice/events/schemas";
import {
	applicationSubjectToken,
	subjectFilterFor,
	subjectFor,
} from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../pbx/shared/pbx.tokens";
import type { PbxEnv } from "../pbx/shared/pbx-env";
import type {
	CallEventEnvelope,
	SessionAnnounceRequest,
	SessionAnnounceResponse,
	SessionVerbRequest,
	SessionVerbResponse,
} from "@optimiq-voice/events/schemas";

const logger = getLogger("api.session");

/**
 * The upstream side of the session protocol: application registrations, the verb channel, and one
 * event tap per live session.
 *
 * ## The registration IS a subscription, and that is the whole design
 *
 * Claiming an application subscribes this process to
 * `rpc.session.v1.announce.<orgId>.<applicationToken>`; releasing it unsubscribes. Nothing is
 * written anywhere, so nothing can go stale, and an application nobody has claimed answers the
 * engine's request with `no responders available` — synchronously, with no timeout to wait out.
 * That immediacy is what lets the plan walker take the destination's failure path (an announcement)
 * instead of leaving a caller in silence for the length of a request deadline.
 *
 * The subscription joins a QUEUE GROUP named after the same two tokens, so two control-plane
 * replicas both holding sockets for `crm` share the arrivals instead of racing to answer first.
 *
 * ## One connection, opened here, and NOT the live hub's
 *
 * A second `NatsConnection` in the same process, for the reason `calls.service.ts` holds its own:
 * these are raw request-reply and raw core subscriptions on subjects a Nest `ClientProxy` would
 * wrap in framing the engine does not unwrap. Sharing the live hub's connection would also couple
 * two features' reconnection behaviour — a control channel that went down with a wallboard's watch
 * is a worse failure than two connections.
 *
 * ## The event tap is per CALL, and per session
 *
 * `calls.evt.v1.<org>.<callId>.>`, opened when a session starts and closed when it ends. Core NATS,
 * no durable consumer: an application that was disconnected did not miss anything it can act on,
 * because the call it was driving ended when its socket did. Filtering at the SUBJECT rather than
 * in the handler is what keeps one tenant's other calls off this socket entirely.
 */
@Injectable()
export class SessionHub implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	/** Keyed by `<orgId>/<application>`. One entry per claim held on THIS replica. */
	private readonly registrations = new Map<string, Subscription>();
	private stopped = false;
	private announced = 0;
	private relayed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	/** Whether upstreams can be opened at all. */
	get isReady(): boolean {
		return this.connection !== undefined && !this.connection.isClosed();
	}

	get stats(): {
		readonly registrations: number;
		readonly announced: number;
		readonly relayed: number;
	} {
		return {
			registrations: this.registrations.size,
			announced: this.announced,
			relayed: this.relayed,
		};
	}

	/** Applications currently claimed on this replica. The observable teardown contract. */
	get openRegistrations(): readonly string[] {
		return [...this.registrations.keys()];
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — the session protocol will accept connections and never receive " +
					"a call. A claim is answered with UPSTREAM_UNAVAILABLE rather than being left to look " +
					"like an integration nobody is calling.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-session",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			logger.info({ servers: this.env.NATS_URL }, "session hub connected");
		} catch (error) {
			// Logged, not thrown: an unreachable broker at boot must not stop the control plane from
			// serving every other route.
			logger.error({ err: error }, "the session hub could not reach the broker");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		for (const [key, subscription] of this.registrations) {
			subscription.unsubscribe();
			this.registrations.delete(key);
		}
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * Claims an application for an organization, and answers announcements for it until released.
	 *
	 * Returns `undefined` when the claim could not be taken — no broker, or this replica already
	 * holds it. A second claim of the same name on the same process is REFUSED rather than shared:
	 * two sockets both answering for `crm` would have the calls split between them by whichever
	 * `onAnnounce` the runtime reached first, which is a race an integrator cannot see, reproduce or
	 * debug. Two PROCESSES claiming it is a different matter and is supported — that is what the
	 * queue group is for.
	 */
	claim(
		organizationId: string,
		application: string,
		onAnnounce: (request: SessionAnnounceRequest) => Promise<SessionAnnounceResponse>,
	): (() => void) | undefined {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return undefined;
		}
		const key = `${organizationId}/${application}`;
		if (this.registrations.has(key)) {
			return undefined;
		}

		const subject = subjectFor.sessionAnnounceRpc(organizationId, application);
		const subscription = connection.subscribe(subject, {
			// Queue names may not contain a dot, so the two tokens are joined with a dash. The tokens
			// themselves come from the same helpers the subject does, so the group is stable across
			// replicas — which is the only property that makes it a group rather than two.
			queue: `optimiq-api-session-${organizationId}-${applicationSubjectToken(application)}`,
		});
		this.registrations.set(key, subscription);

		void (async () => {
			const encoder = new TextEncoder();
			const decoder = new TextDecoder();
			try {
				for await (const message of subscription) {
					if (this.stopped) {
						return;
					}
					this.announced += 1;
					// CONCURRENT: an announcement is answered from memory, but the socket write behind it
					// is not, and a slow client must not delay the next caller's offer.
					void (async () => {
						let answer: SessionAnnounceResponse;
						try {
							const parsed = sessionAnnounceRequestSchema.parse(
								JSON.parse(decoder.decode(message.data)) as unknown,
							);
							answer =
								parsed.orgId === organizationId
									? await onAnnounce(parsed)
									: // The subject is organization-scoped, so this cannot happen without a
										// publisher building one by hand. Checked anyway, at the one place a
										// cross-tenant call would be handed to an application.
										{
											accepted: false,
											reason: "internal",
											error: "the announcement names another organization",
										};
						} catch (error) {
							answer = {
								accepted: false,
								reason: "bad_request",
								error: String(error).slice(0, 512),
							};
						}
						message.respond(encoder.encode(JSON.stringify(answer)));
					})();
				}
			} catch (error) {
				if (!this.stopped) {
					logger.warn({ organizationId, application, error }, "a session registration ended");
				}
			}
		})();

		logger.info({ organizationId, application, subject }, "an application claimed a destination");
		let released = false;
		return () => {
			if (released) {
				// Idempotent: a connection can be torn down by a close event AND by the shutdown sweep.
				return;
			}
			released = true;
			this.registrations.delete(key);
			subscription.unsubscribe();
		};
	}

	/**
	 * Sends one verb to the engine instance that owns the leg.
	 *
	 * The instance came from the announcement and has been held for the life of the session — there
	 * is no lookup, because a directory would be a second source of truth for a fact the session was
	 * opened with. Never throws: a broker failure is a refusal an application can read.
	 */
	async sendVerb(instanceId: string, request: SessionVerbRequest): Promise<SessionVerbResponse> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return this.refuseVerb(request, "the control plane has no broker connection");
		}
		try {
			const reply = await connection.request(
				subjectFor.engineSessionVerbRpc(instanceId),
				new TextEncoder().encode(JSON.stringify(request)),
				{ timeout: SESSION_VERB_RPC.timeoutMs },
			);
			const parsed = sessionVerbResponseSchema.safeParse(
				JSON.parse(new TextDecoder().decode(reply.data)) as unknown,
			);
			if (!parsed.success) {
				return this.refuseVerb(
					request,
					"the engine answered with something that is not the contract",
				);
			}
			this.relayed += 1;
			return parsed.data;
		} catch (error) {
			// `no responders available` when the owning instance has gone, a timeout when it is wedged.
			// Both mean the same thing to an application: that call is no longer reachable.
			return this.refuseVerb(request, String(error));
		}
	}

	/**
	 * Watches one call's events for the life of a session.
	 *
	 * Returns a stop function rather than requiring a matching call, so a session that ends mid-open
	 * cannot leave a subscription behind — the same contract `LiveHub.acquire` holds to.
	 */
	watchCall(
		organizationId: string,
		callId: string,
		onEvent: (event: CallEventEnvelope) => void,
	): () => void {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return () => undefined;
		}
		const subscription = connection.subscribe(subjectFilterFor.call(organizationId, callId));
		void (async () => {
			const decoder = new TextDecoder();
			try {
				for await (const message of subscription) {
					if (this.stopped) {
						return;
					}
					let decoded: unknown;
					try {
						decoded = JSON.parse(decoder.decode(message.data));
					} catch {
						continue;
					}
					const parsed = callEventSchema.safeParse(decoded);
					// Dropped rather than forwarded, for the reason `live-hub.service.ts` states: an
					// application is the least trusted consumer on this backbone and furthest from the
					// schema, and a `safeParse` on a path that runs at human speed costs nothing.
					if (parsed.success && parsed.data.orgId === organizationId) {
						onEvent(parsed.data);
					}
				}
			} catch (error) {
				if (!this.stopped) {
					logger.warn({ organizationId, callId, error }, "a session event tap ended");
				}
			}
		})();

		let stopped = false;
		return () => {
			if (stopped) {
				return;
			}
			stopped = true;
			subscription.unsubscribe();
		};
	}

	private refuseVerb(request: SessionVerbRequest, error: string): SessionVerbResponse {
		logger.warn(
			{ orgId: request.orgId, sessionId: request.sessionId, verb: request.verb, err: error },
			"a session verb did not reach its engine",
		);
		return {
			ok: false,
			verb: request.verb,
			instanceId: "",
			reason: "internal",
			error: error.slice(0, 512),
		};
	}
}
