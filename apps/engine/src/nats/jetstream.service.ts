import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import {
	connect,
	type JetStreamClient,
	type JetStreamManager,
	type KV,
	type NatsConnection,
} from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import {
	AGENT_STATE_KV,
	CHANNELS_KV,
	PRESENCE_KV,
	CONFERENCE_CLAIMS_KV,
	conferenceClaimSchema,
	DID_INDEX_KV,
	ensureKvBuckets,
	ensureStreams,
	kvKeyFor,
	PARK_CLAIMS_KV,
	parkClaimSchema,
	QUEUE_MEMBERSHIP_KV,
	ROUTING_CACHE_KV,
	subjectFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import {
	CHANNEL_OWNERSHIP_LEASE_MS,
	channelOwnershipOf,
	withChannelOwnership,
} from "./channel-ownership";
import { isConflict, KvClaimBucket, UnclaimedBucket } from "./claim-store";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { ClaimBucket } from "./claim-store";
import type {
	CdrLegWriteEnvelope,
	ConferenceClaim,
	ParkClaim,
	VoicemailEventEnvelope,
} from "@optimiq-voice/events";
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
	private presenceKv: KV | undefined;
	private routingCacheKv: KV | undefined;
	private didIndexKv: KV | undefined;
	private queueMembershipKv: KV | undefined;
	private agentStateKv: KV | undefined;
	private parkClaimsBucket: ClaimBucket<ParkClaim> = new UnclaimedBucket<ParkClaim>();
	private conferenceClaimsBucket: ClaimBucket<ConferenceClaim> =
		new UnclaimedBucket<ConferenceClaim>();
	/** Last channels-KV revision this replica proved it owns, by canonical channel key. */
	private readonly channelRevisions = new Map<string, number>();
	/** Lease expiry written by the last acknowledged create/update for each locally-owned channel. */
	private readonly channelLeaseExpiries = new Map<string, number>();
	/** Serializes each channel's CAS chain so two local events cannot race on the same revision. */
	private readonly channelOperations = new Map<string, Promise<unknown>>();
	private ready = false;

	constructor(@Inject(ENGINE_ENV) private readonly env: EngineEnv) {}

	/** Whether the JetStream side is usable. What `/healthz` reports. */
	get isReady(): boolean {
		return this.ready && this.connection?.isClosed() === false;
	}

	get serverUrl(): string {
		return this.env.NATS_URL;
	}

	/**
	 * The raw connection, for the one caller that needs core request-reply with NO Nest framing.
	 *
	 * Exposed rather than duplicated: `rpc.media.v1.*` is served by a Go responder that unmarshals
	 * the bare contract struct, so its client cannot be a `ClientProxy` (see
	 * `media/mediad-transport.ts`), and opening a THIRD connection to the same broker would be a
	 * third thing to authenticate, drain and reconnect for no benefit.
	 *
	 * `undefined` before `onModuleInit` has run and after shutdown, which is why the media transport
	 * reads it through an accessor rather than capturing it once at construction: Nest builds
	 * providers before it initialises them.
	 */
	get rawConnection(): NatsConnection | undefined {
		return this.connection;
	}

	async onModuleInit(): Promise<void> {
		this.connection = await connect({
			servers: this.env.NATS_URL,
			...natsConnectionOptions(this.env, "engine"),
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
		// `presence` — the BLF/MWI read model, DERIVED from `channels` above by
		// `presence/presence.service.ts` and read by `apps/sipd` to compose a NOTIFY. This engine is
		// its only writer; the SIP edge's broker permissions deny it the write side entirely.
		this.presenceKv = await this.jetstream.views.kv(PRESENCE_KV.name);
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
		// The ACD pair. `queue-membership` is written by `apps/api` and read here; `agent-state` is
		// written by BOTH — the control plane on login/logout/pause, this engine on the call-driven
		// transitions it is the only process that can see. Opening the views creates the buckets with
		// the same definitions `ensureKvBuckets` applies, so an engine that boots before the control
		// plane has ever run does not discover their absence on its first queued caller.
		this.queueMembershipKv = await this.jetstream.views.kv(QUEUE_MEMBERSHIP_KV.name);
		this.agentStateKv = await this.jetstream.views.kv(AGENT_STATE_KV.name);
		// The two CLAIM buckets. Both are written and read by this engine and by every other instance
		// of it, and by nothing else — see `claim-store.ts` for why they are wrapped in a
		// compare-and-set surface rather than exposed raw the way the read-mostly buckets are.
		this.parkClaimsBucket = new KvClaimBucket<ParkClaim>(
			await this.jetstream.views.kv(PARK_CLAIMS_KV.name),
			parkClaimSchema as never,
			PARK_CLAIMS_KV.name,
		);
		this.conferenceClaimsBucket = new KvClaimBucket<ConferenceClaim>(
			await this.jetstream.views.kv(CONFERENCE_CLAIMS_KV.name),
			conferenceClaimSchema as never,
			CONFERENCE_CLAIMS_KV.name,
		);
		this.ready = true;
	}

	/**
	 * The `channels` bucket, raw, for the presence publisher.
	 *
	 * The three helpers below ({@link putChannel} and friends) stay the way every other caller
	 * reaches this bucket — they are point operations on a snapshot the caller already holds. The
	 * presence publisher needs the third pattern instead: a long-lived WATCH whose lifetime belongs
	 * to its consumer, exactly as {@link routingCache} does. Wrapping that here would mean this
	 * service owning a subscription it has no reason to know the shape of.
	 *
	 * `undefined` before `onModuleInit` has run, or after shutdown.
	 */
	get channels(): KV | undefined {
		return this.channelsKv;
	}

	/**
	 * The `presence` bucket, raw, for the presence publisher.
	 *
	 * Raw for a different reason from the buckets above: the publisher does a read-compare-write per
	 * extension (see the debounce note on `extensionPresenceSchema`), and a `put`-only helper here
	 * would hide the read that makes the debounce work.
	 *
	 * `undefined` before `onModuleInit` has run, or after shutdown.
	 */
	get presence(): KV | undefined {
		return this.presenceKv;
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
	 * The `queue-membership` bucket, for {@link import("../queue/queue-membership.source")
	 * .QueueMembershipSource}.
	 *
	 * Exposed raw, like the routing cache, because the consumer owns the read pattern: it needs both
	 * a point read and a long-lived watch, and a watch's lifetime belongs to whoever iterates it.
	 *
	 * `undefined` before `onModuleInit` has run, or after shutdown.
	 */
	get queueMembership(): KV | undefined {
		return this.queueMembershipKv;
	}

	/**
	 * The `agent-state` bucket, for {@link import("../queue/agent-state.store").AgentStateStore}.
	 *
	 * The one bucket this service exposes that the engine WRITES as well as reads, and the write is
	 * deliberately not wrapped here the way `putChannel` is. A channel snapshot is a mirror of state
	 * the engine already holds, so a lost write costs a failover its detail; an agent transition is a
	 * state machine step that has to be guarded against what the bucket currently holds, and a
	 * read-guard-write belongs with the machine rather than with the connection.
	 */
	get agentState(): KV | undefined {
		return this.agentStateKv;
	}

	/**
	 * The `park-claims` bucket, as a compare-and-set surface.
	 *
	 * Wrapped rather than raw — the opposite decision from `routingCache` and `queueMembership` —
	 * because the consumer does NOT own the read pattern here: there is exactly one correct way to
	 * take an exclusive claim (create, and accept losing), and handing a registry a raw `KV` invites
	 * the `put` that always wins and always splits the lot in two.
	 *
	 * Before `onModuleInit` has run, and after shutdown, this is an {@link UnclaimedBucket}: local
	 * claims only, which is what a single-instance deployment and every spec run on.
	 */
	get parkClaims(): ClaimBucket<ParkClaim> {
		return this.parkClaimsBucket;
	}

	/** The `conference-claims` bucket. Same contract, same reasoning, as {@link parkClaims}. */
	get conferenceClaims(): ClaimBucket<ConferenceClaim> {
		return this.conferenceClaimsBucket;
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
	async putChannel(snapshot: ChannelSnapshot, now = Date.now()): Promise<void> {
		await this.persistChannel(snapshot, now);
	}

	/**
	 * Persists a channel snapshot and reports whether JetStream acknowledged it.
	 *
	 * Live-state mirroring may ignore the result through {@link putChannel}. Terminal reporting may
	 * not: this is its durability barrier, and a `false` result means no CDR publish may follow.
	 */
	async persistChannel(snapshot: ChannelSnapshot, now = Date.now()): Promise<boolean> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return false;
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		return await this.serializeChannelOperation(key, async () => {
			const revision = this.channelRevisions.get(key);
			if (revision === undefined) {
				return false;
			}
			const expiresAt = now + CHANNEL_OWNERSHIP_LEASE_MS;
			try {
				const next = await kv.update(
					key,
					encodeChannel(withChannelOwnership(snapshot, this.env.ENGINE_INSTANCE_ID, expiresAt)),
					revision,
				);
				this.rememberChannelOwnership(key, next, expiresAt);
				return true;
			} catch (error) {
				if (isConflict(error)) {
					this.forgetChannelOwnership(key);
					this.logger.warn({ key }, "lost channel ownership while mirroring state");
					return false;
				}
				this.logger.warn({ key, err: String(error) }, "failed to mirror channel state to KV");
				return false;
			}
		});
	}

	/** Removes a leg from the `channels` bucket once it is destroyed. */
	async deleteChannel(snapshot: ChannelSnapshot): Promise<void> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return;
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		await this.serializeChannelOperation(key, async () => {
			const revision = this.channelRevisions.get(key);
			if (revision === undefined) {
				return;
			}
			try {
				await kv.delete(key, { previousSeq: revision });
				this.forgetChannelOwnership(key);
			} catch (error) {
				if (isConflict(error)) {
					this.forgetChannelOwnership(key);
					this.logger.warn({ key }, "lost channel ownership before deleting state");
					return;
				}
				this.logger.warn({ key, err: String(error) }, "failed to clear channel state from KV");
			}
		});
	}

	/**
	 * Atomically admits a leg into this engine instance.
	 *
	 * This operation uses KV `create`, which can lose, before the orchestrator creates local state.
	 * The ownership record is also the ordinary live-state snapshot, avoiding a second bucket to
	 * reconcile for either ARI or mediad replicas.
	 */
	async claimChannel(snapshot: ChannelSnapshot, now = Date.now()): Promise<ChannelClaimResult> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return "unavailable";
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		return await this.serializeChannelOperation(key, async () => {
			const expiresAt = now + CHANNEL_OWNERSHIP_LEASE_MS;
			const owned = withChannelOwnership(snapshot, this.env.ENGINE_INSTANCE_ID, expiresAt);
			try {
				const revision = await kv.create(key, encodeChannel(owned));
				this.rememberChannelOwnership(key, revision, expiresAt);
				return "claimed";
			} catch (error) {
				if (isConflict(error)) {
					return await this.adoptChannelAt(kv, key, now, false);
				}
				this.logger.warn(
					{ key, err: String(error) },
					"failed to claim a channel; admission is closed to prevent duplicate ownership",
				);
				return "unavailable";
			}
		});
	}

	/** Takes over a legacy, same-instance, or expired snapshot with one revision-fenced write. */
	async adoptChannel(snapshot: ChannelSnapshot, now = Date.now()): Promise<ChannelClaimResult> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return "unavailable";
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		return await this.serializeChannelOperation(
			key,
			async () => await this.adoptChannelAt(kv, key, now, true),
		);
	}

	/** Extends one locally-owned lease while preserving its latest aggregate snapshot. */
	async renewChannel(snapshot: ChannelSnapshot, now = Date.now()): Promise<ChannelRenewResult> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return "unavailable";
		}
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		return await this.serializeChannelOperation(key, async () => {
			const revision = this.channelRevisions.get(key);
			if (revision === undefined) {
				return "lost";
			}
			const expiresAt = now + CHANNEL_OWNERSHIP_LEASE_MS;
			try {
				const next = await kv.update(
					key,
					encodeChannel(withChannelOwnership(snapshot, this.env.ENGINE_INSTANCE_ID, expiresAt)),
					revision,
				);
				this.rememberChannelOwnership(key, next, expiresAt);
				return "renewed";
			} catch (error) {
				if (isConflict(error)) {
					this.forgetChannelOwnership(key);
					return "lost";
				}
				this.logger.warn({ key, err: String(error) }, "failed to renew channel ownership");
				return "unavailable";
			}
		});
	}

	/** Expiry from the last ownership write JetStream acknowledged for this local channel. */
	ownedChannelLeaseExpiresAt(snapshot: ChannelSnapshot): number | undefined {
		return this.channelLeaseExpiries.get(
			kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId),
		);
	}

	/** Stops this process from issuing further CAS writes after the orchestrator self-fences. */
	async releaseChannelOwnership(snapshot: ChannelSnapshot): Promise<void> {
		const key = kvKeyFor.channel(snapshot.organizationId, snapshot.callId, snapshot.channelId);
		await this.serializeChannelOperation(key, async () => {
			this.forgetChannelOwnership(key);
		});
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

	/** Iterates the current `channels` values once so the orchestrator can rebuild its local cache. */
	async *channelSnapshots(): AsyncGenerator<ChannelSnapshot> {
		const kv = this.channelsKv;
		if (kv === undefined) {
			return;
		}

		const keys = await kv.keys();
		for await (const key of keys) {
			const entry = await kv.get(key);
			if (entry === null || entry.value.length === 0) {
				continue;
			}
			try {
				const snapshot = JSON.parse(new TextDecoder().decode(entry.value)) as ChannelSnapshot;
				const expectedKey = kvKeyFor.channel(
					snapshot.organizationId,
					snapshot.callId,
					snapshot.channelId,
				);
				if (key !== expectedKey) {
					throw new Error(`snapshot belongs at ${expectedKey}`);
				}
				yield snapshot;
			} catch (error) {
				this.logger.warn(
					{ key, err: String(error) },
					"ignored an invalid channel recovery snapshot",
				);
			}
		}
	}

	private async adoptChannelAt(
		kv: KV,
		key: string,
		now: number,
		allowSameOwner: boolean,
	): Promise<ChannelClaimResult> {
		let current: { readonly snapshot: ChannelSnapshot; readonly revision: number } | undefined;
		try {
			const entry = await kv.get(key);
			if (entry === null || entry.value.length === 0) {
				return "owned";
			}
			const snapshot = JSON.parse(new TextDecoder().decode(entry.value)) as ChannelSnapshot;
			const expectedKey = kvKeyFor.channel(
				snapshot.organizationId,
				snapshot.callId,
				snapshot.channelId,
			);
			if (expectedKey !== key) {
				throw new Error(`snapshot belongs at ${expectedKey}`);
			}
			current = { snapshot, revision: entry.revision };
		} catch (error) {
			this.logger.warn({ key, err: String(error) }, "failed to read a channel owner");
			return "unavailable";
		}

		const ownership = channelOwnershipOf(current.snapshot);
		if (
			ownership !== undefined &&
			ownership.expiresAt > now &&
			(ownership.instanceId !== this.env.ENGINE_INSTANCE_ID || !allowSameOwner)
		) {
			return "owned";
		}

		const expiresAt = now + CHANNEL_OWNERSHIP_LEASE_MS;
		try {
			const revision = await kv.update(
				key,
				encodeChannel(
					withChannelOwnership(current.snapshot, this.env.ENGINE_INSTANCE_ID, expiresAt),
				),
				current.revision,
			);
			this.rememberChannelOwnership(key, revision, expiresAt);
			return "claimed";
		} catch (error) {
			if (isConflict(error)) {
				return "owned";
			}
			this.logger.warn({ key, err: String(error) }, "failed to adopt a channel");
			return "unavailable";
		}
	}

	private async serializeChannelOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.channelOperations.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.channelOperations.set(key, current);
		try {
			return await current;
		} finally {
			if (this.channelOperations.get(key) === current) {
				this.channelOperations.delete(key);
			}
		}
	}

	private rememberChannelOwnership(key: string, revision: number, expiresAt: number): void {
		this.channelRevisions.set(key, revision);
		this.channelLeaseExpiries.set(key, expiresAt);
	}

	private forgetChannelOwnership(key: string): void {
		this.channelRevisions.delete(key);
		this.channelLeaseExpiries.delete(key);
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
		this.presenceKv = undefined;
		this.routingCacheKv = undefined;
		this.didIndexKv = undefined;
		this.queueMembershipKv = undefined;
		this.agentStateKv = undefined;
		this.parkClaimsBucket = new UnclaimedBucket<ParkClaim>();
		this.conferenceClaimsBucket = new UnclaimedBucket<ConferenceClaim>();
		this.channelRevisions.clear();
		this.channelLeaseExpiries.clear();
		this.channelOperations.clear();
		if (connection !== undefined && !connection.isClosed()) {
			// `drain` flushes in-flight publishes before closing; `close` would drop them, and the
			// publishes in flight during a shutdown are precisely the CDRs of the calls being
			// drained.
			await connection.drain();
		}
	}
}

export type ChannelClaimResult = "claimed" | "owned" | "unavailable";
export type ChannelRenewResult = "renewed" | "lost" | "unavailable";

function encodeChannel(snapshot: ChannelSnapshot): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(snapshot));
}
