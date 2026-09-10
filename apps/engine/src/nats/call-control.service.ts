import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { callControlRequestSchema, subjectFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type {
	CallControlRefusalReason,
	CallControlRequest,
	CallControlResponse,
} from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * The engine half of the PBX recording control: one verb, on one CALL, from the control plane.
 *
 * ## Why this is not `session-verb`
 *
 * The session verb channel is authorised against the session id the engine minted when an
 * application TOOK a call — `application-sessions.ts` refuses `unknown-leg` for any leg no live
 * session holds. A call an agent dialled from the softphone or a desk phone was handed to nobody,
 * so there is no such handle, and the two ways to reach one would have been to mint a session for
 * every call in the platform or to punch an escape through the one check that makes a session id
 * mean anything. This subject instead authorises on what the control plane genuinely has: the
 * call's organization, which it takes from the operator's own login, and ownership of the leg,
 * which is re-checked HERE against this instance's own registry rather than trusted from the
 * address.
 *
 * ## Instance-addressed, and no queue group
 *
 * Exactly like `session-verb`, `park-handoff` and `conference-control`, and for the reason all
 * three give: the leg lives on ONE instance's media channel. The address is read out of the
 * `channels` bucket, which carries `variables.OPTIMIQ_ENGINE_INSTANCE_ID` on every value — so an
 * entry that has gone stale (the leg was adopted after a failover) reaches an engine that no longer
 * holds the call, which answers `wrong_instance` and tells the caller to re-read rather than
 * pretending the call ended.
 *
 * ## Every refusal is data
 *
 * The loop never throws and the handler never throws. The thing waiting is an HTTP request with an
 * agent behind it who is about to read a card number aloud, and on that path the one unusable
 * answer is a timeout: `not-recording` says the button should not be there, `unsupported` says this
 * call's media plane cannot do it, and `wrong_instance` says try again.
 */
const CALL_CONTROL_LOGGER = "engine.calls";

/** What the orchestrator does with one decoded verb. Never throws — a throw would end the loop. */
export interface CallControlHandler {
	control(request: CallControlRequest): Promise<CallControlOutcome>;
}

/**
 * The handler's answer, minus the bookkeeping this service adds.
 *
 * `instanceId` is deliberately not here, on {@link import("./session-verb.service").SessionVerbOutcome}'s
 * terms: it is this service's own identity, it is the same on every reply, and a handler that could
 * set it could attribute its answer to another engine.
 */
export type CallControlOutcome = Omit<CallControlResponse, "instanceId">;

@Injectable()
export class CallControlService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger(CALL_CONTROL_LOGGER);
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private handler: CallControlHandler | undefined;
	private draining = false;
	private served = 0;
	private executed = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	get stats(): {
		readonly listening: boolean;
		readonly served: number;
		readonly executed: number;
	} {
		return {
			listening: this.subscription !== undefined,
			served: this.served,
			executed: this.executed,
		};
	}

	/** The subject this instance answers on. Exposed for the log line and for the specs. */
	get subject(): string {
		return subjectFor.engineCallControlRpc(this.env.ENGINE_INSTANCE_ID);
	}

	attach(handler: CallControlHandler): void {
		this.handler = handler;
	}

	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; recording control will not reach this instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject);
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// Sequential, unlike `session-verb`'s concurrent loop, and the difference is the shape
				// of the work: every verb here is a map lookup plus one media command with a 500 ms
				// budget of its own, so nothing on this subject waits for a person. Serving them in
				// order also means two presses of the same button cannot race each other.
				await this.serve(message.data, message.reply, (reply) => {
					message.respond(this.encoder.encode(JSON.stringify(reply)));
				});
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the call-control subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, instanceId: this.env.ENGINE_INSTANCE_ID },
			"answering recording control for the calls this instance holds",
		);
	}

	onApplicationShutdown(): void {
		this.draining = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	}

	// -------------------------------------------------------------------------------------------

	private async serve(
		data: Uint8Array,
		reply: string | undefined,
		respond: (reply: CallControlResponse) => void,
	): Promise<void> {
		const answer = await this.answer(data);
		if (reply === undefined) {
			this.logger.warn({ subject: this.subject }, "a call-control verb arrived with no reply");
			return;
		}
		respond(answer);
		this.served += 1;
		if (answer.ok) {
			this.executed += 1;
		}
	}

	/** Decodes one request and produces the reply. NEVER throws — a throw would end the loop. */
	private async answer(data: Uint8Array): Promise<CallControlResponse> {
		let request: CallControlRequest;
		try {
			request = callControlRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			// The verb is unknown at this point, so the echo says `pauseRecord` — the one verb whose
			// echo cannot be mistaken for something destructive having run.
			return this.refuse("pauseRecord", "bad_request", String(error));
		}

		if (this.draining) {
			return this.refuse(request.verb, "shutting-down", "this engine instance is draining");
		}
		const handler = this.handler;
		if (handler === undefined) {
			return this.refuse(request.verb, "internal", "this engine has no call-control handler");
		}

		let outcome: CallControlOutcome;
		try {
			outcome = await handler.control(request);
		} catch (error) {
			this.logger.error(
				{
					orgId: request.orgId,
					callId: request.callId,
					legId: request.legId,
					verb: request.verb,
					err: error,
				},
				"the call-control handler threw",
			);
			return this.refuse(request.verb, "internal", String(error));
		}
		return { ...outcome, instanceId: this.env.ENGINE_INSTANCE_ID };
	}

	private refuse(
		verb: CallControlResponse["verb"],
		reason: CallControlRefusalReason,
		error: string,
	): CallControlResponse {
		return {
			ok: false,
			verb,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			reason,
			error: error.slice(0, 512),
		};
	}
}
