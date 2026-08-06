import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type NatsConnection } from "nats";
import { makeProvisionEvent } from "@optimiq-voice/events/schemas";
import { ensureStreams, PROVISION_STREAM } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logger";
import { PBX_ENV } from "../../pbx/shared/pbx.tokens";
import type { PbxEnv } from "../../pbx/shared/pbx-env";
import type { ProvisionEvent, ProvisionEventDataOf } from "@optimiq-voice/events/schemas";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * `provision.evt.v1.<orgId>` — the security record of every configuration request.
 *
 * ## Why this exists at all
 *
 * The render endpoint answers every refusal with the same opaque 404 (see `provision.errors.ts`),
 * which is correct and leaves nobody able to see what happened. This is the other half of that
 * decision: the reason goes somewhere an administrator and an anti-fraud consumer can read and the
 * requester cannot. Without it, "why is this phone not provisioning?" has no answer, and "somebody
 * is walking our token space" has no signal.
 *
 * `packages/events` says the same thing from the schema's side: "`device.rejected` is the
 * security-relevant one … every rejected attempt is published so anti-fraud can count them."
 *
 * ## What cannot be published, and why that is not a gap
 *
 * The subject is `provision.evt.v1.<orgId>`, so an event needs an organization. A request whose
 * token reference resolves to nothing has no organization — by construction, since the reference IS
 * the tenant resolution — and therefore cannot be published to any tenant's stream. Publishing it
 * to a synthetic "unknown" subject would create a stream every tenant's consumer would have to be
 * told to ignore, and would put unauthenticated attacker-controlled input into the tenant subject
 * space. Those attempts are logged instead, at `warn`, which is where a platform operator watches
 * for enumeration; per-tenant events start at the moment a tenant is known.
 *
 * ## Fire and forget, and it observes its own failure
 *
 * A phone's configuration must not fail to be delivered because a broker is draining. Every publish
 * is awaited inside a `try` and its failure is counted and logged — a bare `void` promise turns
 * NATS's `CONNECTION_DRAINING` at shutdown into an unhandled rejection that kills the process,
 * which is the failure mode `agent-state.publisher.ts` records and this file inherits.
 */
@Injectable()
export class ProvisionEventPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private published = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get isReady(): boolean {
		return this.connection !== undefined && !this.connection.isClosed();
	}

	get stats(): { readonly published: number; readonly failed: number } {
		return { published: this.published, failed: this.failed };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — device provisioning attempts will be logged but not published " +
					"to provision.evt.v1. Configuration delivery is unaffected; the security audit trail " +
					"for it is not available to consumers.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				name: "optimiq-api-provision-events",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				const manager: JetStreamManager = await this.connection.jetstreamManager();
				// A publish to a subject no stream captures is ACCEPTED by the server and silently
				// dropped, which for an audit trail is the one failure mode indistinguishable from
				// "nothing happened".
				await ensureStreams(manager, [PROVISION_STREAM]);
			}
			logger.info("provision event stream ready", { stream: PROVISION_STREAM.name });
		} catch (error) {
			this.failed += 1;
			logger.error("could not prepare the provision event stream", error);
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
	 * Publishes one provisioning event.
	 *
	 * Returns whether it reached the broker so the verification harness can assert the publish
	 * without subscribing, and so the render path can log the difference between "no broker" and
	 * "broker refused".
	 */
	async publish<TType extends ProvisionEvent>(
		type: TType,
		organizationId: string,
		data: ProvisionEventDataOf<TType>,
	): Promise<boolean> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return false;
		}
		try {
			const event = makeProvisionEvent(type, {
				orgId: organizationId,
				source: "api",
				data,
			} as never);
			await connection
				.jetstream()
				.publish(event.subject, new TextEncoder().encode(JSON.stringify(event)), {
					// The envelope id is the idempotency key consumers dedupe on, and JetStream's own
					// duplicate window uses it, so a retried publish files one attempt rather than two.
					msgID: event.id,
				});
			this.published += 1;
			return true;
		} catch (error) {
			this.failed += 1;
			logger.error("provision event publish failed", { type, organizationId, error });
			return false;
		}
	}
}
