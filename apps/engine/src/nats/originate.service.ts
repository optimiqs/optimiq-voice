import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import {
	originateRequestSchema,
	queueCallbackRequestSchema,
	subjectFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type {
	OriginateRefusalReason,
	OriginateRequest,
	OriginateResponse,
	QueueCallbackRpcRequest,
	QueueCallbackRpcResponse,
} from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * The queue group every engine instance joins.
 *
 * The subject is FLAT — see `RPC_SUBJECTS.engineOriginate` — because an originate has no owner to
 * address: it CREATES the call, so whichever instance answers becomes the one holding it. That is
 * the opposite of `rpc.engine.v1.park-handoff`, whose subject names one instance because the call it
 * moves already lives on exactly one, and it is why this responder has no `wrong_instance` in its
 * vocabulary while that one does.
 *
 * The queue group is what makes "any instance" mean "exactly one instance". A plain subscription on
 * three engines would place THREE calls for one dial button.
 */
const ORIGINATE_QUEUE_GROUP = "optimiq-engine-originate";

/**
 * The queue group for virtual hold's dialler, and it is a SEPARATE one.
 *
 * Two groups on two subjects rather than one group on both, because a queue group is a unit of load
 * balancing and these two loads are not alike: a click-to-call is a person waiting on a button, a
 * callback sweep is a batch. Sharing a group would let a burst of callbacks after an outage sit in
 * front of somebody's dial button on the same instance's sequential loop.
 */
const QUEUE_CALLBACK_QUEUE_GROUP = "optimiq-engine-queue-callback";

/** What the call path did with an origination. A refusal is data, never a throw. */
export type OriginatePlacement =
	| {
			readonly kind: "placed";
			/** The engine's own call id, derived from the media channel. */
			readonly callId: string;
			readonly legId: string;
			readonly endpoint: string;
			/** The destination after the plan's normalisation, when it differs from the request's. */
			readonly destination?: string;
	  }
	| {
			readonly kind: "refused";
			readonly reason: OriginateRefusalReason;
			readonly error: string;
	  };

/**
 * What this responder needs from the call path, and nothing more.
 *
 * ONE method, where `SipTransferCallPath` has four, and the difference is not inconsistency. A
 * transfer is a sequence of decisions about a call that already exists — resolve the dialog, check
 * the referrer owns it, check the target, then move it — and each of those is a refusal this
 * responder must be able to produce and a spec must be able to reach. An originate has no such
 * sequence: every question it can ask is about the tenant's compiled plan and its media server, both
 * of which live on the other side of this seam, and splitting them across methods here would only
 * move the orchestrator's internals into an interface.
 *
 * So the split is: the responder owns the WIRE (framing, validation, draining, the reply shape) and
 * the call path owns the CALL. `planOriginate` in `calls/originate-plan.ts` is where the dial-plan
 * half is unit-tested, without either of them.
 */
export interface OriginateCallPath {
	/** Places the A-leg towards the extension. Never throws; a failure is a `refused` placement. */
	place(request: OriginateRequest): Promise<OriginatePlacement>;
	/**
	 * Places virtual hold's A-leg towards the CUSTOMER. Never throws, on the same contract.
	 *
	 * OPTIONAL, and that is a deployment statement rather than laziness: the call path that can
	 * create an outbound leg towards an arbitrary number is the orchestrator's, and an engine whose
	 * call path does not supply one answers `not_supported` — a named, actionable refusal — instead
	 * of a silence that costs the sweep its whole deadline once per token.
	 */
	placeQueueCallback?(request: QueueCallbackRpcRequest): Promise<OriginatePlacement>;
}

/**
 * `rpc.engine.v1.originate` — the control plane asking this engine to place a click-to-call.
 *
 * ## Why the engine and not the API
 *
 * Because origination is a media-server operation and `apps/api` holds no media handle, by the same
 * rule that keeps a database handle out of the engine. The control plane knows WHO may dial; the
 * engine knows how a channel is made. This subject is the sentence between them.
 *
 * ## Raw NATS, with both ends in NestJS
 *
 * The rule of thumb in `packages/events/src/schemas/rpc.ts` would allow `@MessagePattern` here —
 * neither end is Go. It is raw anyway because the engine already answers `rpc.sip.v1.transfer` and
 * `rpc.engine.v1.park-handoff` on its one raw connection, and a second transport for a third subject
 * would mean two framings on one surface and a wire that depends on which file a subject was added
 * in. It also means a future Go caller works unchanged, which is not true of the alternative.
 *
 * ## An unattached call path answers `internal`, and that is a refusal rather than a silence
 *
 * `ChannelOrchestrator` attaches one from its constructor, so a running engine always has it; what
 * does not is the window before Nest has built the calls module. Answering nothing would cost the API
 * its whole five-second deadline and tell it that the engine is down, which is both wrong and
 * unactionable. `internal` with the reason spelled out gets a 500 the operator can read.
 */
@Injectable()
export class OriginateService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger("engine.originate");
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private callbackSubscription: Subscription | undefined;
	private callPath: OriginateCallPath | undefined;
	private draining = false;
	private served = 0;
	private placed = 0;
	private callbacksServed = 0;
	private callbacksPlaced = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	/** Whether this instance is answering originates, and what it has done with them. */
	get stats(): {
		readonly listening: boolean;
		readonly served: number;
		readonly placed: number;
		readonly callbacksServed: number;
		readonly callbacksPlaced: number;
	} {
		return {
			listening: this.subscription !== undefined,
			served: this.served,
			placed: this.placed,
			callbacksServed: this.callbacksServed,
			callbacksPlaced: this.callbacksPlaced,
		};
	}

	/** The subject this instance answers on. Exposed for the log line and for the specs. */
	get subject(): string {
		return subjectFor.engineOriginateRpc();
	}

	/** The virtual-hold dialler's subject. Exposed for the log line and for the specs. */
	get callbackSubject(): string {
		return subjectFor.engineQueueCallbackRpc();
	}

	/**
	 * Registers the call path. Pushed by the orchestrator from its own constructor, exactly as
	 * `SipTransferService.attach` and `ParkHandoffService.setHandler` are, and for the same reason:
	 * pulling would be a Nest cycle between `NatsModule` and `CallsModule`.
	 */
	attach(callPath: OriginateCallPath): void {
		this.callPath = callPath;
	}

	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; click-to-call will not work on this instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject, { queue: ORIGINATE_QUEUE_GROUP });
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// Sequential, as with the other two responders on this connection. An originate is a
				// handful of media-server calls and is bounded by its own five-second contract, and the
				// alternative — placing calls concurrently off one loop — would let a media server that
				// has gone slow accumulate half-created channels nobody is waiting for.
				const reply = await this.answer(message.data);
				if (message.reply === undefined) {
					this.logger.warn({ subject }, "an originate arrived with no reply subject");
					continue;
				}
				message.respond(this.encoder.encode(JSON.stringify(reply)));
				this.served += 1;
				if (reply.ok) {
					this.placed += 1;
				}
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the originate subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, queue: ORIGINATE_QUEUE_GROUP, instanceId: this.env.ENGINE_INSTANCE_ID },
			"answering click-to-call originations from the control plane",
		);

		const callbackSubject = this.callbackSubject;
		this.callbackSubscription = connection.subscribe(callbackSubject, {
			queue: QUEUE_CALLBACK_QUEUE_GROUP,
		});
		const callbacks = this.callbackSubscription;

		void (async () => {
			for await (const message of callbacks) {
				// Sequential, for the originate loop's reason above and one of its own: a callback sweep
				// is a batch, and a batch that fanned out would let one queue's backlog occupy every
				// channel this instance can create.
				const reply = await this.answerCallback(message.data);
				if (message.reply === undefined) {
					this.logger.warn(
						{ subject: callbackSubject },
						"a callback arrived with no reply subject",
					);
					continue;
				}
				message.respond(this.encoder.encode(JSON.stringify(reply)));
				this.callbacksServed += 1;
				if (reply.ok) {
					this.callbacksPlaced += 1;
				}
			}
			if (!this.draining) {
				this.logger.warn(
					{ subject: callbackSubject },
					"the queue-callback subscription ended unexpectedly",
				);
			}
		})();

		this.logger.info(
			{
				subject: callbackSubject,
				queue: QUEUE_CALLBACK_QUEUE_GROUP,
				instanceId: this.env.ENGINE_INSTANCE_ID,
			},
			"answering queue callbacks",
		);
	}

	onApplicationShutdown(): void {
		this.draining = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		this.callbackSubscription?.unsubscribe();
		this.callbackSubscription = undefined;
	}

	// -------------------------------------------------------------------------------------------

	/** Decodes one request and produces the reply. NEVER throws — a throw would end the loop. */
	private async answer(data: Uint8Array): Promise<OriginateResponse> {
		let request: OriginateRequest;
		try {
			request = originateRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			return this.refuse("", "bad_request", String(error));
		}

		if (this.draining) {
			// `shutting_down` and not `capacity`: the caller must retry ELSEWHERE, and on a queue group
			// a retry lands wherever the broker sends it — which, once this instance has unsubscribed,
			// is by definition another one.
			return this.refuse(request.originateId, "shutting_down", "this engine instance is draining");
		}

		const callPath = this.callPath;
		if (callPath === undefined) {
			return this.refuse(
				request.originateId,
				"internal",
				"this engine has no call path attached yet",
			);
		}

		let placement: OriginatePlacement;
		try {
			placement = await callPath.place(request);
		} catch (error) {
			// The call path documents that it does not throw. This is the defect path, and it is a
			// refusal rather than a rethrow because the loop above must survive it — one bad request
			// must not stop this instance answering every later one.
			this.logger.error(
				{ originateId: request.originateId, orgId: request.orgId, err: error },
				"the originate call path threw",
			);
			return this.refuse(request.originateId, "internal", String(error));
		}

		if (placement.kind === "refused") {
			this.logger.info(
				{
					originateId: request.originateId,
					orgId: request.orgId,
					from: request.fromExtension,
					reason: placement.reason,
				},
				"refused a click-to-call",
			);
			return this.refuse(request.originateId, placement.reason, placement.error);
		}

		this.logger.info(
			{
				originateId: request.originateId,
				orgId: request.orgId,
				callId: placement.callId,
				legId: placement.legId,
				endpoint: placement.endpoint,
			},
			"placed a click-to-call",
		);
		return {
			ok: true,
			originateId: request.originateId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			callId: placement.callId,
			legId: placement.legId,
			endpoint: placement.endpoint,
			...(placement.destination === undefined ? {} : { destination: placement.destination }),
		};
	}

	/**
	 * Decodes one callback request and produces the reply. NEVER throws, exactly as {@link answer}.
	 *
	 * The refusal vocabulary is the originate's, because the codes an engine can answer with are a
	 * property of the engine rather than of who asked. `not_supported` is the one that carries a
	 * different sentence here: on the originate it means this deployment's media driver cannot
	 * originate at all, and here it also covers a call path that supplied no callback half.
	 */
	private async answerCallback(data: Uint8Array): Promise<QueueCallbackRpcResponse> {
		let request: QueueCallbackRpcRequest;
		try {
			request = queueCallbackRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			return this.refuseCallback("", "bad_request", String(error));
		}

		if (this.draining) {
			return this.refuseCallback(
				request.callbackId,
				"shutting_down",
				"this engine instance is draining",
			);
		}

		const place = this.callPath?.placeQueueCallback?.bind(this.callPath);
		if (place === undefined) {
			return this.refuseCallback(
				request.callbackId,
				"not_supported",
				"this engine has no queue-callback call path attached",
			);
		}

		let placement: OriginatePlacement;
		try {
			placement = await place(request);
		} catch (error) {
			this.logger.error(
				{ callbackId: request.callbackId, orgId: request.orgId, err: error },
				"the queue-callback call path threw",
			);
			return this.refuseCallback(request.callbackId, "internal", String(error));
		}

		if (placement.kind === "refused") {
			this.logger.info(
				{
					callbackId: request.callbackId,
					orgId: request.orgId,
					queueId: request.queueId,
					reason: placement.reason,
				},
				"refused a queue callback",
			);
			return this.refuseCallback(request.callbackId, placement.reason, placement.error);
		}

		this.logger.info(
			{
				callbackId: request.callbackId,
				orgId: request.orgId,
				queueId: request.queueId,
				callId: placement.callId,
				legId: placement.legId,
				// The cross-call CDR link, on the log line as well as in the reply: a callback is a new
				// `call_id`, and this is the only thing that says which wait it settled.
				relatedCallId: request.relatedCallId,
			},
			"placed a queue callback",
		);
		return {
			ok: true,
			callbackId: request.callbackId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			callId: placement.callId,
			legId: placement.legId,
			endpoint: placement.endpoint,
		};
	}

	private refuseCallback(
		callbackId: string,
		reason: OriginateRefusalReason,
		error: string,
	): QueueCallbackRpcResponse {
		return {
			ok: false,
			callbackId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			reason,
			error: error.slice(0, 512),
		};
	}

	private refuse(
		originateId: string,
		reason: OriginateRefusalReason,
		error: string,
	): OriginateResponse {
		return {
			ok: false,
			originateId,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			reason,
			error: error.slice(0, 512),
		};
	}
}
