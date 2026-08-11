import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { and, eq, sql, webhookSubscription } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import { deliverWebhook, type WebhookFetch } from "./webhook-delivery";
import { isWebhookFamily, selectorsMatch, WEBHOOK_FAMILY_ROOTS } from "./webhook-selectors";
import type { PbxEnv } from "../shared/pbx-env";
import type { WebhookFamily } from "./webhook-selectors";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.webhooks");

/**
 * One durable per STREAM, all feeding one delivery queue.
 *
 * A JetStream consumer belongs to exactly one stream, so "one consumer for the API" is not
 * expressible across four families that live on four streams — what IS expressible, and what this
 * is, is one consumer per stream rather than one per subscription. The distinction matters: the
 * thing to avoid is a broker-side consumer whose lifetime is a tenant's configuration row, which
 * would put subscription CRUD in the path of JetStream asset management and leave orphaned durables
 * behind every delete. Here the broker sees four durables on a running deployment and four on an
 * idle one, whatever the tenants do.
 *
 * The filters are the family roots, so the consumers deliver every tenant's events and the
 * per-tenant decision is made in this process, where the subscription rows are. That is the only
 * arrangement that can enforce isolation server-side — see {@link WebhookDispatcher.dispatch}.
 */
const WEBHOOK_CONSUMERS: readonly {
	readonly family: WebhookFamily;
	readonly stream: string;
	readonly durable: string;
	readonly filter: string;
}[] = [
	{
		family: "call",
		stream: "CALLS",
		durable: "pbx-webhook-calls",
		filter: `${WEBHOOK_FAMILY_ROOTS.call}.>`,
	},
	{
		family: "queue",
		stream: "QUEUES",
		durable: "pbx-webhook-queues",
		filter: `${WEBHOOK_FAMILY_ROOTS.queue}.>`,
	},
	{
		family: "voicemail",
		stream: "VOICEMAIL",
		durable: "pbx-webhook-voicemail",
		filter: `${WEBHOOK_FAMILY_ROOTS.voicemail}.>`,
	},
	{
		family: "cdr",
		stream: "CDR",
		durable: "pbx-webhook-cdr",
		filter: `${WEBHOOK_FAMILY_ROOTS.cdr}.*`,
	},
];

/**
 * How many times JetStream re-offers a message this dispatcher NAKed.
 *
 * Low, and lower than the CDR writer's, because the thing that NAKs here is not a database refusing
 * a row — it is this process being unable to even look up who wants the message. Three attempts is
 * enough to ride out a connection-pool blip; beyond that the message is dropped rather than held,
 * because a webhook is a notification and a notification nobody can deliver for a minute has already
 * lost most of its value.
 */
const MAX_DELIVER = 3;

/** One tenant's subscriptions, as the dispatcher holds them. */
interface CachedSubscription {
	readonly id: string;
	readonly url: string;
	readonly secret: string;
	readonly eventSelectors: readonly string[];
}

interface CacheEntry {
	readonly subscriptions: readonly CachedSubscription[];
	readonly readAt: number;
}

/**
 * Delivers this platform's events to the endpoints tenants have subscribed.
 *
 * ## Tenant isolation, and why the selector alone is never trusted
 *
 * Three things have to be true for a delivery to happen, and they are checked in this order:
 *
 * 1. The delivered SUBJECT names an organization — `parseSubject` extracts it, and a subject the
 *    taxonomy does not recognise is acked and dropped rather than guessed at.
 * 2. The subscriptions considered are the ones read under `withTenantScope(organizationId)`, so RLS
 *    has already proved every row belongs to that tenant before a URL is looked at.
 * 3. The selector decides only WHAT, never WHOSE — the grammar in `webhook-selectors.ts` cannot
 *    express an organization token at all.
 *
 * The middle step is the one doing the work. Even a subscription row that somehow named another
 * tenant's events could not receive them, because the query that found it was scoped to the
 * organization the SUBJECT named. There is no code path on which a selector reaches outside its own
 * tenant, because there is no code path on which a selector chooses the tenant.
 *
 * ## Back-pressure: the consumer never waits on an endpoint
 *
 * The consume loop is `for await (…)`, strictly sequential, and awaiting a POST inside it would put
 * a stranger's latency in front of every later event — the exact failure the transcription worker's
 * header describes, with a worse blast radius because this loop carries four families. So a message
 * is admitted to a bounded in-flight set and handled OFF the loop; the loop waits only when every
 * slot is taken, which applies back-pressure by not pulling rather than by dropping.
 *
 * ## At-least-once, and why nothing is NAKed for a failed POST
 *
 * A message is acked when its fan-out has SETTLED — every matching subscription either delivered or
 * given up — rather than when it is admitted. A crash in between therefore redelivers, which is the
 * at-least-once guarantee.
 *
 * What is deliberately NOT done is NAKing because one endpoint failed. A redelivery is a redelivery
 * of the MESSAGE, so it would re-POST to every subscription including the ones that already
 * succeeded — turning one broken endpoint into duplicate deliveries for everybody else's. The retry
 * that belongs to one endpoint is the bounded per-attempt loop in `webhook-delivery.ts`, and the
 * longer-lived signal is the consecutive-failure counter on the row.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inFlight = new Set<Promise<void>>();
	private waiters: (() => void)[] = [];
	private stopped = false;
	private running = 0;
	private delivered = 0;
	private failed = 0;
	private matched = 0;
	private skipped = 0;
	private disabled = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		/**
		 * The transport. Injected rather than closed over so a spec drives every delivery path without
		 * a socket, and so a deployment that needs a proxy has one seam to change.
		 */
		private readonly fetchImpl: WebhookFetch = globalThis.fetch as unknown as WebhookFetch,
	) {}

	get stats(): {
		readonly running: number;
		readonly inFlight: number;
		readonly matched: number;
		readonly delivered: number;
		readonly failed: number;
		readonly skipped: number;
		readonly disabled: number;
	} {
		return {
			running: this.running,
			inFlight: this.inFlight.size,
			matched: this.matched,
			delivered: this.delivered,
			failed: this.failed,
			skipped: this.skipped,
			disabled: this.disabled,
		};
	}

	async onModuleInit(): Promise<void> {
		if (!this.env.PBX_WEBHOOKS_ENABLED) {
			logger.info("webhook delivery is disabled by PBX_WEBHOOKS_ENABLED");
			return;
		}
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — no webhook will be delivered. Subscriptions can still be " +
					"managed; deliveries begin when a broker is configured and the durables catch up.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-webhooks",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			for (const spec of WEBHOOK_CONSUMERS) {
				// Fire-and-forget: each loop is long-lived, and awaiting one would never return.
				void this.run(spec);
			}
		} catch (error) {
			logger.error({ err: error }, "could not connect the webhook dispatcher");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		// The in-flight deliveries are awaited rather than abandoned, bounded by their own timeout:
		// each one is at most `PBX_WEBHOOK_TIMEOUT_MS` from finishing, and dropping them would mean a
		// deploy silently loses whatever was mid-POST. Their messages are unacked either way, so the
		// worst case on the other side of a lost race is one duplicate delivery.
		await Promise.allSettled(this.inFlight);
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/** Forgets a tenant's cached subscriptions. The seam a spec and a future CRUD hook both use. */
	invalidate(organizationId?: string): void {
		if (organizationId === undefined) {
			this.cache.clear();
			return;
		}
		this.cache.delete(organizationId);
	}

	// -------------------------------------------------------------------------------------------

	private async run(spec: (typeof WEBHOOK_CONSUMERS)[number]): Promise<void> {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}
		try {
			const manager = await connection.jetstreamManager();
			await manager.consumers.add(spec.stream, {
				durable_name: spec.durable,
				ack_policy: AckPolicy.Explicit,
				/**
				 * `DeliverPolicy.New`, and this is the ONE durable in the API that does not start at the
				 * beginning of its stream.
				 *
				 * Every other consumer here files a row — a CDR leg, a voicemail — and replaying the
				 * backlog is how a fresh deployment rebuilds state it is missing. A webhook is a
				 * NOTIFICATION, and replaying seventy-two hours of call events into a CRM the first time
				 * somebody adds a subscription would deliver thousands of screen-pops for calls that
				 * ended days ago. Nobody wants the backlog; they want what happens next.
				 */
				deliver_policy: DeliverPolicy.New,
				filter_subject: spec.filter,
				max_deliver: MAX_DELIVER,
			});
		} catch (error) {
			if (!/consumer already exists/iu.test(String(error))) {
				logger.error(
					{ err: error, stream: spec.stream, durable: spec.durable },
					"could not create a webhook durable consumer",
				);
			}
		}

		try {
			const consumer = await connection.jetstream().consumers.get(spec.stream, spec.durable);
			const messages = await consumer.consume();
			this.running += 1;
			logger.info(
				{ durable: spec.durable, stream: spec.stream, family: spec.family },
				"webhook dispatcher running",
			);
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				// The back-pressure point. Nothing is pulled while every slot is full, so a slow
				// endpoint slows the FLOW rather than stalling one loop behind another's latency.
				await this.awaitSlot();
				if (this.stopped) {
					break;
				}
				this.spawn(message as unknown as DispatchMessage, spec.family);
			}
		} catch (error) {
			if (!this.stopped) {
				logger.error(
					{ err: error, stream: spec.stream, durable: spec.durable },
					"a webhook dispatcher loop stopped",
				);
			}
		}
		this.running = Math.max(0, this.running - 1);
	}

	private async awaitSlot(): Promise<void> {
		while (this.inFlight.size >= this.env.PBX_WEBHOOK_CONCURRENCY && !this.stopped) {
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
			});
		}
	}

	private releaseSlot(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) {
			waiter();
		}
	}

	private spawn(message: DispatchMessage, family: WebhookFamily): void {
		const task = this.dispatch(message, family)
			.catch((error: unknown) => {
				// `handle` owns its failures; this is the defect path. The message is left unacked so a
				// redelivery gets another chance rather than the event being lost to a bug.
				logger.error({ err: error, subject: message.subject }, "a webhook dispatch threw");
			})
			.finally(() => {
				this.inFlight.delete(task);
				this.releaseSlot();
			});
		this.inFlight.add(task);
	}

	/**
	 * Fans one message out to the tenant's matching subscriptions, then acks. Never throws.
	 *
	 * Public and awaitable because it is the unit worth testing — the tenant resolution, the selector
	 * match and the ack/term/nak decision are the whole behaviour of this class, and every one of
	 * them is provable with a fake message and a fake database. `spawn` is the fire-and-forget wrapper
	 * the consume loop uses; the same split `VoicemailTranscriptionService.transcribeNow` makes.
	 */
	async dispatch(message: DispatchMessage, family: WebhookFamily): Promise<void> {
		const { parseSubject } = await import("@optimiq-voice/events/subjects");

		const parsed = parseSubject(message.subject);
		if (parsed === undefined || parsed.kind === "rpc" || !isWebhookFamily(parsed.family)) {
			// A subject outside the taxonomy, or one from a family webhooks do not serve. Terminated
			// rather than NAKed: it will be exactly as unrecognisable on every redelivery.
			this.skipped += 1;
			message.term();
			return;
		}
		if (parsed.family !== family) {
			// The filter and the parse disagree, which means one of them is wrong. Log it once with
			// both and drop the message rather than delivering under a family the tenant did not pick.
			logger.error(
				{ subject: message.subject, filtered: family, parsed: parsed.family },
				"a webhook consumer received a subject from another family",
			);
			this.skipped += 1;
			message.term();
			return;
		}

		let envelope: { readonly type?: unknown; readonly subject?: unknown };
		let body: string;
		try {
			body = new TextDecoder().decode(message.data);
			envelope = JSON.parse(body) as { type?: unknown; subject?: unknown };
		} catch (error) {
			logger.warn({ subject: message.subject, err: error }, "an undeliverable webhook payload");
			this.skipped += 1;
			message.term();
			return;
		}
		const type = typeof envelope.type === "string" ? envelope.type : undefined;
		if (type === undefined) {
			this.skipped += 1;
			message.term();
			return;
		}
		/**
		 * The envelope's own `subject` has to agree with the one it was delivered on.
		 *
		 * The same cross-check the CDR writer makes, and here it is the tenancy one: the organization
		 * used for the lookup comes from the delivered subject, and an envelope claiming a different
		 * subject is either a producer bug or the only shape a cross-tenant delivery could take.
		 */
		if (typeof envelope.subject === "string" && envelope.subject !== message.subject) {
			logger.error(
				{ subject: message.subject, envelopeSubject: envelope.subject },
				"a webhook payload's envelope subject disagrees with its delivery subject",
			);
			this.skipped += 1;
			message.term();
			return;
		}

		const organizationId = parsed.orgId;
		let subscriptions: readonly CachedSubscription[];
		try {
			subscriptions = await this.subscriptionsFor(organizationId);
		} catch (error) {
			// The database is the only thing that can fail here, and it is transient-shaped. NAKed so
			// the message comes back rather than being dropped because a pool was briefly exhausted.
			logger.warn({ organizationId, err: error }, "could not read webhook subscriptions");
			message.nak(1_000);
			return;
		}

		const targets = subscriptions.filter((subscription) =>
			selectorsMatch(subscription.eventSelectors, parsed.family, type),
		);
		if (targets.length === 0) {
			message.ack();
			return;
		}
		this.matched += targets.length;

		// Concurrent across SUBSCRIPTIONS and settled together: one tenant with a slow endpoint and a
		// fast one should not have the fast one wait, and the ack belongs to the message rather than
		// to any single delivery. The whole fan-out already occupies one in-flight slot.
		await Promise.all(
			targets.map(async (target) => await this.deliverTo(organizationId, target, type, body)),
		);
		message.ack();
	}

	private async deliverTo(
		organizationId: string,
		target: CachedSubscription,
		type: string,
		body: string,
	): Promise<void> {
		const outcome = await deliverWebhook(
			this.fetchImpl,
			{ subscriptionId: target.id, url: target.url, secret: target.secret },
			type,
			body,
			{
				timeoutMs: this.env.PBX_WEBHOOK_TIMEOUT_MS,
				maxAttempts: this.env.PBX_WEBHOOK_MAX_ATTEMPTS,
				retryBaseMs: this.env.PBX_WEBHOOK_RETRY_BASE_MS,
				maxBackoffMs: this.env.PBX_WEBHOOK_MAX_BACKOFF_MS,
			},
		);

		if (outcome.kind === "delivered") {
			this.delivered += 1;
			await this.recordSuccess(organizationId, target.id);
			return;
		}
		this.failed += 1;
		logger.warn(
			{
				organizationId,
				subscriptionId: target.id,
				eventType: type,
				attempts: outcome.attempts,
				reason: outcome.reason,
			},
			"a webhook delivery failed",
		);
		await this.recordFailure(organizationId, target.id, outcome.reason);
	}

	/**
	 * Zeroes the counter. Cheap enough to run on every success rather than only after a failure: the
	 * alternative is holding a per-subscription "was it failing" flag in memory that two API replicas
	 * would disagree about.
	 */
	private async recordSuccess(organizationId: string, subscriptionId: string): Promise<void> {
		try {
			await this.database.withTenantScope(organizationId, async (transaction) => {
				await transaction
					.update(webhookSubscription)
					.set({
						consecutiveFailures: 0,
						lastSuccessAt: new Date(),
						lastFailureReason: null,
					})
					.where(eq(webhookSubscription.id, subscriptionId));
			});
		} catch (error) {
			// Bookkeeping, downstream of a delivery that already happened. Logged and dropped: failing
			// here must not turn a successful delivery into a retry.
			logger.warn(
				{ organizationId, subscriptionId, err: error },
				"could not record a webhook success",
			);
		}
	}

	/**
	 * Increments the counter and, at the ceiling, switches the subscription off.
	 *
	 * Done in ONE statement so two replicas failing the same endpoint cannot both read `19` and both
	 * write `20`: the increment is `consecutive_failures + 1` in SQL, and the disable decision is a
	 * `CASE` over the incremented value rather than over anything this process read earlier.
	 */
	private async recordFailure(
		organizationId: string,
		subscriptionId: string,
		reason: string,
	): Promise<void> {
		const limit = this.env.PBX_WEBHOOK_FAILURE_LIMIT;
		try {
			const disabled = await this.database.withTenantScope(organizationId, async (transaction) => {
				const rows = await transaction
					.update(webhookSubscription)
					.set({
						consecutiveFailures: sql`${webhookSubscription.consecutiveFailures} + 1`,
						lastFailureAt: new Date(),
						lastFailureReason: reason.slice(0, 256),
						...(limit > 0
							? {
									enabled: sql`case when ${webhookSubscription.consecutiveFailures} + 1 >= ${limit} then false else ${webhookSubscription.enabled} end`,
									autoDisabledAt: sql`case when ${webhookSubscription.consecutiveFailures} + 1 >= ${limit} then now() else ${webhookSubscription.autoDisabledAt} end`,
								}
							: {}),
					})
					.where(eq(webhookSubscription.id, subscriptionId))
					.returning({ enabled: webhookSubscription.enabled });
				return rows[0]?.enabled === false;
			});
			if (disabled) {
				this.disabled += 1;
				this.invalidate(organizationId);
				logger.error(
					{ organizationId, subscriptionId, failureLimit: limit, reason },
					"a webhook subscription was disabled after consecutive failures; re-enable it once " +
						"the endpoint is fixed",
				);
			}
		} catch (error) {
			logger.warn(
				{ organizationId, subscriptionId, err: error },
				"could not record a webhook failure",
			);
		}
	}

	/**
	 * A tenant's live subscriptions, cached for `PBX_WEBHOOK_CACHE_TTL_MS`.
	 *
	 * The cache is per organization rather than global so a busy tenant's refresh does not re-read
	 * every other tenant's rows, and the entry is kept even when it is EMPTY — the common case is a
	 * tenant with no webhooks at all, and caching "none" is what stops every call event in the
	 * platform from becoming a database round trip.
	 */
	private async subscriptionsFor(organizationId: string): Promise<readonly CachedSubscription[]> {
		const cached = this.cache.get(organizationId);
		const now = Date.now();
		if (cached !== undefined && now - cached.readAt < this.env.PBX_WEBHOOK_CACHE_TTL_MS) {
			return cached.subscriptions;
		}
		const rows = await this.database.withTenantScope(organizationId, async (transaction) => {
			return await transaction
				.select({
					id: webhookSubscription.id,
					url: webhookSubscription.url,
					secret: webhookSubscription.secret,
					eventSelectors: webhookSubscription.eventSelectors,
				})
				.from(webhookSubscription)
				.where(
					and(
						eq(webhookSubscription.organizationId, organizationId),
						eq(webhookSubscription.enabled, true),
					),
				)
				.limit(200);
		});
		const subscriptions = rows.map((row) => ({
			id: row.id,
			url: row.url,
			secret: row.secret,
			eventSelectors: Array.isArray(row.eventSelectors) ? row.eventSelectors : [],
		}));
		this.cache.set(organizationId, { subscriptions, readAt: now });
		return subscriptions;
	}
}

/**
 * The message surface this dispatcher touches.
 *
 * Declared structurally rather than as `JsMsg`, for the reason the CDR writer's `DurableMessage`
 * records: naming the library's types drags declarations through this app's partially-relaxed
 * `strictNullChecks` in ways that are noise rather than signal.
 */
export interface DispatchMessage {
	readonly subject: string;
	readonly data: Uint8Array;
	ack(): void;
	nak(millis?: number): void;
	term(): void;
}
