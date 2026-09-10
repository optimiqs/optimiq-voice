import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import {
	ENGINE_INSTANCES_KV,
	engineInstanceLeaseSchema,
	isEngineInstanceLeaseExpired,
	kvKeyFor,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { InstanceLivenessWatcher } from "./instance-liveness.watcher";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { EngineInstanceLease } from "@optimiq-voice/events";

/** The lease horizon, taken from the bucket definition so the two can never drift. */
export const ENGINE_LEASE_TTL_MS = ENGINE_INSTANCES_KV.ttlMs;

/**
 * Renewal interval: a third of the lease, so TWO consecutive writes may be lost before a peer is
 * entitled to call this process dead. The same ratio `apps/sipd`'s renewer uses.
 */
export const ENGINE_LEASE_RENEW_INTERVAL_MS = Math.floor(ENGINE_LEASE_TTL_MS / 3);

const encoder = new TextEncoder();

/**
 * This engine's own liveness lease, and a watch over every other engine's.
 *
 * ## Why the channel ownership leases were not enough — measured, not theorised
 *
 * A second engine was started, given a call, and SIGKILLed mid-call. The call SURVIVED intact —
 * correctly, because `mediad` relays the audio and `sipd` holds the dialog, so the engine is not on
 * the call path. But the surviving engine adopted nothing: it sat at `activeChannels: 0` for the
 * whole forty seconds of observation while the `channels` bucket still held the dead instance's two
 * entries, no CDR was ever written, and the eventual `dialog.terminated` reached a replica with no
 * aggregate for the leg and returned early. **The call was never billed and never cleaned up.**
 *
 * The reason is a horizon, not a missing mechanism: `CHANNEL_OWNERSHIP_LEASE_MS` is ninety seconds,
 * because it is renewed by a heartbeat that rewrites EVERY live channel on the replica, and a
 * survivor with no other evidence must respect an unexpired lease — an engine that adopted on a
 * shorter clock would take a busy peer's calls out from under it.
 *
 * This service supplies the other evidence. One key per PROCESS, renewed every five seconds, is
 * cheap enough to hold a fifteen-second horizon, and a peer whose key has lapsed is not slow but
 * gone. The survivor then contests that peer's channels through the ordinary revision-fenced CAS
 * ({@link JetStreamService.adoptChannelFromInstance}), so exactly one survivor wins each channel.
 * The ninety-second lease is unchanged and still fences everything else.
 *
 * ## Why the first write is fatal and later ones are not
 *
 * An instance that cannot assert its own liveness looks dead to every peer, so its channels would be
 * contested out from under it while it is serving them — a split brain produced by a permission or a
 * bucket that is missing, which is a deployment fault and belongs at boot. Once the lease is
 * established a failed RENEWAL is a broker hiccup: two more attempts fit inside the horizon, and
 * killing a process holding live calls over one refused write would cause the outage it is avoiding.
 * Both counts are on `/healthz` either way.
 */
@Injectable()
export class EngineLivenessService implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.liveness");
	private readonly startedAt = Date.now();
	private listener: ((instanceId: string, lease: EngineInstanceLease) => Promise<void>) | undefined;
	private channelCount: (() => number) | undefined;
	private renewTimer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	private leaseWritten = false;
	private renewFailures = 0;
	private contests: Promise<void> = Promise.resolve();

	// Constructed in the constructor body, not as a field initializer: `selfInstanceId` is read
	// eagerly from `env`, and a parameter property is not assigned until after field initializers run.
	private readonly watcher: InstanceLivenessWatcher<EngineInstanceLease>;

	constructor(
		private readonly jetstream: JetStreamService,
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
	) {
		this.watcher = new InstanceLivenessWatcher<EngineInstanceLease>({
			bucketName: "engine-instances",
			subject: "an engine replica",
			logger: this.logger,
			bucket: () => this.jetstream.engineInstances,
			parse: (raw) => engineInstanceLeaseSchema.parse(raw),
			isExpired: isEngineInstanceLeaseExpired,
			// This process writes the bucket too, so its own key comes back on its own watch.
			// Reporting it would run the peer-death path against ourselves and contest every channel
			// this instance owns.
			selfInstanceId: env.ENGINE_INSTANCE_ID,
			onLost: (instanceId, lease) => {
				this.contestSerially(instanceId, lease);
			},
		});
	}

	/**
	 * Registers the sink for a peer's death — in practice the orchestrator's adoption contest.
	 *
	 * Called ONCE per lost instance. Its promise is awaited, but on this service's own chain rather
	 * than inside a watch iteration: a contest that reads and CASes every one of a dead peer's
	 * channels must not hold up the feed that would tell us about the next death.
	 */
	setInstanceLostHandler(
		handler: (instanceId: string, lease: EngineInstanceLease) => Promise<void>,
	): void {
		this.listener = handler;
	}

	/** Where the operator-facing `channels` count on each renewal comes from. Never authorising. */
	setChannelCountSource(source: () => number): void {
		this.channelCount = source;
	}

	get isWatching(): boolean {
		return this.watcher.isWatching;
	}

	/** Peers currently holding a live lease. Excludes this process. */
	get liveInstances(): readonly string[] {
		return this.watcher.liveInstances;
	}

	get lostCount(): number {
		return this.watcher.lostCount;
	}

	/** Whether this process's own lease is established. `false` here means peers think we are dead. */
	get isLeaseHeld(): boolean {
		return this.leaseWritten;
	}

	get renewFailureCount(): number {
		return this.renewFailures;
	}

	/**
	 * Claims this instance's lease, then starts renewing it and watching its peers.
	 *
	 * Throws if the FIRST claim cannot be written; see the class header for why that one is fatal.
	 */
	async start(): Promise<void> {
		if (this.stopped || this.renewTimer !== undefined) {
			return;
		}
		if (this.listener === undefined) {
			throw new Error(
				"EngineLivenessService.start() called before an instance-lost handler was set.",
			);
		}
		const written = await this.writeLease(Date.now());
		if (!written) {
			throw new Error(
				`could not write this engine's liveness lease to the ${ENGINE_INSTANCES_KV.name} ` +
					"bucket; an instance that cannot assert its own liveness would have its live " +
					"channels adopted out from under it by every peer.",
			);
		}
		this.leaseWritten = true;
		this.logger.info(
			{ instanceId: this.env.ENGINE_INSTANCE_ID, ttlMs: ENGINE_LEASE_TTL_MS },
			"claimed this engine's liveness lease",
		);
		this.renewTimer = setInterval(() => {
			void this.renew();
		}, ENGINE_LEASE_RENEW_INTERVAL_MS);
		this.renewTimer.unref?.();
		this.watcher.start();
	}

	/** Reports every peer whose lease has lapsed at `now`. Driven by the watcher's sweep timer. */
	sweep(now: number): void {
		this.watcher.sweep(now);
	}

	/** Settles every adoption contest this service has started. For the drain and the tests. */
	async awaitContests(): Promise<void> {
		await this.contests;
	}

	private contestSerially(instanceId: string, lease: EngineInstanceLease): void {
		// Chained rather than parallel: two dead peers at once would otherwise put two full listings
		// of the CLUSTER-wide `channels` bucket on the connection at the same moment, and the second
		// contest sees the first's adoptions once it runs, so it does strictly less work for waiting.
		this.contests = this.contests
			.catch(() => undefined)
			.then(async () => {
				await this.listener?.(instanceId, lease);
			})
			.catch((error: unknown) => {
				this.logger.error(
					{ instanceId, err: String(error) },
					"the adoption contest for a dead engine replica failed",
				);
			});
	}

	private async renew(): Promise<void> {
		if (this.stopped) {
			return;
		}
		if (await this.writeLease(Date.now())) {
			this.leaseWritten = true;
			return;
		}
		this.renewFailures += 1;
		this.leaseWritten = false;
		this.logger.warn(
			{ instanceId: this.env.ENGINE_INSTANCE_ID, failures: this.renewFailures },
			"could not renew this engine's liveness lease; peers may contest this instance's channels",
		);
	}

	private async writeLease(now: number): Promise<boolean> {
		const bucket = this.jetstream.engineInstances;
		if (bucket === undefined) {
			return false;
		}
		const lease: EngineInstanceLease = {
			instanceId: this.env.ENGINE_INSTANCE_ID,
			startedAt: this.startedAt,
			renewedAt: now,
			expiresAt: now + ENGINE_LEASE_TTL_MS,
			channels: this.channelCount?.() ?? 0,
		};
		try {
			await bucket.put(
				kvKeyFor.engineInstance(this.env.ENGINE_INSTANCE_ID),
				encoder.encode(JSON.stringify(lease)),
			);
			return true;
		} catch (error) {
			this.logger.warn({ err: String(error) }, "failed to write this engine's liveness lease");
			return false;
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.renewTimer !== undefined) {
			clearInterval(this.renewTimer);
			this.renewTimer = undefined;
		}
		await this.watcher.stop();
		await this.contests.catch(() => undefined);
		// Released explicitly rather than left to lapse. A graceful shutdown has already drained its
		// channels, so there is nothing for a peer to adopt — but a key left behind makes every
		// survivor wait out the TTL before it can be sure, and a rolling deploy would spend that
		// horizon per replica for no reason.
		const bucket = this.jetstream.engineInstances;
		if (bucket !== undefined && this.leaseWritten) {
			try {
				await bucket.delete(kvKeyFor.engineInstance(this.env.ENGINE_INSTANCE_ID));
			} catch (error) {
				this.logger.warn(
					{ err: String(error) },
					"could not release this engine's liveness lease; it will lapse on its own",
				);
			}
		}
		this.leaseWritten = false;
	}
}
