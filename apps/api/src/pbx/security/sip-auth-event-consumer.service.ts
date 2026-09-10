import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import { SipAuthEventService } from "./sip-auth-event.service";
import type { PbxEnv } from "../shared/pbx-env";

const logger = getLogger("api.pbx.security");

/** The durable this consumer binds to. Named, so a redeploy resumes rather than replays. */
const DURABLE = "pbx-sip-auth-event-writer";

/**
 * The one filter this consumer wants: `auth-failed`, every AOR, every org.
 *
 * Hand-counted rather than built, on the `trunk.evt.v1.*.*.status.changed` precedent: the concrete
 * subject is `sip.reg.v1.<orgId>.<aorHash>.auth-failed` and the two `*`s here cover exactly the org
 * and AOR tokens. A `>` would also deliver `registered`, `unregistered` and `expired`, which this
 * writer has no columns for and which arrive at registration volume — every handset in every tenant
 * refreshing its binding, filed into the attack log.
 */
const FILTER_SUBJECT = "sip.reg.v1.*.*.auth-failed";

/** What one delivery did, for the spec's benefit and the counters'. */
export type SipAuthEventOutcome = "recorded" | "terminated" | "skipped" | "failed";

/** The broker message shape this consumer acts on — a seam the spec can hand a fake through. */
export interface SipAuthEventMessage {
	readonly subject: string;
	readonly data: Uint8Array;
	ack(): void;
	nak(millis?: number): void;
	term(): void;
}

/**
 * Files the registrar's `sip.reg.v1.….auth-failed` events into `sip_auth_event`.
 *
 * ## Why the registrar is the only possible writer
 *
 * `registration-events.ts` states it: the registrar is the ONLY process that sees a digest, so
 * `bad-credentials` has no other writer — the credential API answers with an ha1 and never learns
 * whether the device computed the right response from it. `apps/api` can file `unknown-account`
 * from its own lookup, and everything past that point happens inside `apps/sipd`. This consumer is
 * the return path for it.
 *
 * ## Both reasons file as `bad-credentials`
 *
 * `SIP_AUTH_EVENT_TYPES` is not an open vocabulary — its header pins the names to Asterisk's
 * Security Events framework so `res_pjsip`'s `InvalidPassword` and the shipper that reads it need
 * no translation table. Adding a `stale-nonce` type for one of two reasons a digest can fail would
 * break that alignment for a distinction that is not about WHAT was refused: in both cases the
 * credential offered did not authenticate. `detail.reason` keeps the difference, which is where a
 * "captured nonce being replayed" query can find it without a column that only one writer fills.
 *
 * ## No rate limiter here, deliberately
 *
 * `apps/sipd` already bounds its publishes to one per source+account per minute, so the stream is
 * pre-thinned; a second limiter here would silently drop events that survived the first one and
 * make the table disagree with the stream for no gain. Do not add one.
 */
@Injectable()
export class SipAuthEventConsumer implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private running = false;
	private stopped = false;
	private recorded = 0;
	private terminated = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		private readonly events: SipAuthEventService,
	) {}

	get stats(): {
		readonly running: boolean;
		readonly recorded: number;
		readonly terminated: number;
		readonly failed: number;
	} {
		return {
			running: this.running,
			recorded: this.recorded,
			terminated: this.terminated,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — refused REGISTERs will not reach the attack log. The registrar " +
					"still refuses them and still logs them; the ledger simply has no rows for the " +
					"registration surface until a broker is configured.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-sip-auth-event",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			// Fire-and-forget: the consume loop is long-lived and awaiting it here would never return.
			void this.run();
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not connect the sip auth event consumer");
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
	 * `DeliverPolicy.New`, and NOT `All` as the trunk status writer uses. A status column has
	 * something to catch up on — the row says "unknown" until a transition is applied, so replaying
	 * one is how it becomes true. This table is a LEDGER of when things were SEEN. Replaying a day
	 * of refused REGISTERs on every first boot would write the same attack a second time, and an
	 * append-only table has no way to un-write it; an operator counting attempts per address would
	 * be counting deployments.
	 */
	private async run(): Promise<void> {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}
		const { ensureStreams, REGISTRATIONS_STREAM } = await import("@optimiq-voice/events/streams");

		try {
			const manager = await connection.jetstreamManager();
			await ensureStreams(manager, [REGISTRATIONS_STREAM]);
			await manager.consumers.add(REGISTRATIONS_STREAM.name, {
				durable_name: DURABLE,
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.New,
				filter_subject: FILTER_SUBJECT,
				max_deliver: 10,
			});
		} catch (error) {
			// `consumers.add` on an existing durable with identical config is a no-op; anything else
			// here means the consumer cannot run, and saying so once is better than a silent loop.
			if (!/consumer already exists/iu.test(String(error))) {
				logger.error({ err: error }, "could not create the sip auth event durable consumer");
			}
		}

		try {
			const consumer = await connection
				.jetstream()
				.consumers.get(REGISTRATIONS_STREAM.name, DURABLE);
			const messages = await consumer.consume();
			this.running = true;
			logger.info({ durable: DURABLE }, "sip auth event consumer running");
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				await this.dispatch(message);
			}
		} catch (error) {
			if (!this.stopped) {
				this.failed += 1;
				logger.error({ err: error }, "the sip auth event consumer stopped");
			}
		}
		this.running = false;
	}

	/**
	 * Handles one delivery. Public so the spec can drive it with a fake message — the run loop is
	 * the only other caller.
	 */
	async dispatch(message: SipAuthEventMessage): Promise<SipAuthEventOutcome> {
		// The schemas subpath rather than the package root, for the reason `trunk-status-consumer`
		// records: `apps/api`'s tooling tsconfig still relaxes `strictNullChecks` for its legacy
		// files, and the package root drags `validate.ts` into this app's compilation.
		const { registrationEventSchema } = await import("@optimiq-voice/events/schemas");

		let envelope: RegistrationEnvelope;
		try {
			envelope = registrationEventSchema.parse(
				JSON.parse(new TextDecoder().decode(message.data)),
			) as unknown as RegistrationEnvelope;
		} catch (error) {
			// Bytes that are not this contract will never become this contract. Terminating is the
			// only way not to block every later refusal behind them.
			logger.error(
				{ subject: message.subject, error },
				"terminating a registration event that is not readable as one",
			);
			message.term();
			this.terminated += 1;
			return "terminated";
		}

		if (envelope.type !== "auth-failed") {
			message.ack();
			return "skipped";
		}
		if (envelope.subject !== message.subject) {
			// The tenancy cross-check: an envelope whose own subject disagrees with the one it was
			// delivered on could file another tenant's attack under this one.
			logger.error(
				{ subject: message.subject, envelopeSubject: envelope.subject },
				"terminating a registration event delivered on a foreign subject",
			);
			message.term();
			this.terminated += 1;
			return "terminated";
		}
		// `sip.reg.v1.<orgId>.<aorHash>.<event>` — the tenant is the address, not the payload.
		// `orgId` is checked against the subject the broker routed on before it scopes a write; the
		// producer's `validateEvent` makes the same comparison, and this is the consume-side half.
		const [, , , subjectOrgId] = message.subject.split(".");
		if (subjectOrgId === undefined) {
			message.term();
			this.terminated += 1;
			return "terminated";
		}
		if (subjectOrgId !== envelope.orgId) {
			logger.error(
				{ subject: message.subject, envelopeOrgId: envelope.orgId },
				"terminating a registration event whose orgId disagrees with its subject",
			);
			message.term();
			this.terminated += 1;
			return "terminated";
		}

		try {
			await this.events.record({
				organizationId: subjectOrgId,
				// Both reasons: the credential offered did not authenticate either way. See the class
				// header for why `stale-nonce` does not get a type of its own.
				eventType: "bad-credentials",
				scope: "registration",
				sourceIp: hostOf(envelope.data.sourceAddress),
				accountRef: envelope.data.username,
				transport: envelope.data.transport,
				userAgent: envelope.data.userAgent,
				detail: { reason: envelope.data.reason, aor: envelope.data.aor },
			});
			this.recorded += 1;
			message.ack();
			return "recorded";
		} catch (error) {
			// `SipAuthEventService.record` swallows its own database failures by design, so reaching
			// here means something else broke. NAK rather than drop: a refusal is worth a retry.
			this.failed += 1;
			logger.error(
				{ subject: message.subject, error },
				"failed to file a refused REGISTER; it will be redelivered",
			);
			message.nak(5_000);
			return "failed";
		}
	}
}

/**
 * The host half of a `host:port` signalling source.
 *
 * The column is `inet`, so the port has to come off. IPv6 arrives bracketed (`[::1]:5060`) because
 * the colon is otherwise ambiguous; anything that is neither shape returns `undefined` rather than
 * a guess, and `SipAuthEventService` NULLs an unparseable value anyway — this only makes sure it is
 * never handed a plausible-looking wrong answer.
 */
export function hostOf(sourceAddress: string | undefined): string | undefined {
	if (sourceAddress === undefined || sourceAddress === "") {
		return undefined;
	}
	if (sourceAddress.startsWith("[")) {
		const close = sourceAddress.indexOf("]");
		return close > 1 ? sourceAddress.slice(1, close) : undefined;
	}
	const colon = sourceAddress.indexOf(":");
	if (colon === -1) {
		return sourceAddress;
	}
	// A bare IPv6 address with no brackets has several colons and no port; splitting on the first
	// would produce a fragment, so it is handed over whole and validated downstream.
	return sourceAddress.indexOf(":", colon + 1) === -1
		? sourceAddress.slice(0, colon)
		: sourceAddress;
}

/**
 * The envelope this consumer acts on.
 *
 * Declared structurally rather than imported as `RegistrationEventEnvelope`, for the same
 * `strictNullChecks` reason as the dynamic import above: naming the inferred union type here drags
 * the package root's `validate.ts` into this app's compilation.
 */
interface RegistrationEnvelope {
	readonly type: string;
	readonly orgId: string;
	readonly subject: string;
	readonly at: string;
	readonly data: {
		readonly aor: string;
		readonly aorHash: string;
		readonly transport: string;
		readonly sourceAddress?: string;
		readonly userAgent?: string;
		readonly username: string;
		readonly reason: "bad-credentials" | "stale-nonce";
	};
}
