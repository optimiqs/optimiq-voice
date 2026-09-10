import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../pbx/shared/pbx.tokens";
import { messagingEventsPublished } from "./messaging.metrics";
import type { PbxEnv } from "../pbx/shared/pbx-env";

const logger = getLogger("api.messaging");

/**
 * `message.received` and `message.delivered`, onto `messaging.evt.v1`.
 *
 * Modelled on `voicemail-mwi.publisher.ts`, and the two properties worth carrying over are stated
 * there in full: the publish happens AFTER the transaction that produced the fact has committed, and
 * every failure is logged and swallowed. A missed notification is a webhook a tenant did not get; a
 * write refused because the broker was down would be a consumer's message lost for a reason that has
 * nothing to do with messaging.
 *
 * # What rides on this
 *
 * The webhook dispatcher's `messaging` consumer, which is how a tenant's integration gets a
 * screen-pop when a customer texts and a delivery outcome when one of theirs lands. `apps/api` is
 * the only publisher AND the only subscriber of this family — a text has no dialog and never reaches
 * the media plane, so nothing in the engine, sipd or mediad has any business with it, and the
 * broker's grants say so.
 *
 * # Why the payload is thin
 *
 * `message.received` carries the body only up to the schema's cap and never the media bytes. A
 * webhook is a NOTIFICATION; the content is fetched back from the API under the tenant's own
 * permissions, where RLS and `messaging.read` both apply. Fanning a consumer's message body out to
 * an arbitrary endpoint in full would make the webhook subscription a way around the read grant.
 */
@Injectable()
export class MessagingEventPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private published = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get stats(): { readonly published: number; readonly failed: number; readonly ready: boolean } {
		return { published: this.published, failed: this.failed, ready: this.isReady };
	}

	get isReady(): boolean {
		return this.connection !== undefined && this.connection.isClosed() === false;
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			// Silent, per the convention: `routing-cache.publisher.ts` already reports an absent broker
			// once at boot, and a line per publisher turns one fact into a wall.
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-messaging-events",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not connect the messaging event publisher");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/** A consumer texted one of this tenant's numbers. */
	async publishReceived(input: {
		readonly organizationId: string;
		readonly conversationId: string;
		readonly messageId: string;
		readonly messagingNumberId: string;
		readonly fromE164: string;
		readonly toE164: string;
		readonly kind: "SMS" | "MMS";
		readonly body?: string | undefined;
		readonly mediaCount?: number | undefined;
		readonly complianceKeyword?: string | undefined;
		readonly carrierMessageId?: string | undefined;
		readonly receivedAt: Date;
	}): Promise<boolean> {
		return await this.publish("message.received", input.organizationId, input.conversationId, {
			messageId: input.messageId,
			messagingNumberId: input.messagingNumberId,
			fromE164: input.fromE164,
			toE164: input.toE164,
			kind: input.kind,
			// Capped rather than omitted: a truncated body still tells a screen-pop who is asking about
			// what, and the full text is one authenticated read away. See the header.
			...(input.body === undefined ? {} : { body: input.body.slice(0, 4_096) }),
			...(input.mediaCount === undefined ? {} : { mediaCount: input.mediaCount }),
			...(input.complianceKeyword === undefined
				? {}
				: { complianceKeyword: input.complianceKeyword }),
			...(input.carrierMessageId === undefined ? {} : { carrierMessageId: input.carrierMessageId }),
			receivedAt: input.receivedAt.toISOString(),
		});
	}

	/**
	 * A delivery receipt landed. Carries `failed` as well as `sent`/`delivered` — one fact with an
	 * outcome, branched on in the payload rather than split across two subjects.
	 */
	async publishDelivered(input: {
		readonly organizationId: string;
		readonly conversationId: string;
		readonly messageId: string;
		readonly messagingNumberId: string;
		readonly fromE164: string;
		readonly toE164: string;
		readonly status: "sent" | "delivered" | "failed";
		readonly segments?: number | undefined;
		readonly errorReason?: string | undefined;
		readonly occurredAt: Date;
		readonly carrierMessageId?: string | undefined;
	}): Promise<boolean> {
		return await this.publish("message.delivered", input.organizationId, input.conversationId, {
			messageId: input.messageId,
			messagingNumberId: input.messagingNumberId,
			fromE164: input.fromE164,
			toE164: input.toE164,
			status: input.status,
			...(input.segments === undefined ? {} : { segments: input.segments }),
			...(input.errorReason === undefined ? {} : { errorReason: input.errorReason.slice(0, 512) }),
			...(input.carrierMessageId === undefined ? {} : { carrierMessageId: input.carrierMessageId }),
			occurredAt: input.occurredAt.toISOString(),
		});
	}

	private async publish(
		type: "message.received" | "message.delivered",
		organizationId: string,
		conversationId: string,
		data: Record<string, unknown>,
	): Promise<boolean> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return false;
		}
		try {
			// The `schemas` subpath rather than the package root, for the reason
			// `voicemail-mwi.publisher.ts` records: `apps/api`'s tooling tsconfig still relaxes
			// `strictNullChecks` for its legacy files, and `validate.ts` needs it to narrow a union.
			const { makeMessagingEvent } = await import("@optimiq-voice/events/schemas");
			const envelope = makeMessagingEvent(type, {
				orgId: organizationId,
				conversationId,
				source: "api",
				data: data as never,
			});
			await connection
				.jetstream()
				.publish(envelope.subject, new TextEncoder().encode(JSON.stringify(envelope)), {
					// The dedupe key. The stream's duplicate window turns a republish after a broker
					// hiccup into a no-op rather than a second webhook to the tenant's endpoint.
					msgID: envelope.id,
				});
			this.published += 1;
			messagingEventsPublished.inc({ type });
			return true;
		} catch (error) {
			this.failed += 1;
			logger.error({ type, conversationId, err: error }, "failed to publish a messaging event");
			return false;
		}
	}
}
