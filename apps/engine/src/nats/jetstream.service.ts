import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import {
	connect,
	type JetStreamClient,
	type JetStreamManager,
	type KV,
	type NatsConnection,
} from "nats";
import {
	CHANNELS_KV,
	DID_INDEX_KV,
	ensureKvBuckets,
	ensureStreams,
	kvKeyFor,
	ROUTING_CACHE_KV,
	subjectFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { CdrLegWriteEnvelope, VoicemailEventEnvelope } from "@optimiq-voice/events";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/**
 * The raw-JetStream half of the NATS backbone.
 *
 * ## Why there are two NATS clients in this app
 *
 * The owner decision recorded in plan §3.5 is explicit: **no custom NATS framework.** Applications
 * use NestJS's built-in NATS transport for core pub/sub and request-reply, and drop to the raw
 * `nats` API only where JetStream durability or KV is genuinely needed. This service is that
 * "only where":
 *
 * - **KV** (`channels` bucket). There is no NestJS transport abstraction for KV at all.
 * - **The CDR publish.** `cdr.leg.write` is a billing ledger, and the `CDR` stream is configured
 *   `discard: new` precisely so that an overflowing broker REFUSES the write instead of silently
 *   dropping revenue. A core publish cannot see that refusal — it is fire-and-forget by
 *   definition. A JetStream publish returns an ack (or an error the caller can retry and alert
 *   on), and carries a `Nats-Msg-Id` so a retry of the same leg is deduplicated inside the
 *   stream's duplicate window rather than billed twice.
 *
 * Call lifecycle events go the other way — through the Nest transport in
 * `call-event-publisher.service.ts` — because they are high-volume live state that the `CALLS`
 * stream captures anyway (a JetStream stream ingests core publishes on its subjects), and paying
 * for a per-event ack on every channel state change of every leg would put a round trip in the
 * middle of the call path.
 */
@Injectable()
export class JetStreamService implements OnModuleInit, OnApplicationShutdown {
	private readonly logger = getLogger("engine.jetstream");

	private connection: NatsConnection | undefined;
	private jetstream: JetStreamClient | undefined;
	private channelsKv: KV | undefined;
	private routingCacheKv: KV | undefined;
	private didIndexKv: KV | undefined;
	private ready = false;

	constructor(@Inject(ENGINE_ENV) private readonly env: EngineEnv) {}

	/** Whether the JetStream side is usable. What `/healthz` reports. */
	get isReady(): boolean {
		return this.ready && this.connection?.isClosed() === false;
	}

	get serverUrl(): string {
		return this.env.NATS_URL;
	}

	async onModuleInit(): Promise<void> {
		this.connection = await connect({
			servers: this.env.NATS_URL,
			name: "optimiq-engine-jetstream",
			// The engine must not exit because the broker restarted mid-shift.
			maxReconnectAttempts: -1,
			reconnectTimeWait: 1_000,
		});

		const manager: JetStreamManager = await this.connection.jetstreamManager();

		if (this.env.ENGINE_ENSURE_STREAMS) {
			// Idempotent by construction (see `@optimiq-voice/events`), so this is safe on every
			// boot of every replica; the flag exists for deployments that apply definitions as a
			// separate migration job instead.
			const streams = await ensureStreams(manager);
			const buckets = await ensureKvBuckets(manager);
			this.logger.info(
				{
					streams: streams.map((outcome) => `${outcome.name}:${outcome.action}`),
					buckets: buckets.map(
						(outcome) => `${outcome.name}:${outcome.created ? "created" : "present"}`,
					),
				},
				"applied JetStream definitions",
			);
		}

		this.jetstream = this.connection.jetstream();
		this.channelsKv = await this.jetstream.views.kv(CHANNELS_KV.name);
		// The routing cache is READ here and written by `apps/api` on save. Opening the view is
		// still safe when the bucket does not exist yet — `views.kv` creates it with the same
		// definition `ensureKvBuckets` applies — so a fresh cluster does not need the API to have
		// booted first for the engine to come up.
		this.routingCacheKv = await this.jetstream.views.kv(ROUTING_CACHE_KV.name);
		// Same reasoning as the routing cache: WRITTEN by `apps/api` when a number is provisioned,
		// read here. Opening the view creates the bucket with the same definition `ensureKvBuckets`
		// applies, so an engine that boots before the control plane has ever run does not have to
		// discover the bucket's absence on its first inbound call.
		this.didIndexKv = await this.jetstream.views.kv(DID_INDEX_KV.name);
		this.ready = true;
	}

	/**
	 * The `routing-cache` bucket, for the routing artifact source.
	 *
	 * Exposed as the raw `KV` rather than wrapped in a read/watch pair, because the artifact source
	 * needs BOTH a point read and a long-lived watch, and a watch is an async iterator whose
	 * lifetime belongs to its consumer. Wrapping it here would mean this service owning a
	 * subscription it has no reason to know the shape of.
	 *
	 * `undefined` before `onModuleInit` has run, or after shutdown.
	 */
	get routingCache(): KV | undefined {
		return this.routingCacheKv;
	}

	/**
	 * The `did-index` bucket, for {@link import("../routing/did-index.source").DidIndexSource}.
	 *
	 * Exposed raw, like {@link routingCache}, because the consumer owns the read pattern. Unlike the
	 * routing cache there is no watch: an entry here decides which TENANT a call belongs to, so it is
	 * read fresh per call rather than cached — see the source's header for the argument.
	 *
	 * `undefined` before `onModuleInit` has run, or after shutdown.
	 */
	get didIndex(): KV | undefined {
		return this.didIndexKv;
	}

	/**
	 * The bucket key for a dialled number.
	 *
	 * Here rather than at the call site so the engine's reader and the control plane's writer are
	 * provably using one normalisation (`kvKeyFor.didIndex`, pinned across languages by the
	 * `packages/events` parity golden).
	 *
	 * @throws {import("@optimiq-voice/events").SubjectTokenError} when the value has no digits.
	 */
	didIndexKey(did: string): string {
		return kvKeyFor.didIndex(did);
	}

	/**
	 * Mirrors a leg's live state into the `channels` bucket.
	 *
	 * This is the whole of the plan's "engine failover and drain" story (§3.5, §8 risk 5): the
	 * snapshot is deliberately the KV-safe `ChannelSnapshot` from `@optimiq-voice/telephony`, so
	 * another instance can read it without sharing a single line of engine code.
	 *
	 * A failure here is LOGGED, not thrown. KV is a mirror of state the engine already holds in
	 * memory; losing a write costs a failover its detail, whereas letting the rejection propagate
	 * would abort the call the write was describing.
	 */
	async putChannel(snapshot: ChannelSnapshot): Promise<void> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return;
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		try {
			await kv.put(key, new TextEncoder().encode(JSON.stringify(snapshot)));
		} catch (error) {
			this.logger.warn({ key, err: String(error) }, "failed to mirror channel state to KV");
		}
	}

	/** Removes a leg from the `channels` bucket once it is destroyed. */
	async deleteChannel(snapshot: ChannelSnapshot): Promise<void> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return;
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		try {
			await kv.delete(key);
		} catch (error) {
			this.logger.warn({ key, err: String(error) }, "failed to clear channel state from KV");
		}
	}

	/** Reads a mirrored snapshot back. Used by the integration suite and by failover recovery. */
	async readChannel(
		organizationId: string,
		callId: string,
		channelId: string,
	): Promise<ChannelSnapshot | undefined> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return undefined;
		}
		const entry = await kv.get(kvKeyFor.channel(organizationId, callId, channelId));
		if (entry === null || entry.value.length === 0) {
			return undefined;
		}
		return JSON.parse(new TextDecoder().decode(entry.value)) as ChannelSnapshot;
	}

	/**
	 * Publishes one `cdr.leg.write` with an ack.
	 *
	 * `msgID` is the envelope's own UUID v7, which makes a retry of the same leg idempotent inside
	 * the `CDR` stream's 10-minute duplicate window — the exact case a crash-looping writer
	 * produces. This one DOES throw on failure: a CDR that was refused must not be forgotten.
	 */
	async publishCdrLeg(envelope: CdrLegWriteEnvelope): Promise<void> {
		const jetstream = this.jetstream;
		if (jetstream === undefined) {
			throw new Error("JetStream is not connected; cannot publish a CDR leg.");
		}
		await jetstream.publish(
			subjectFor.cdrLeg(envelope.orgId),
			new TextEncoder().encode(JSON.stringify(envelope)),
			{ msgID: envelope.id },
		);
	}

	/**
	 * Publishes one voicemail event with an ack.
	 *
	 * Acked for the same reason the CDR is: `VOICEMAIL` is `discard: new`, so an overflowing broker
	 * REFUSES the write rather than dropping it, and a core publish cannot see a refusal. A dropped
	 * `voicemail.message.left` is a message a caller recorded and a user will never be shown — the
	 * audio is in the object store and nothing points at it.
	 *
	 * `msgID` is the envelope's own UUID v7, so a retry inside the stream's duplicate window inserts
	 * one row rather than two copies of one message. Throws on failure: the caller notes it on the
	 * walk, which is what makes the divergence visible.
	 */
	async publishVoicemail(envelope: VoicemailEventEnvelope): Promise<void> {
		const jetstream = this.jetstream;
		if (jetstream === undefined) {
			throw new Error("JetStream is not connected; cannot publish a voicemail event.");
		}
		await jetstream.publish(envelope.subject, new TextEncoder().encode(JSON.stringify(envelope)), {
			msgID: envelope.id,
		});
	}

	async onApplicationShutdown(): Promise<void> {
		this.ready = false;
		const connection = this.connection;
		this.connection = undefined;
		this.jetstream = undefined;
		this.channelsKv = undefined;
		this.routingCacheKv = undefined;
		this.didIndexKv = undefined;
		if (connection !== undefined && !connection.isClosed()) {
			// `drain` flushes in-flight publishes before closing; `close` would drop them, and the
			// publishes in flight during a shutdown are precisely the CDRs of the calls being
			// drained.
			await connection.drain();
		}
	}
}
