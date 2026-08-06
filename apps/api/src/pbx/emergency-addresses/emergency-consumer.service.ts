import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from "nats";
import { getLogger } from "@optimiq-voice/logger";
import { PBX_ENV } from "../shared/pbx.tokens";
import { EmergencyNotificationService } from "./emergency-notification.service";
import type { PbxEnv } from "../shared/pbx-env";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/** The durable this consumer binds to. Named, so a redeploy resumes rather than replays. */
export const EMERGENCY_DURABLE = "pbx-emergency-notifier";

/**
 * The subject this consumer filters on.
 *
 * `calls.evt.v1.<orgId>.<callId>.call.emergency.dialed` — the event token itself contains dots, so
 * the tail is four literal tokens rather than one. Spelled out here instead of derived from
 * `subjectFilterFor.callEventInOrg`, which needs a concrete organization id and this consumer is
 * deliberately cross-tenant: one durable serves every organization, and the tenant is read off the
 * subject exactly as `VoicemailConsumer` reads the mailbox off its own.
 */
export const EMERGENCY_SUBJECT_FILTER = "calls.evt.v1.*.*.call.emergency.dialed";

/**
 * Delivers Kari's Law notifications for `call.emergency.dialed`.
 *
 * ## Why this exists at all
 *
 * `packages/events` names this event "the Kari's Law notification seam" and states that delivery
 * is a consumer's job. Until now there was no consumer: the engine published the event, JetStream
 * retained it for 72 hours, and nobody was told that somebody had dialled 911. This is the half
 * that makes the seam a feature.
 *
 * ## Ack policy, and why an ack is not a delivery receipt
 *
 * The unit of work here is a NOTIFICATION, not a row, so there is nothing to roll back and nothing
 * a redelivery can corrupt. The message is therefore acked as soon as it has been READ and
 * understood — before the send — and the send is a best-effort continuation:
 *
 * - A relay that is down must not park the message and block every later emergency call's
 *   notification behind it. A stuck consumer is the one failure mode a life-safety path cannot
 *   have, and `max_deliver` with a NAK backoff is exactly a way to build one.
 * - `EmergencyNotificationService.notify` never throws — every refusal is a named outcome — so
 *   there is no failure path that could reach a NAK by accident.
 * - The visible consequence of a failed send is a `logger.error` naming the organization and the
 *   event id, which is a thing an operator can act on. A silently redelivered message is not.
 *
 * A message that is not this contract, or whose envelope disagrees with the subject it arrived
 * on, is TERMINATED rather than NAKed, for the reason `VoicemailConsumer` records: bytes that are
 * not this contract will never become this contract, and redelivering them forever blocks
 * everything behind them.
 *
 * ## Idempotency
 *
 * JetStream guarantees at-least-once, and this consumer's own ordering (ack, then send) means a
 * crash in between produces a message that is acked and never sent, while a redelivery driven by
 * a broker restart produces a second send of a message somebody already has. Both are accepted in
 * that direction, and the second is made harmless the same way voicemail-to-email makes it
 * harmless: every send carries `X-Optimiq-Emergency-Event-Id` set to the ENVELOPE's uuid v7, which
 * is stable across redeliveries, so a mail store can thread or collapse the duplicate. A duplicate
 * "somebody dialled 911" is an annoyance; a suppressed one is a compliance failure, so no
 * server-side dedupe table stands between the event and the send.
 */
@Injectable()
export class EmergencyConsumer implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private running = false;
	private stopped = false;
	private handled = 0;
	private terminated = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(EmergencyNotificationService)
		private readonly notifications: EmergencyNotificationService,
	) {}

	get stats(): {
		readonly running: boolean;
		readonly handled: number;
		readonly terminated: number;
		readonly failed: number;
	} {
		return {
			running: this.running,
			handled: this.handled,
			terminated: this.terminated,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — emergency-call notifications will not be delivered. The engine " +
					"still places the call and still publishes call.emergency.dialed; the notification " +
					"lands when a broker is configured and the stream is replayed.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				name: "optimiq-api-emergency",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			// Fire-and-forget: the consume loop is long-lived and awaiting it here would never return.
			void this.run();
		} catch (error) {
			this.failed += 1;
			logger.error("could not connect the emergency notification consumer", error);
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		this.running = false;
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * The consume loop.
	 *
	 * `DeliverPolicy.All` on a durable that does not exist yet, matching `VoicemailConsumer`: a
	 * broker that had emergency events queued before this service first booted notifies about them
	 * rather than skipping to the head. `CALLS` is `discard: old` and 72 hours deep, so the worst
	 * case is a burst of late notices, each of which says when the call was actually placed.
	 */
	private async run(): Promise<void> {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}
		const { ensureStreams, CALLS_STREAM } = await import("@optimiq-voice/events/streams");

		try {
			const manager = await connection.jetstreamManager();
			await ensureStreams(manager, [CALLS_STREAM]);
			await manager.consumers.add(CALLS_STREAM.name, {
				durable_name: EMERGENCY_DURABLE,
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.All,
				filter_subject: EMERGENCY_SUBJECT_FILTER,
				max_deliver: 10,
			});
		} catch (error) {
			// `consumers.add` on an existing durable with identical config is a no-op; anything else
			// here means the consumer cannot run, and saying so once is better than a silent loop.
			if (!/consumer already exists/iu.test(String(error))) {
				logger.error("could not create the emergency durable consumer", error);
			}
		}

		try {
			const consumer = await connection
				.jetstream()
				.consumers.get(CALLS_STREAM.name, EMERGENCY_DURABLE);
			const messages = await consumer.consume();
			this.running = true;
			logger.info("emergency notification consumer running", {
				durable: EMERGENCY_DURABLE,
				subject: EMERGENCY_SUBJECT_FILTER,
			});
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				await this.handle(message);
			}
		} catch (error) {
			if (!this.stopped) {
				this.failed += 1;
				logger.error("the emergency notification consumer stopped", error);
			}
		}
		this.running = false;
	}

	private async handle(message: {
		readonly subject: string;
		readonly data: Uint8Array;
		ack(): void;
		nak(millis?: number): void;
		term(): void;
	}): Promise<void> {
		// The schemas subpath rather than the package root, for the reason `voicemail-consumer.
		// service.ts` records: `apps/api`'s tooling tsconfig still relaxes `strictNullChecks`, and
		// `validate.ts` needs it in order to narrow a discriminated union.
		const { callEventSchema } = await import("@optimiq-voice/events/schemas");

		let envelope: EmergencyEnvelope;
		try {
			envelope = callEventSchema.parse(
				JSON.parse(new TextDecoder().decode(message.data)),
			) as unknown as EmergencyEnvelope;
		} catch (error) {
			this.terminated += 1;
			logger.error("terminating a call event that is not readable as one", {
				subject: message.subject,
				error,
			});
			message.term();
			return;
		}

		if (envelope.type !== "call.emergency.dialed") {
			// The filter should make this unreachable; acking rather than terminating keeps a
			// widened filter from destroying somebody else's messages.
			message.ack();
			return;
		}
		if (envelope.subject !== message.subject) {
			// The tenancy cross-check `validateEvent` would have made: an envelope whose own subject
			// disagrees with the one it was delivered on could scope this notification — and the
			// settings read behind it — to the wrong tenant.
			this.terminated += 1;
			logger.error("terminating an emergency event delivered on a foreign subject", {
				subject: message.subject,
				envelopeSubject: envelope.subject,
			});
			message.term();
			return;
		}

		// Acked BEFORE the send, deliberately — see the class header. Everything below this line is
		// a best-effort continuation that cannot fail the delivery or park the consumer.
		message.ack();
		this.handled += 1;

		const data = envelope.data;
		const outcome = await this.notifications.notify(envelope.orgId, {
			eventId: envelope.id,
			dialedAt: parseInstant(envelope.at),
			dialed: data.dialed,
			number: data.number,
			...(data.callerNumber === undefined ? {} : { callerNumber: data.callerNumber }),
			...(data.callerName === undefined ? {} : { callerName: data.callerName }),
			...(data.elin === undefined ? {} : { elin: data.elin }),
			...(data.emergencyAddressId === undefined
				? {}
				: { emergencyAddressId: data.emergencyAddressId }),
			...(data.trunkName === undefined ? {} : { trunkName: data.trunkName }),
		});

		if (outcome.outcome === "failed") {
			this.failed += 1;
			// Already logged with the cause by the service; this records the call it belonged to, and
			// it is an ERROR rather than a warning because an undelivered Kari's Law notification is
			// a compliance event, not a degraded feature.
			logger.error("an emergency call was placed and its notification could not be delivered", {
				organizationId: envelope.orgId,
				eventId: envelope.id,
				number: data.number,
			});
		}
	}
}

/** The envelope's `at`, or now — a malformed instant must not stop a life-safety notification. */
function parseInstant(value: string): Date {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * The envelope this consumer acts on.
 *
 * Declared structurally rather than imported as `CallEventEnvelope`, for the same
 * `strictNullChecks` reason as the dynamic import above: naming the inferred union type here drags
 * the package root's `validate.ts` into this app's compilation.
 */
interface EmergencyEnvelope {
	readonly id: string;
	readonly at: string;
	readonly type: string;
	readonly orgId: string;
	readonly subject: string;
	readonly data: {
		readonly legId: string;
		readonly dialed: string;
		readonly number: string;
		readonly callerNumber?: string;
		readonly callerName?: string;
		readonly elin?: string;
		readonly emergencyAddressId?: string;
		readonly trunkName?: string;
	};
}
