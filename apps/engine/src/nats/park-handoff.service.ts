import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { headers } from "nats";
import {
	PARK_HANDOFF_RPC,
	parkHandoffRequestSchema,
	parkHandoffResponseSchema,
	subjectFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ParkHandoffError } from "../calls/park-handoff";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { ParkHandoffClient } from "../calls/park-handoff";
import type { EngineEnv } from "../config/engine-env";
import type { ParkHandoffRequest, ParkHandoffResponse } from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * Both ends of `rpc.engine.v1.park-handoff`, on the engine's own raw NATS connection.
 *
 * ## One class, two directions, on purpose
 *
 * Every engine instance is both a caller and a responder here, and always at the same time: the
 * instance holding a parked call is the one whose colleague dials the orbit from a phone registered
 * somewhere else. Splitting this into a client and a server would be two objects with one subject,
 * one connection and one lifecycle between them, and a boot order in which the client could exist
 * before the responder.
 *
 * ## Raw NATS, and why it is not the usual reason
 *
 * The `rpc.media.v1.*` family is raw because `mediad` is Go. This family is raw with NestJS on both
 * ends, because the subject is not a constant: it ends in the OWNING instance's token, and a
 * `@MessagePattern` is a fixed string fixed at decoration time. See the note on
 * `parkHandoffRequestSchema`.
 *
 * ## Absent broker, absent claims
 *
 * The responder subscribes only when the `park-claims` bucket is configured: without it there is
 * one instance by deployment choice, no claim can name a foreign owner, and this would be a
 * subscription on a subject nobody ever publishes to. Without a connection at all it logs the
 * consequence once — calls parked here cannot be collected elsewhere — rather than refusing to run,
 * which is the posture the rest of the engine takes to an absent backbone.
 *
 * ## Why the bucket is read from `JetStreamService` and not from `ParkRegistry`
 *
 * Boot order. The registry learns whether claims are shared in `ClaimHeartbeatService`'s
 * `onApplicationBootstrap`, and two providers' bootstrap hooks run in a registration order nothing
 * here should depend on. `JetStreamService.onModuleInit` is guaranteed to have run before ANY
 * bootstrap hook, so the bucket itself is the one answer that cannot be read too early.
 */
@Injectable()
export class ParkHandoffService
	implements OnApplicationBootstrap, OnApplicationShutdown, ParkHandoffClient
{
	private readonly logger = getLogger("engine.park");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private handler: ((request: ParkHandoffRequest) => Promise<ParkHandoffResponse>) | undefined;
	private draining = false;
	private served = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	/** Whether this instance can be asked for the calls it has parked, and how often it has been. */
	get stats(): { readonly listening: boolean; readonly served: number } {
		return { listening: this.subscription !== undefined, served: this.served };
	}

	/** The subject this instance answers on. Exposed for the log line and for the specs. */
	get subject(): string {
		return subjectFor.engineParkHandoffRpc(this.env.ENGINE_INSTANCE_ID);
	}

	/**
	 * Registers what actually performs a handoff. Must be called before the subscription opens.
	 *
	 * Set from `ChannelOrchestrator`'s constructor — which runs while Nest is still building
	 * providers, and therefore well before {@link ParkHandoffService.onApplicationBootstrap}. A
	 * request that somehow arrives first is answered `internal` rather than dropped, because a
	 * silence would cost the retriever the whole timeout to learn nothing.
	 */
	setHandler(handler: (request: ParkHandoffRequest) => Promise<ParkHandoffResponse>): void {
		this.handler = handler;
	}

	/** Starts answering for the calls this instance has parked. */
	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		if (!this.jetstream.parkClaims.isConfigured) {
			this.logger.info(
				"park claims are local to this process; no park-handoff responder is needed",
			);
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; calls parked here cannot be collected from another instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject);
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// Sequential rather than detached: two handoffs for one instance are two people
				// dialling two orbits, and answering them in order costs nothing while making the
				// registry's read-then-claim window impossible to interleave with itself.
				const reply = await this.answer(message.data);
				if (message.reply === undefined) {
					// A request with no reply subject cannot be answered. Somebody published to this
					// subject with `publish` rather than `request`; there is nothing to do but say so.
					this.logger.warn({ subject }, "a park handoff arrived with no reply subject");
					continue;
				}
				message.respond(this.encoder.encode(JSON.stringify(reply)));
				this.served += 1;
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the park handoff subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, instanceId: this.env.ENGINE_INSTANCE_ID },
			"answering park handoffs for the calls this instance holds",
		);
	}

	/**
	 * Issues a handoff at one named instance.
	 *
	 * The subject carries the owner's token, so this reaches exactly that process — or nothing, and
	 * nothing is a timeout, which is the answer the caller needs: an owner that cannot be reached is
	 * not an owner that refused.
	 */
	async handoff(
		ownerInstanceId: string,
		request: ParkHandoffRequest,
	): Promise<ParkHandoffResponse> {
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			throw new ParkHandoffError(ownerInstanceId, "the engine has no NATS connection");
		}
		let subject: string;
		try {
			subject = subjectFor.engineParkHandoffRpc(ownerInstanceId);
		} catch (error) {
			throw new ParkHandoffError(ownerInstanceId, "that is not an addressable instance id", {
				cause: error,
			});
		}

		let reply: { data: Uint8Array };
		try {
			reply = await connection.request(subject, this.encoder.encode(JSON.stringify(request)), {
				timeout: PARK_HANDOFF_RPC.timeoutMs,
				headers: headers(),
			});
		} catch (error) {
			throw new ParkHandoffError(
				ownerInstanceId,
				`no reply within ${String(PARK_HANDOFF_RPC.timeoutMs)}ms`,
				{ cause: error },
			);
		}

		const parsed = parkHandoffResponseSchema.safeParse(
			JSON.parse(this.decoder.decode(reply.data)) as unknown,
		);
		if (!parsed.success) {
			// A reply this instance cannot read is not a refusal and must not be treated as one: the
			// far side may well have bridged the call. The caller reports "could not be reached",
			// which is the only claim that is true either way.
			throw new ParkHandoffError(ownerInstanceId, `the reply did not match the contract`, {
				cause: parsed.error,
			});
		}
		return parsed.data;
	}

	onApplicationShutdown(): void {
		this.draining = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	}

	// -------------------------------------------------------------------------------------------

	/** Decodes one request and produces the reply bytes. NEVER throws — see the class note. */
	private async answer(data: Uint8Array): Promise<ParkHandoffResponse> {
		const instanceId = this.env.ENGINE_INSTANCE_ID;
		let request: ParkHandoffRequest;
		try {
			request = parkHandoffRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			return {
				ok: false,
				parkLotId: "",
				slot: 0,
				instanceId,
				reason: "bad_request",
				error: String(error),
			};
		}

		const handler = this.handler;
		if (handler === undefined) {
			return {
				ok: false,
				parkLotId: request.parkLotId,
				slot: request.slot,
				instanceId,
				reason: "internal",
				error: "this instance is not serving park handoffs yet",
			};
		}

		try {
			return await handler(request);
		} catch (error) {
			this.logger.error({ err: String(error) }, "a park handoff handler threw");
			return {
				ok: false,
				parkLotId: request.parkLotId,
				slot: request.slot,
				instanceId,
				reason: "internal",
				error: String(error),
			};
		}
	}
}
