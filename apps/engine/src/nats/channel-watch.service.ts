import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { channelOwnershipOf } from "./channel-ownership";
import { JetStreamService } from "./jetstream.service";
import { ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

const decoder = new TextDecoder();

/** Backoff for a watch that ended, capped so a long broker outage still retries every 30 s. */
function backoffMs(attempt: number): number {
	return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
}

/** What the watch asks the orchestrator to do with one snapshot it noticed. */
export interface ChannelWatchSink {
	/** Take over one snapshot nobody live owns. Returns whether this instance won it. */
	adoptOrphanedChannel(snapshot: ChannelSnapshot, now: number): Promise<boolean>;
}

/**
 * Watches the `channels` bucket so a stranded call is noticed when it is written, not at the next
 * boot.
 *
 * ## The failure this exists for
 *
 * Recovery of another replica's channels ran in exactly two places: `hydrateChannels()` at boot, and
 * the ownership-maintenance tick, which pays a CLUSTER-wide listing of the bucket every heartbeat to
 * find the handful of keys that have changed. So the documented recovery from a dead peer was
 * "restart the survivor" — which is what the live test found: the survivor sat at `activeChannels: 0`
 * while the bucket held the dead instance's entries, and only a restart adopted them.
 *
 * A watch is the signal the design already had everywhere else — `routing-cache`, `queue-membership`
 * and `sip-instances` all have one — and it turns that listing into a per-key event. The periodic
 * pass is deliberately KEPT: it is the thing that renews this instance's own leases, and it is the
 * backstop for anything the watch missed while it was down.
 *
 * ## The stale guard, and why it is revisions rather than silence
 *
 * A `kv.watch()` is an ordered push consumer with flow control, and a broker that refuses the
 * client's flow-control reply stops delivering SILENTLY — no error, no closed subscription, no end of
 * iterator. That cost an hour of stale routing once already (`$JS.FC.>` was missing from the engine's
 * publish grants), and it would cost more here: a wedged channel watch is a survivor that has stopped
 * noticing stranded calls while every other signal says it is healthy.
 *
 * So the guard compares the bucket's `last_seq` with the highest revision this watch has delivered.
 * Wall-clock silence cannot tell a wedged iterator from a quiet cluster; `last_seq` can, because
 * every key in this bucket is a channel the watch's filter covers. Two consecutive probes seeing the
 * bucket ahead re-establish the watch — one recovery path, the same one a watch that ENDED takes —
 * and `settledRevision` stops a revision no watch can reach (a superseded, compacted-away write) from
 * re-creating it every probe for ever.
 */
@Injectable()
export class ChannelWatchService implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.channel-watch");
	private sink: ChannelWatchSink | undefined;
	private stopped = false;
	private watching = false;
	private stopWatch: (() => void) | undefined;
	private watchLoop: Promise<void> | undefined;
	private probeTimer: ReturnType<typeof setInterval> | undefined;

	/** The highest revision the CURRENT watch has delivered. Reset on every re-establish. */
	private watchRevision = 0;
	/** A bucket revision already judged unreachable, so it costs exactly one recovery. */
	private settledRevision = 0;
	private consecutiveBehindProbes = 0;
	private staleRecoveries = 0;
	private adoptions = 0;
	private lastEntryAt: number | undefined;
	/** Serialises the contests so a burst of entries cannot fan out onto the connection at once. */
	private work: Promise<void> = Promise.resolve();

	constructor(
		private readonly jetstream: JetStreamService,
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
	) {}

	setSink(sink: ChannelWatchSink): void {
		this.sink = sink;
	}

	get isWatching(): boolean {
		return this.watching;
	}

	get staleRecoveryCount(): number {
		return this.staleRecoveries;
	}

	get adoptedCount(): number {
		return this.adoptions;
	}

	get lastEntryTimestamp(): number | undefined {
		return this.lastEntryAt;
	}

	start(): void {
		if (this.stopped || this.watchLoop !== undefined) {
			return;
		}
		if (this.sink === undefined) {
			throw new Error("ChannelWatchService.start() called before its sink was set.");
		}
		this.watchLoop = this.runWatchLoop();
		this.probeTimer = setInterval(() => {
			void this.probe();
		}, this.env.ENGINE_ROUTING_WATCH_PROBE_MS);
		this.probeTimer.unref?.();
	}

	/** Settles every contest this watch has started. For the drain and the tests. */
	async awaitWork(): Promise<void> {
		await this.work;
	}

	/**
	 * One stale-guard probe. Exported for the tests and driven by the probe timer.
	 *
	 * Two consecutive probes seeing the bucket ahead of the watch, rather than one, because a write
	 * genuinely in flight when the first probe runs is not a stall.
	 */
	async probe(): Promise<void> {
		const bucket = this.jetstream.channels;
		if (this.stopped || bucket === undefined || !this.watching) {
			return;
		}
		let bucketRevision: number;
		try {
			bucketRevision = (await bucket.status()).streamInfo.state.last_seq;
		} catch (error) {
			this.logger.debug({ err: String(error) }, "could not probe the channels bucket revision");
			return;
		}
		if (bucketRevision <= this.watchRevision || bucketRevision <= this.settledRevision) {
			this.consecutiveBehindProbes = 0;
			return;
		}
		this.consecutiveBehindProbes += 1;
		if (this.consecutiveBehindProbes < 2) {
			return;
		}
		this.consecutiveBehindProbes = 0;
		this.settledRevision = bucketRevision;
		this.staleRecoveries += 1;
		this.logger.warn(
			{ bucketRevision, watchRevision: this.watchRevision, staleRecoveries: this.staleRecoveries },
			"the channels watch is alive but behind the bucket; re-establishing it. If this repeats, " +
				"check the engine's NATS publish grant for `$JS.FC.>` — a refused flow-control reply " +
				"stops delivery silently.",
		);
		this.stopWatch?.();
	}

	private applyEntry(key: string, operation: string, value: Uint8Array, revision: number): void {
		this.watchRevision = Math.max(this.watchRevision, revision);
		this.lastEntryAt = Date.now();
		if (operation !== "PUT" || value.length === 0) {
			// A delete is a leg that ENDED. Its owner cleared it, and there is nothing to adopt.
			return;
		}
		let snapshot: ChannelSnapshot;
		try {
			snapshot = JSON.parse(decoder.decode(value)) as ChannelSnapshot;
		} catch (error) {
			this.logger.warn({ key, err: String(error) }, "ignoring an unreadable channel snapshot");
			return;
		}
		const ownership = channelOwnershipOf(snapshot);
		if (ownership?.instanceId === this.env.ENGINE_INSTANCE_ID) {
			// Our own write, echoed back. Every renewal of every channel we hold comes through here.
			return;
		}
		if (ownership !== undefined && ownership.expiresAt > Date.now()) {
			// A live replica's, on the evidence available here. A peer that has actually DIED is
			// handled by `EngineLivenessService`, which has the evidence this path does not.
			return;
		}
		this.contest(snapshot);
	}

	private contest(snapshot: ChannelSnapshot): void {
		this.work = this.work
			.catch(() => undefined)
			.then(async () => {
				if (this.stopped) {
					return;
				}
				if (await this.sink?.adoptOrphanedChannel(snapshot, Date.now())) {
					this.adoptions += 1;
					this.logger.info(
						{
							callId: snapshot.callId,
							channelId: snapshot.channelId,
							organizationId: snapshot.organizationId,
						},
						"adopted an unowned channel the channels watch reported",
					);
				}
			})
			.catch((error: unknown) => {
				this.logger.error(
					{ channelId: snapshot.channelId, err: String(error) },
					"failed to contest an unowned channel",
				);
			});
	}

	/** Set while the loop is in a backoff, so a shutdown can end it immediately. */
	private wakeSleep: (() => void) | undefined;

	private async runWatchLoop(): Promise<void> {
		let attempt = 0;
		while (!this.stopped) {
			const bucket = this.jetstream.channels;
			if (bucket === undefined) {
				await this.sleep(backoffMs(attempt));
				attempt += 1;
				continue;
			}
			try {
				const watch = await bucket.watch();
				this.stopWatch = () => {
					watch.stop();
				};
				if (this.stopped) {
					// Shut down while `watch()` was in flight. Without this the loop falls into a
					// `for await` on a subscription nothing will ever stop, and shutdown hangs.
					watch.stop();
					return;
				}
				// A new watch replays the bucket from its newest value per key, so nothing it has
				// delivered so far constrains what the guard may conclude about this one.
				this.watchRevision = 0;
				this.consecutiveBehindProbes = 0;
				this.watching = true;
				attempt = 0;
				this.logger.info("watching the channels KV bucket for stranded calls");
				for await (const entry of watch) {
					if (this.stopped) {
						break;
					}
					this.applyEntry(entry.key, entry.operation, entry.value, entry.revision);
				}
			} catch (error) {
				if (!this.stopped) {
					this.logger.warn({ err: String(error) }, "the channels watch ended; re-establishing it");
				}
			}
			this.watching = false;
			this.stopWatch = undefined;
			if (this.stopped) {
				return;
			}
			await this.sleep(backoffMs(attempt));
			attempt += 1;
		}
	}

	/**
	 * A backoff that a shutdown can cut short.
	 *
	 * Plain `setTimeout` here made a stop during the backoff — or during the moment before the first
	 * `watch()` resolves — block shutdown for the whole interval, up to thirty seconds, because the
	 * stop has no subscription to cancel and the loop is not looking at `stopped`.
	 */
	private async sleep(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			timer.unref?.();
			this.wakeSleep = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.wakeSleep = undefined;
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.probeTimer !== undefined) {
			clearInterval(this.probeTimer);
			this.probeTimer = undefined;
		}
		this.stopWatch?.();
		this.wakeSleep?.();
		await this.watchLoop;
		this.watchLoop = undefined;
		await this.work.catch(() => undefined);
	}
}
