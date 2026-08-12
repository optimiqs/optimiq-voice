import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";
import { makeCallEvent, validateEvent } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { CALL_EVENTS_CLIENT } from "./nats.tokens";
import type { CallEvent, CallEventDataOf, CallEventOf } from "@optimiq-voice/events";

/**
 * Publishes channel lifecycle events on the NATS backbone.
 *
 * ## The transport choice
 *
 * NestJS's NATS transport (`ClientProxy.emit`), i.e. a CORE publish — the sanctioned default from
 * plan §3.5. The `CALLS` JetStream stream subscribes to `calls.evt.v1.>`, so these events are
 * still captured, replayable and consumable durably; what a core publish gives up is the
 * per-message ack. That is the right trade here and the wrong one for the CDR (see
 * `jetstream.service.ts`): call events are high-volume live state where a round trip per channel
 * state change would sit in the middle of the call path, and the `CALLS` stream is `discard: old`
 * precisely because a newer event supersedes a lost one.
 *
 * ## Validate before publish, always
 *
 * Every event is built by `makeCallEvent` (which validates) and then re-validated by
 * `validateEvent` against the schema its SUBJECT selects. That second check is not redundant: it
 * is the cross-check that catches an envelope whose `orgId` disagrees with the org token in its
 * own subject — the tenancy bug that survives schema validation and would let a consumer scope a
 * write to the wrong tenant.
 *
 * A malformed event therefore never reaches the broker. It is logged and dropped, because the
 * alternative — throwing into the ARI event handler — would end a live call over a reporting
 * defect.
 */
@Injectable()
export class CallEventPublisher implements OnModuleInit, OnApplicationShutdown {
	private readonly logger = getLogger("engine.call-events");
	private published = 0;
	private rejected = 0;

	constructor(@Inject(CALL_EVENTS_CLIENT) private readonly client: ClientProxy) {}

	/** Events successfully handed to the broker since boot. */
	get publishedCount(): number {
		return this.published;
	}

	/** Events dropped because they did not satisfy their own contract. Should always be zero. */
	get rejectedCount(): number {
		return this.rejected;
	}

	async onModuleInit(): Promise<void> {
		await this.client.connect();
	}

	/**
	 * Builds, validates and publishes one call event.
	 *
	 * Returns the envelope handed to the broker, or `undefined` when validation or transport fails.
	 * Callers that own a recoverable workflow can therefore distinguish success without re-deriving
	 * the subject.
	 */
	async publish<TType extends CallEvent>(
		type: TType,
		input: {
			readonly orgId: string;
			readonly callId: string;
			readonly data: CallEventDataOf<TType>;
			readonly id?: string;
			readonly at?: Date;
			readonly correlationId?: string;
		},
	): Promise<CallEventOf<TType> | undefined> {
		let envelope: CallEventOf<TType>;
		try {
			envelope = makeCallEvent(type, {
				orgId: input.orgId,
				callId: input.callId,
				source: "engine",
				data: input.data,
				id: input.id,
				at: input.at,
				correlationId: input.correlationId,
			});
			validateEvent(envelope.subject, envelope);
		} catch (error) {
			this.rejected += 1;
			this.logger.error(
				{ type, orgId: input.orgId, callId: input.callId, err: String(error) },
				"refusing to publish an event that does not satisfy its contract",
			);
			return undefined;
		}

		try {
			// `emit` returns a cold Observable; nothing is sent until it is subscribed to.
			await firstValueFrom(this.client.emit(envelope.subject, envelope));
			this.published += 1;
			return envelope;
		} catch (error) {
			this.logger.error(
				{ type, subject: envelope.subject, err: String(error) },
				"failed to publish a call event",
			);
			return undefined;
		}
	}

	async onApplicationShutdown(): Promise<void> {
		await this.client.close();
	}
}
