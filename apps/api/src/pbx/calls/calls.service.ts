import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection } from "nats";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { ORIGINATE_RPC } from "@optimiq-voice/events/schemas";
import { subjectFor } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import { originateRateLimitedException, originateUnavailableException } from "./calls.errors";
import { OriginateRateLimiter } from "./originate-rate-limit";
import { interpretOriginateReply } from "./originate-reply";
import type { PbxEnv } from "../shared/pbx-env";
import type { AppSession } from "@optimiq-voice/auth";

const logger = getLogger("api.calls");

/** What a successful origination tells the caller. */
export interface OriginatedCall {
	/** The call id, and the token in `calls.evt.v1.<org>.<callId>.>`. Correlates the webhooks. */
	readonly callId: string;
	/** The A-leg — the extension's own leg — as it appears in the CDR. */
	readonly legId: string;
	/** The handle this API assigned. Echoed so a retry can be recognised in a log. */
	readonly originateId: string;
	readonly from: string;
	readonly to: string;
	/** The engine instance that took the call. */
	readonly instanceId?: string;
}

/**
 * `POST /api/v1/calls` — the control plane's half of click-to-call.
 *
 * ## Why this is a request-reply and not a published event
 *
 * Because the person who pressed the button is still looking at it. An event would make the HTTP
 * response a promise that something might happen; a request-reply makes it an answer — the call
 * exists and here is its id, or it does not and here is exactly why. Every refusal in the contract
 * maps onto a status a client can act on (`calls.errors.ts`), and none of them would survive being
 * turned into a 202.
 *
 * ## RAW NATS, not a `ClientProxy`
 *
 * The engine serves this on a raw subscription — see the contract's note — so a Nest `ClientProxy`
 * would wrap the payload in `{"pattern":…,"data":…}` framing the responder does not unwrap, and the
 * request would time out rather than fail. This class holds its own connection for the same reason
 * the CDR writer and the voicemail consumer do: a raw connection is the transport, and the Nest
 * microservice client in this app is a different thing that serves `@MessagePattern` subjects.
 *
 * ## The order of the checks, and why the rate limit is not first
 *
 * Session → active organization (both from the guard) → permission (the guard) → RATE LIMIT →
 * originate. The limit is consulted after authorisation, deliberately: a counter that an
 * unauthenticated or unauthorised request could increment is a way to exhaust a tenant's budget
 * without holding any of its credentials, which is the same reasoning `provision.service.ts` records
 * for consulting its limiter only once the token reference has resolved.
 */
@Injectable()
export class CallsService implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private readonly limiter: OriginateRateLimiter;
	private originated = 0;
	private refused = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {
		this.limiter = new OriginateRateLimiter(env.PBX_ORIGINATE_RATE_LIMIT_PER_MINUTE);
	}

	get stats(): {
		readonly connected: boolean;
		readonly originated: number;
		readonly refused: number;
	} {
		return {
			connected: this.connection !== undefined && !this.connection.isClosed(),
			originated: this.originated,
			refused: this.refused,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — POST /api/v1/calls will answer 503. Click-to-call needs a " +
					"broker to reach the engine.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-originate",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
		} catch (error) {
			// Logged, not thrown: an unreachable broker at boot must not stop the control plane from
			// serving every other route. The endpoint answers 503 until the connection exists.
			logger.error({ err: error }, "could not connect the originate client");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * Places a call, or throws the HTTP exception that says why not.
	 *
	 * @throws the mapped refusal, a 429, or a 503 when no engine answered
	 */
	async originate(
		session: AppSession,
		request: {
			readonly from: string;
			readonly to: string;
			readonly ringTimeoutSeconds?: number | undefined;
			readonly callerIdNumber?: string | undefined;
			readonly callerIdName?: string | undefined;
		},
	): Promise<OriginatedCall> {
		const organizationId = requireActiveOrganizationId(session);

		const verdict = this.limiter.consume(organizationId);
		if (!verdict.allowed) {
			this.refused += 1;
			throw originateRateLimitedException(verdict.retryAfterSeconds);
		}

		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			throw originateUnavailableException("the control plane has no broker connection");
		}

		/**
		 * The origination handle, minted HERE and never accepted from the caller.
		 *
		 * It becomes the media channel's id on the engine, so a caller-supplied one would let two
		 * tenants collide on a channel — and would let a caller name a channel another tenant's call is
		 * already using, which the engine's idempotency path would answer with that call's ids.
		 */
		const originateId = randomUUID();
		const payload = {
			orgId: organizationId,
			originateId,
			fromExtension: request.from,
			to: request.to,
			...(request.ringTimeoutSeconds === undefined
				? {}
				: { ringTimeoutSeconds: request.ringTimeoutSeconds }),
			...(request.callerIdNumber === undefined ? {} : { callerIdNumber: request.callerIdNumber }),
			...(request.callerIdName === undefined ? {} : { callerIdName: request.callerIdName }),
			/** Who asked, for the engine's log. A user id or an API key id — never a credential. */
			requestedBy: session.user.id.slice(0, 128),
		};

		let raw: Uint8Array;
		try {
			const reply = await connection.request(
				subjectFor.engineOriginateRpc(),
				new TextEncoder().encode(JSON.stringify(payload)),
				{ timeout: ORIGINATE_RPC.timeoutMs },
			);
			raw = reply.data;
		} catch (error) {
			// `no responders available` when no engine is subscribed, a timeout when every one of them
			// is too busy to answer inside the contract's deadline. Both are 503 — see the exception.
			logger.warn(
				{ organizationId, originateId, from: request.from, err: String(error) },
				"no engine answered rpc.engine.v1.originate",
			);
			throw originateUnavailableException(String(error));
		}

		let accepted: ReturnType<typeof interpretOriginateReply>;
		try {
			accepted = interpretOriginateReply(raw, { from: request.from, to: request.to });
		} catch (error) {
			this.refused += 1;
			logger.info(
				{ organizationId, originateId, from: request.from, to: request.to, err: String(error) },
				"an originate was refused",
			);
			throw error;
		}

		this.originated += 1;
		logger.info(
			{
				organizationId,
				originateId,
				callId: accepted.callId,
				legId: accepted.legId,
				from: request.from,
				to: request.to,
				instanceId: accepted.instanceId,
			},
			"placed a click-to-call",
		);
		return {
			callId: accepted.callId,
			legId: accepted.legId,
			originateId,
			from: request.from,
			to: request.to,
			...(accepted.instanceId === undefined ? {} : { instanceId: accepted.instanceId }),
		};
	}
}
