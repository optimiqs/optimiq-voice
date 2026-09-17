import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { conferenceControlRequestSchema, subjectFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type {
	ConferenceControlRefusalReason,
	ConferenceControlRequest,
	ConferenceControlResponse,
} from "@optimiq-voice/events";
import type { Subscription } from "nats";

/**
 * The engine half of in-conference moderation: one command, on one live room, from the control plane.
 *
 * ## Instance-addressed, and the address is not one this instance was told
 *
 * The subject carries this instance's own token, like `park-handoff` and `session-verb`, and for a
 * reason that is the same shape and a different story. A parked call lives on ONE instance, and so
 * does a session's leg; a conference does NOT — `conference-claims` records one contribution per
 * engine instance with members in the room, and the room belongs to all of them jointly. What lives
 * on exactly one instance is each MEMBER, because a member is a media channel and only the process
 * holding it can mute it.
 *
 * So there is no instance that can serve "mute participant X in room Y" except the one holding X, and
 * nothing tells the control plane which that is. `session-verb` was told by the announcement that
 * opened the session; nothing announces a conference. The api therefore reads the room's claim —
 * which already names every instance with unexpired members — and addresses each in turn until one
 * answers something other than `unknown-member`.
 *
 * That fan-out is the cheapest honest shape, and the alternative is worth naming so the choice is
 * legible: a second directory of per-member ownership, written on every join, deleted on every leave
 * and reaped after every crash, to save a request on a path an operator drives by clicking a button.
 * The claim is already written, already leased and already read on the join path.
 *
 * ## `unknown-conference` and `unknown-member` are the protocol, not errors
 *
 * They are how the caller knows to try the next contributor, so they must be REFUSALS rather than
 * throws and must be distinguishable from each other. "The room is here and that member is not" is a
 * useful thing for an api to log when every contributor says it: the participant has left.
 *
 * ## Every refusal is data, and the loop never throws
 *
 * The same posture `session-verb.service.ts` takes, for the same reason: the caller is an HTTP
 * request with a person behind it, and "the request timed out" is the one answer nobody can act on.
 */
const CONFERENCE_CONTROL_LOGGER = "engine.conference";

/** What actually performs a moderation command. Never throws — a throw would end the loop. */
export interface ConferenceControlHandler {
	moderate(request: ConferenceControlRequest): Promise<ConferenceControlOutcome>;
}

/**
 * The handler's answer, minus the bookkeeping this service adds.
 *
 * `instanceId` is deliberately not here: it is this service's own identity, it is the same on every
 * reply, and a handler that could set it could attribute its answer to another engine.
 */
export type ConferenceControlOutcome = Omit<ConferenceControlResponse, "instanceId">;

@Injectable()
export class ConferenceControlService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger(CONFERENCE_CONTROL_LOGGER);
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	private subscription: Subscription | undefined;
	private handler: ConferenceControlHandler | undefined;
	private draining = false;
	private served = 0;
	private applied = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	get stats(): {
		readonly listening: boolean;
		readonly served: number;
		readonly applied: number;
	} {
		return {
			listening: this.subscription !== undefined,
			served: this.served,
			applied: this.applied,
		};
	}

	/** The subject this instance answers on. Exposed for the log line and for the specs. */
	get subject(): string {
		return subjectFor.engineConferenceControlRpc(this.env.ENGINE_INSTANCE_ID);
	}

	attach(handler: ConferenceControlHandler): void {
		this.handler = handler;
	}

	/**
	 * Starts answering for the conference members this instance holds.
	 *
	 * Unlike `park-handoff.service.ts`, this subscribes whether or not the claim bucket is configured.
	 * The park responder can skip a bucket-less deployment because without shared claims no claim can
	 * name a foreign owner and the subject is dead; here the SINGLE instance is still the one holding
	 * every member of every room, and the api still has to reach it. A bucket-less deployment simply
	 * has one contributor to try.
	 */
	onApplicationBootstrap(): void {
		if (this.subscription !== undefined) {
			return;
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			this.logger.warn(
				"the engine has no NATS connection; conference moderation will not work on this instance",
			);
			return;
		}

		const subject = this.subject;
		this.subscription = connection.subscribe(subject);
		const subscription = this.subscription;

		void (async () => {
			for await (const message of subscription) {
				// SEQUENTIAL, unlike `session-verb`, and the difference is what each command waits on. A
				// verb can be a `gather` that waits for a person to finish dialling; a moderation command
				// is one media round trip and one compare-and-set, and serving them in order means two
				// operators clicking mute on the same room cannot interleave a read and a write of the
				// same claim.
				await this.serve(message.data, message.reply, (reply) => {
					message.respond(this.encoder.encode(JSON.stringify(reply)));
				});
			}
			if (!this.draining) {
				this.logger.warn({ subject }, "the conference-control subscription ended unexpectedly");
			}
		})();

		this.logger.info(
			{ subject, instanceId: this.env.ENGINE_INSTANCE_ID },
			"answering conference moderation for the members this instance holds",
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
		respond: (reply: ConferenceControlResponse) => void,
	): Promise<void> {
		const answer = await this.answer(data);
		if (reply === undefined) {
			this.logger.warn(
				{ subject: this.subject },
				"a conference-control command arrived with no reply subject",
			);
			return;
		}
		respond(answer);
		this.served += 1;
		if (answer.ok) {
			this.applied += 1;
		}
	}

	/** Decodes one request and produces the reply. NEVER throws — a throw would end the loop. */
	private async answer(data: Uint8Array): Promise<ConferenceControlResponse> {
		let request: ConferenceControlRequest;
		try {
			request = conferenceControlRequestSchema.parse(
				JSON.parse(this.decoder.decode(data)) as unknown,
			);
		} catch (error) {
			// The action is unknown at this point, so the reply says `unlock` — the one verb whose echo
			// cannot be mistaken for something having been taken away from a participant.
			return this.refuse("unlock", "bad-request", String(error));
		}

		if (this.draining) {
			// A draining instance answers as though it holds nothing, which is honest rather than
			// evasive: it is about to hang its remaining legs up, so its members are leaving the room
			// whatever the moderator wanted done to them.
			return this.refuse(request.action, "shutting-down", "this engine instance is draining");
		}
		const handler = this.handler;
		if (handler === undefined) {
			return this.refuse(
				request.action,
				"internal",
				"this engine has no conference-control handler attached",
			);
		}

		let outcome: ConferenceControlOutcome;
		try {
			outcome = await handler.moderate(request);
		} catch (error) {
			this.logger.error(
				{
					orgId: request.orgId,
					conferenceId: request.conferenceId,
					memberRef: request.memberRef,
					action: request.action,
					err: error,
				},
				"the conference-control handler threw",
			);
			return this.refuse(request.action, "internal", String(error));
		}
		return { ...outcome, instanceId: this.env.ENGINE_INSTANCE_ID };
	}

	private refuse(
		action: ConferenceControlResponse["action"],
		reason: ConferenceControlRefusalReason,
		error: string,
	): ConferenceControlResponse {
		return {
			ok: false,
			action,
			instanceId: this.env.ENGINE_INSTANCE_ID,
			memberCount: 0,
			reason,
			error: error.slice(0, 512),
		};
	}
}
