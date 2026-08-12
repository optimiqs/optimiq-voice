import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type KV, KvWatchInclude, type NatsConnection, type Subscription } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import {
	agentStateEntrySchema,
	callEventSchema,
	liveChannelSchema,
	queueEventSchema,
	registrationBindingSchema,
	trunkEventSchema,
	voicemailEventSchema,
} from "@optimiq-voice/events/schemas";
import {
	AGENT_STATE_KV,
	CHANNELS_KV,
	ensureKvBuckets,
	REGISTRATIONS_KV,
} from "@optimiq-voice/events/streams";
import { subjectFilterFor } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../pbx/shared/pbx.tokens";
import type { PbxEnv } from "../pbx/shared/pbx-env";
import type { LiveSource } from "./live-topics";

const logger = getLogger("api.live");

/**
 * The upstream side of the live channel: one set of NATS watches and subscriptions per
 * organization, opened on the first subscriber and closed on the last.
 *
 * ## Why it is ref-counted per (organization, source) and not per connection
 *
 * A KV watch is a JetStream consumer. A wallboard on a big tenant's operations desk is six browser
 * tabs, and six identical `watch({key: "<org>.*"})` calls are six consumers, six deliveries of
 * every registration refresh and six copies of the same bytes crossing the broker link — for one
 * organization's worth of information. Ref-counting collapses that to one, and makes the cost of
 * the feature O(organizations watching) rather than O(tabs open).
 *
 * Counting per SOURCE rather than per topic is what makes `active-calls` and `queue:<id>` share
 * correctly: both want the `agent-state` bucket for different reasons, and a per-topic count would
 * open it twice.
 *
 * ## Teardown is the property this class exists to guarantee
 *
 * The failure mode a live feature has is not that it stops working, it is that it never stops: a
 * watch nobody reads, held by a connection that closed, for an organization nobody is looking at.
 * So `release` is exact — it decrements, and at zero it stops the iterator and drops the entry —
 * and {@link openSources} is exposed so a verification harness can assert the count returns to
 * zero after the last client disconnects, rather than taking a comment's word for it.
 *
 * ## Everything is validated before it is fanned out
 *
 * A KV value or an event that does not parse is DROPPED with a log line, never forwarded. The
 * browser is the least trusted consumer on this backbone and the one furthest from the schema, and
 * "the wallboard rendered a half-written entry" is not a failure mode worth having in exchange for
 * skipping a `safeParse` on a path that runs at human speed.
 */
@Injectable()
export class LiveHub implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private readonly buckets = new Map<string, KV>();
	private readonly streams = new Map<string, OrgSource>();
	private readonly listeners = new Set<LiveHubListener>();
	private stopped = false;
	private forwarded = 0;
	private dropped = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	/** Whether upstreams can be opened at all. */
	get isReady(): boolean {
		return this.connection !== undefined && !this.connection.isClosed();
	}

	/**
	 * Every (organization, source) currently held open, with its ref count.
	 *
	 * The observable teardown contract. `verify-live.ts` asserts this is empty after the last
	 * subscriber goes away, which is the only way to prove the ref counting is real.
	 */
	get openSources(): readonly { readonly key: string; readonly refs: number }[] {
		return [...this.streams.entries()].map(([key, source]) => ({ key, refs: source.refs }));
	}

	get stats(): { readonly forwarded: number; readonly dropped: number; readonly open: number } {
		return { forwarded: this.forwarded, dropped: this.dropped, open: this.streams.size };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — the live channel will accept connections and never deliver " +
					"anything. Subscribers are told so with an UPSTREAM_UNAVAILABLE frame rather than " +
					"being left watching an empty screen.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-live",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [REGISTRATIONS_KV, CHANNELS_KV, AGENT_STATE_KV]);
			}
			const jetstream = manager.jetstream();
			for (const definition of [REGISTRATIONS_KV, CHANNELS_KV, AGENT_STATE_KV]) {
				this.buckets.set(definition.name, await jetstream.views.kv(definition.name));
			}
			logger.info({ servers: this.env.NATS_URL }, "live hub connected");
		} catch (error) {
			logger.error({ err: error }, "the live hub could not reach the broker");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		for (const [key, source] of this.streams) {
			source.stop();
			this.streams.delete(key);
		}
		this.listeners.clear();
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/** Registers a fan-out sink. The gateway is the only caller; a spec is the other. */
	addListener(listener: LiveHubListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Opens (or joins) the upstreams a topic needs.
	 *
	 * Returns a release function rather than requiring a matching `release` call, so a connection
	 * that closes mid-subscribe cannot leave a count incremented — the caller holds one closure per
	 * acquisition and runs them all on teardown.
	 */
	acquire(organizationId: string, sources: readonly LiveSource[]): () => void {
		const acquired = sources.map((source) => this.acquireOne(organizationId, source));
		let released = false;
		return () => {
			if (released) {
				// Idempotent on purpose: a connection can be torn down by a close event AND by the
				// shutdown sweep, and a double decrement would close a watch other tabs are using.
				return;
			}
			released = true;
			for (const release of acquired) {
				release();
			}
		};
	}

	/**
	 * The current contents of a bucket for one organization, for the `snapshot` frame.
	 *
	 * Read fresh rather than kept in memory: the hub is a router, and caching the buckets here would
	 * make it a second copy of live state whose staleness nobody owns. The read is one key range per
	 * subscribe, which happens when a human opens a page.
	 */
	async snapshot(organizationId: string, source: LiveSource): Promise<readonly LiveKvRow[]> {
		const bucketName = BUCKET_FOR_SOURCE[source];
		if (bucketName === undefined) {
			// A stream source has no snapshot. That is not a gap: a stream says what CHANGED, and
			// there is no "current value" of a change.
			return [];
		}
		const bucket = this.buckets.get(bucketName);
		if (bucket === undefined) {
			return [];
		}
		const values: LiveKvRow[] = [];
		try {
			for await (const key of await bucket.keys(`${organizationId}.>`)) {
				const entry = await bucket.get(key);
				if (entry === null || entry.value.length === 0) {
					continue;
				}
				const parsed = this.parseKvValue(organizationId, source, key, entry.value);
				if (parsed !== undefined) {
					values.push({ key, value: parsed });
				}
			}
		} catch (error) {
			logger.warn({ organizationId, source, error }, "could not read a live snapshot");
		}
		return values;
	}

	private acquireOne(organizationId: string, source: LiveSource): () => void {
		const key = `${organizationId}/${source}`;
		const existing = this.streams.get(key);
		if (existing !== undefined) {
			existing.refs += 1;
			return () => this.releaseOne(key);
		}
		const opened: OrgSource = { refs: 1, stop: () => undefined };
		this.streams.set(key, opened);
		// Started after the entry is in the map so a second acquisition during the async open joins
		// this one rather than starting a duplicate.
		void this.startSource(organizationId, source, opened);
		return () => this.releaseOne(key);
	}

	private releaseOne(key: string): void {
		const source = this.streams.get(key);
		if (source === undefined) {
			return;
		}
		source.refs -= 1;
		if (source.refs > 0) {
			return;
		}
		source.stop();
		this.streams.delete(key);
	}

	private async startSource(
		organizationId: string,
		source: LiveSource,
		handle: OrgSource,
	): Promise<void> {
		const bucketName = BUCKET_FOR_SOURCE[source];
		try {
			if (bucketName !== undefined) {
				await this.startKvWatch(organizationId, source, bucketName, handle);
				return;
			}
			this.startSubscription(organizationId, source, handle);
		} catch (error) {
			if (!this.stopped) {
				logger.error({ organizationId, source, error }, "could not open a live upstream");
			}
		}
	}

	private async startKvWatch(
		organizationId: string,
		source: LiveSource,
		bucketName: string,
		handle: OrgSource,
	): Promise<void> {
		const bucket = this.buckets.get(bucketName);
		if (bucket === undefined) {
			return;
		}
		const watch = await bucket.watch({
			// `>` and not `*`: a NATS `*` matches exactly ONE token, and the buckets do not agree on
			// how many a key has. `registrations` and `agent-state` are `<org>.<id>`, but `channels`
			// is `<org>.<callId>.<legId>` — so an `<org>.*` filter would silently deliver nothing at
			// all for live calls while working perfectly for everything else.
			key: `${organizationId}.>`,
			// The snapshot half of the protocol reads the bucket at subscribe time, so a watch that
			// replayed last values would deliver every key twice — once as a snapshot row and once as
			// a change that did not happen. `UpdatesOnly` is what makes the two halves disjoint, and
			// is why a client may treat every `event` frame as a real transition.
			include: KvWatchInclude.UpdatesOnly,
		});
		if (this.streams.get(`${organizationId}/${source}`) !== handle) {
			// Released while the watch was opening.
			watch.stop();
			return;
		}
		handle.stop = () => {
			watch.stop();
		};
		void (async () => {
			try {
				for await (const entry of watch) {
					if (this.stopped) {
						return;
					}
					// A `DEL` or `PURGE` arrives with an empty value; so does a key whose writer wrote
					// nothing. Both mean the same thing to a reader — this key no longer describes
					// anything — so they are collapsed into one removal rather than leaking the
					// distinction between "deleted" and "tombstoned" to a browser.
					const removed = entry.operation !== "PUT" || entry.value.length === 0;
					if (removed) {
						this.emit(organizationId, source, "delete", null, entry.key);
						continue;
					}
					const parsed = this.parseKvValue(organizationId, source, entry.key, entry.value);
					if (parsed !== undefined) {
						this.emit(organizationId, source, "put", parsed, entry.key);
					}
				}
			} catch (error) {
				if (!this.stopped) {
					logger.warn({ organizationId, source, error }, "a live KV watch ended");
				}
			}
		})();
	}

	private startSubscription(organizationId: string, source: LiveSource, handle: OrgSource): void {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return;
		}
		const filter = SUBJECT_FILTER_FOR_SOURCE[source]?.(organizationId);
		if (filter === undefined) {
			return;
		}
		// Core NATS, not JetStream. These are live listeners with no durable state, no ack and no
		// replay: a browser that was not connected did not miss anything it can act on, and a durable
		// consumer per tab is a resource nobody deletes when a laptop lid closes.
		const subscription: Subscription = connection.subscribe(filter);
		if (this.streams.get(`${organizationId}/${source}`) !== handle) {
			subscription.unsubscribe();
			return;
		}
		handle.stop = () => {
			subscription.unsubscribe();
		};
		void (async () => {
			try {
				for await (const message of subscription) {
					if (this.stopped) {
						return;
					}
					const parsed = this.parseEvent(organizationId, source, message.data);
					if (parsed !== undefined) {
						this.emit(organizationId, source, parsed.type, parsed);
					}
				}
			} catch (error) {
				if (!this.stopped) {
					logger.warn({ organizationId, source, error }, "a live subscription ended");
				}
			}
		})();
	}

	/**
	 * Parses one KV value against its bucket's contract, and refuses one filed under another tenant.
	 *
	 * The org check is not redundant with the key filter: the filter constrains the KEY, and this
	 * constrains the VALUE. An entry whose value names a different organization under this
	 * organization's key is a bug in whoever wrote it, and forwarding it would put one tenant's
	 * calls on another's wallboard — which is the single worst thing this feature can do.
	 */
	private parseKvValue(
		organizationId: string,
		source: LiveSource,
		key: string,
		value: Uint8Array,
	): unknown {
		let decoded: unknown;
		try {
			decoded = JSON.parse(new TextDecoder().decode(value));
		} catch {
			this.dropped += 1;
			logger.warn({ organizationId, source, key }, "dropping an unparseable live KV entry");
			return undefined;
		}
		const schema =
			source === "registrations-kv"
				? registrationBindingSchema
				: source === "channels-kv"
					? liveChannelSchema
					: agentStateEntrySchema;
		const result = schema.safeParse(decoded);
		if (!result.success) {
			this.dropped += 1;
			logger.warn(
				{
					organizationId,
					source,
					key,
					issues: result.error.issues.slice(0, 3).map((issue) => issue.message),
				},
				"dropping a live KV entry that does not match its contract",
			);
			return undefined;
		}
		const entryOrg =
			"orgId" in result.data
				? result.data.orgId
				: "organizationId" in result.data
					? result.data.organizationId
					: undefined;
		if (entryOrg !== organizationId) {
			this.dropped += 1;
			logger.error(
				{
					organizationId,
					source,
					key,
					entryOrg,
				},
				"refusing to fan out a live entry filed under another organization",
			);
			return undefined;
		}
		return result.data;
	}

	private parseEvent(
		organizationId: string,
		source: LiveSource,
		data: Uint8Array,
	): { readonly type: string; readonly orgId: string } | undefined {
		let decoded: unknown;
		try {
			decoded = JSON.parse(new TextDecoder().decode(data));
		} catch {
			this.dropped += 1;
			return undefined;
		}
		const schema = EVENT_SCHEMA_FOR_SOURCE[source] ?? queueEventSchema;
		const result = schema.safeParse(decoded);
		if (!result.success) {
			this.dropped += 1;
			logger.warn(
				{
					organizationId,
					source,
					issues: result.error.issues.slice(0, 3).map((issue) => issue.message),
				},
				"dropping a live event that does not match its contract",
			);
			return undefined;
		}
		if (result.data.orgId !== organizationId) {
			// The subject filter is organization-scoped, so this cannot happen without a publisher
			// building a subject by hand. Checked anyway, at the one place cross-tenant delivery would
			// be visible to a user.
			this.dropped += 1;
			logger.error(
				{
					organizationId,
					source,
					eventOrg: result.data.orgId,
				},
				"refusing to fan out an event filed under another organization",
			);
			return undefined;
		}
		return result.data;
	}

	/**
	 * Fans one message out.
	 *
	 * `key` rides along for KV sources and is the reason a client can correlate a `delete` with the
	 * `put` that preceded it: a deletion carries no value, so the KEY is the only identity there is.
	 * A protocol that sent only the value would leave a browser unable to remove the row it had just
	 * been told to draw.
	 */
	private emit(
		organizationId: string,
		source: LiveSource,
		kind: string,
		data: unknown,
		key?: string,
	): void {
		this.forwarded += 1;
		for (const listener of this.listeners) {
			try {
				listener({
					organizationId,
					source,
					kind,
					data,
					at: new Date().toISOString(),
					...(key === undefined ? {} : { key }),
				});
			} catch (error) {
				// One misbehaving sink must not stop the others, and must not kill the watch loop.
				logger.warn({ organizationId, source, error }, "a live listener threw");
			}
		}
	}
}

/** One KV entry, as a snapshot carries it. The key is the identity a later `delete` names. */
export interface LiveKvRow {
	readonly key: string;
	readonly value: unknown;
}

/** One fan-out message, before it is narrowed to the topics that want it. */
export interface LiveHubMessage {
	readonly organizationId: string;
	readonly source: LiveSource;
	/** `put` / `delete` for a KV projection, the event `type` for a stream. */
	readonly kind: string;
	readonly at: string;
	/** `null` on a `delete` — there is no value to send. */
	readonly data: unknown;
	/** The KV key. Absent for stream sources, which have no key. */
	readonly key?: string;
}

export type LiveHubListener = (message: LiveHubMessage) => void;

interface OrgSource {
	refs: number;
	stop: () => void;
}

/**
 * Which subject filter each STREAM-backed source subscribes to. KV sources map to `undefined`.
 *
 * A table rather than the ternary this used to be. With two stream sources a conditional reads
 * fine; with three it silently becomes "queue-events, or anything I forgot to add" — which is how
 * a new source ends up subscribed to the wrong subject and delivering another feature's events
 * under its own name.
 */
const SUBJECT_FILTER_FOR_SOURCE: Readonly<
	Partial<Record<LiveSource, (organizationId: string) => string>>
> = {
	"call-events": (organizationId) => subjectFilterFor.callsInOrg(organizationId),
	"queue-events": (organizationId) => subjectFilterFor.queuesInOrg(organizationId),
	/**
	 * `mwi.updated` only — NOT `voicemail.evt.v1.<org>.>`.
	 *
	 * The other event on this root is `message.left`, whose payload is the caller's number, the
	 * object key of the audio and its duration: the message itself. The live topic exists to keep a
	 * count badge honest while a page is open, and `voicemail.read` is the permission gating it, so
	 * pushing message metadata down the same socket would widen the topic well past what its name
	 * and its permission mapping say it carries. Filtering at the SUBJECT rather than in the handler
	 * means those bytes never leave the broker.
	 */
	"voicemail-events": (organizationId) =>
		subjectFilterFor.voicemailEventInOrg(organizationId, "mwi.updated"),
	/**
	 * The whole family, unlike the voicemail entry above, and the asymmetry is deliberate: the
	 * family's one event IS the topic's payload, and there is no sibling on the root whose bytes
	 * `trunks.read` should not see. If a second trunk event ever joins the family, this is the
	 * line that decides whether it rides the topic.
	 */
	"trunk-events": (organizationId) => subjectFilterFor.trunksInOrg(organizationId),
};

/** Which contract each stream source's payloads are parsed against. */
const EVENT_SCHEMA_FOR_SOURCE: Readonly<
	Partial<
		Record<
			LiveSource,
			| typeof callEventSchema
			| typeof queueEventSchema
			| typeof voicemailEventSchema
			| typeof trunkEventSchema
		>
	>
> = {
	"call-events": callEventSchema,
	"queue-events": queueEventSchema,
	"voicemail-events": voicemailEventSchema,
	"trunk-events": trunkEventSchema,
};

/** Which bucket each KV-backed source reads. Stream sources map to `undefined`. */
const BUCKET_FOR_SOURCE: Readonly<Partial<Record<LiveSource, string>>> = {
	"registrations-kv": REGISTRATIONS_KV.name,
	"channels-kv": CHANNELS_KV.name,
	"agent-state-kv": AGENT_STATE_KV.name,
};
