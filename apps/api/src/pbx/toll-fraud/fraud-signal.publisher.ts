import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type NatsConnection } from "nats";
// Subpath imports for the same reason `sip-acl.publisher.ts` uses them: `apps/api`'s tooling
// tsconfig still relaxes `strictNullChecks` for its legacy files.
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { makeSecurityEvent } from "@optimiq-voice/events/schemas";
import { ensureStreams, SECURITY_STREAM } from "@optimiq-voice/events/streams";
import { SECURITY_SCOPE_ORG } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { SecurityFraudSignalData } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * Publishes `security.evt.v1.<orgId>.<subjectRef>.fraud-signal` — the toll-fraud alert.
 *
 * ## Fire-and-forget, and why that is right here and wrong for the audit row
 *
 * Every caller writes an audit row inside the transaction that made the decision, and then calls
 * this OUTSIDE it. The two are deliberately different in durability, because they are different
 * claims: the audit row is the record that the platform refused a call, and it must be as durable as
 * the refusal itself or the ledger has a hole in it. This is a NOTIFICATION, and a notification that
 * could fail a caller's dial because the broker was slow would be a control that takes the phone
 * system down when the message bus wobbles — which is a strictly worse failure than a missed alert.
 *
 * So a publish that throws is logged and counted and nothing else. The durable record is already
 * written; the tenant's endpoint misses one message and the audit log still answers the question.
 *
 * ## The stream is ensured here, not assumed
 *
 * `SECURITY` is a new stream, so a deployment that upgraded the control plane before anything
 * provisioned the backbone would otherwise publish into nothing and log a `no responders` per
 * signal. Guarded by the same `PBX_ENSURE_STREAMS` flag the other publishers use, so a deployment
 * that manages its streams declaratively is not fought with.
 */
@Injectable()
export class FraudSignalPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private published = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get stats(): { readonly published: number; readonly failed: number } {
		return { published: this.published, failed: this.failed };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — toll-fraud signals will be written to the audit log but not " +
					"published, so no webhook subscription will receive a fraud alert.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-fraud-signal",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				const manager: JetStreamManager = await this.connection.jetstreamManager();
				await ensureStreams(manager, [SECURITY_STREAM]);
			}
			logger.info({ stream: SECURITY_STREAM.name }, "fraud-signal publisher ready");
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not open the fraud-signal publisher");
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
	 * Publishes one signal. Never throws; see the header.
	 *
	 * The subject's middle token is the extension the signal is about, or {@link SECURITY_SCOPE_ORG}
	 * for a tenant-wide finding — so a consumer watching one extension can filter on the subject
	 * while a wallboard subscribed to `security.evt.v1.<org>.>` sees both scopes.
	 */
	async publish(organizationId: string, data: SecurityFraudSignalData, at?: Date): Promise<void> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return;
		}
		try {
			const event = makeSecurityEvent("fraud-signal", {
				orgId: organizationId,
				subjectRef: data.extensionId ?? SECURITY_SCOPE_ORG,
				source: "api",
				...(at === undefined ? {} : { at }),
				data,
			});
			await connection
				.jetstream()
				.publish(event.subject, new TextEncoder().encode(JSON.stringify(event)), {
					// The envelope id is the idempotency key consumers dedupe on, and JetStream's own
					// duplicate window uses it — so a retried publish raises one alert, not two.
					msgID: event.id,
				});
			this.published += 1;
		} catch (error) {
			this.failed += 1;
			logger.error(
				{ err: error, organizationId, kind: data.kind },
				"a toll-fraud signal could not be published; the audit row was still written",
			);
		}
	}
}
