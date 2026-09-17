import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { sessionVerbRequestSchema, subjectFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type {
	SessionVerbRefusalReason,
	SessionVerbRequest,
	SessionVerbResponse,
} from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * The engine half of the session protocol: one verb, on one leg, from an external application.
 *
 * ## Instance-addressed, and no queue group
 *
 * The subject carries this instance's own token, exactly like `park-handoff` and for the same
 * reason: the leg the verb acts on lives on ONE instance's media channel, and only that instance can
 * touch it. The control plane learned which instance that is from the announcement that opened the
 * session and has held it ever since, so there is no lookup and no directory — the address travelled
 * with the offer.
 *
 * A flat subject with a queue group, the shape `originate` uses, would be wrong here for the reason
 * `originate` is right there: an originate CREATES a call, so any instance may serve it and exactly
 * one must. A verb addresses a call that already exists, and on a fleet of eight a queue group
 * delivers it to the wrong engine seven times out of eight.
 *
 * ## Every refusal is data
 *
 * The loop never throws, the handler never throws, and every path produces a
 * {@link SessionVerbResponse}. The caller is a WebSocket with a human application on the other end
 * of it, and "the request timed out" is the one answer it cannot debug: `unknown-leg` says the call
 * ended, `session-mismatch` says it is talking about somebody else's call, and `not-permitted` says
 * the verb was refused and why.
 */
const SESSION_VERB_LOGGER = "engine.session";

/** What the orchestrator does with one decoded verb. Never throws — a throw would end the loop. */
export interface SessionVerbHandler {
	execute(request: SessionVerbRequest): Promise<SessionVerbOutcome>;
}

/**
 * The handler's answer, minus the bookkeeping this service adds.
 *
 * `instanceId` is deliberately not here: it is this service's own identity, it is the same on every
 * reply, and a handler that could set it could attribute its answer to another engine.
 */
export type SessionVerbOutcome = Omit<SessionVerbResponse, "instanceId">;

@Injectable()
export class SessionVerbService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger(SESSION_VERB_LOGGER);
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private handler: SessionVerbHandler | undefined;
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
		return subjectFor.engineSessionVerbRpc(this.env.ENGINE_INSTANCE_ID);
	}

	attach(handler: SessionVerbHandler): void {
		this.handler = handler;
	}

	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; the session protocol will not work on this instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject);
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// CONCURRENT, unlike every other responder on this connection, and this is the one place
				// that difference is load-bearing. A `gather` waits for a person to finish dialling and a
				// `dial` waits for a phone to be answered — both for as long as their own timeout allows.
				// Serving these sequentially would mean one application's caller pressing digits blocks
				// every other call this instance is holding for an application. Each verb already acts on
				// exactly one leg, so there is no shared state to serialise for.
				void this.serve(message.data, message.reply, (reply) => {
					message.respond(this.encoder.encode(JSON.stringify(reply)));
				});
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the session-verb subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, instanceId: this.env.ENGINE_INSTANCE_ID },
			"answering session-protocol verbs for the legs this instance holds",
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
		respond: (reply: SessionVerbResponse) => void,
	): Promise<void> {
		const answer = await this.answer(data);
		if (reply === undefined) {
			this.logger.warn({ subject: this.subject }, "a session verb arrived with no reply subject");
			return;
		}
		respond(answer);
		this.served += 1;
		if (answer.ok) {
			this.executed += 1;
		}
	}

	/** Decodes one request and produces the reply. NEVER throws — a throw would end the loop. */
	private async answer(data: Uint8Array): Promise<SessionVerbResponse> {
		let request: SessionVerbRequest;
		try {
			request = sessionVerbRequestSchema.parse(JSON.parse(this.decoder.decode(data)) as unknown);
		} catch (error) {
			// The verb name is unknown at this point, so the reply says `hangup` — the one verb whose
			// meaning is unambiguous and whose echo cannot be mistaken for a command having run.
			return this.refuse("hangup", "bad_request", String(error));
		}

		if (this.draining) {
			return this.refuse(request.verb, "shutting-down", "this engine instance is draining");
		}
		const handler = this.handler;
		if (handler === undefined) {
			return this.refuse(request.verb, "internal", "this engine has no session handler attached");
		}

		let outcome: SessionVerbOutcome;
		try {
			outcome = await handler.execute(request);
		} catch (error) {
			this.logger.error(
				{
					orgId: request.orgId,
					sessionId: request.sessionId,
					legId: request.legId,
					verb: request.verb,
					err: error,
				},
				"the session verb handler threw",
			);
			return this.refuse(request.verb, "internal", String(error));
		}
		return { ...outcome, instanceId: this.env.ENGINE_INSTANCE_ID };
	}

	private refuse(
		verb: SessionVerbResponse["verb"],
		reason: SessionVerbRefusalReason,
		error: string,
	): SessionVerbResponse {
		return {
			ok: false,
			verb,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			reason,
			error: error.slice(0, 512),
		};
	}
}
