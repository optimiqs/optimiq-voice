import type { PinoLogger } from "@optimiq-voice/logging";
import type { KV } from "nats";

/** How often the known leases are re-checked for expiry, independently of the watch. */
export const INSTANCE_LEASE_SWEEP_INTERVAL_MS = 2_000;

/** Backoff for a watch that ended, capped so a long broker outage still retries every 30 s. */
function backoffMs(attempt: number): number {
	return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
}

/** The shape every instance lease shares: the key, repeated, and the horizon it is good for. */
export interface InstanceLease {
	readonly instanceId: string;
	readonly renewedAt: number;
	readonly expiresAt: number;
}

export interface InstanceLivenessOptions<T extends InstanceLease> {
	/** Bucket name, for the log lines only — the bucket itself comes from {@link bucket}. */
	readonly bucketName: string;
	/** What one key is, in the operator's words: "a sip edge", "an engine replica". */
	readonly subject: string;
	readonly logger: PinoLogger;
	/** Late-bound: the KV view does not exist until `JetStreamService` has connected. */
	readonly bucket: () => KV | undefined;
	readonly parse: (raw: unknown) => T;
	readonly isExpired: (lease: T, now: number) => boolean;
	/** Called ONCE per lost instance. Must not throw; a throw is caught and logged regardless. */
	readonly onLost: (instanceId: string, lease: T, why: string) => void;
	/**
	 * This process's own instance id, when it is also a WRITER of this bucket.
	 *
	 * Only the engine bucket needs it, and it is not cosmetic: a replica that reported its own lapsed
	 * lease would run the peer-death path against itself and contest every channel it already owns.
	 */
	readonly selfInstanceId?: string;
	readonly sweepIntervalMs?: number;
}

/**
 * Watches one instance-lease KV bucket and reports a process that stopped renewing.
 *
 * ## The failure this exists for
 *
 * Two planes, two buckets, one shape. `sip-instances` says which `apps/sipd` processes are alive, so
 * the engine can END the legs of an edge that died — a dialog lives in one process and cannot be
 * re-homed. `engine-instances` says which engine replicas are alive, so a survivor can ADOPT a dead
 * replica's channels — nothing about a channel is bound to the process that held it. Opposite
 * verdicts, identical evidence, and the machinery for gathering that evidence is what this class is.
 *
 * ## Why a watch AND a timer
 *
 * The bucket's TTL is the lease, so the server publishes a delete when an instance stops renewing —
 * that is the fast path and it is usually the only one that fires. The sweep is the honest backstop:
 * a watch that silently ended, a purge notification the client never delivered, or a lease written
 * with an expiry already in the past all leave a dead instance looking alive, and this class's whole
 * purpose is to be the thing that notices. Two seconds against a fifteen-second lease.
 *
 * ## Why an instance is reported once
 *
 * The listener ends legs and writes CDRs on one plane, and contests ownership on the other. Reporting
 * the same death every sweep would refile the first and re-contest the second. An instance is
 * forgotten as soon as it is reported, and re-learned only from a fresh PUT — which is exactly what a
 * restarted process, with a new instance id or the same one, does.
 */
export class InstanceLivenessWatcher<T extends InstanceLease> {
	/** Instance id → the newest lease seen for it. Instances reported lost are dropped. */
	private readonly leases = new Map<string, T>();
	private stopped = false;
	private watching = false;
	private stopWatch: (() => void) | undefined;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;
	private watchLoop: Promise<void> | undefined;
	private lostReported = 0;

	constructor(private readonly options: InstanceLivenessOptions<T>) {}

	get isWatching(): boolean {
		return this.watching;
	}

	/** The instances currently holding a live lease, for `/healthz`. */
	get liveInstances(): readonly string[] {
		return [...this.leases.keys()].sort();
	}

	/** How many instance losses this process has reported. `/healthz` and the tests read it. */
	get lostCount(): number {
		return this.lostReported;
	}

	/** Starts the watch and the expiry sweep. Idempotent. */
	start(): void {
		if (this.stopped || this.watchLoop !== undefined) {
			return;
		}
		this.watchLoop = this.runWatchLoop();
		this.sweepTimer = setInterval(() => {
			this.sweep(Date.now());
		}, this.options.sweepIntervalMs ?? INSTANCE_LEASE_SWEEP_INTERVAL_MS);
		this.sweepTimer.unref?.();
	}

	/**
	 * Reports every instance whose lease has lapsed at `now`. Exported for the tests and driven by
	 * the sweep timer; safe to call at any time.
	 */
	sweep(now: number): void {
		for (const [instanceId, lease] of this.leases) {
			if (this.options.isExpired(lease, now)) {
				this.reportLost(instanceId, lease, "the lease expired");
			}
		}
	}

	private reportLost(instanceId: string, lease: T, why: string): void {
		// Dropped BEFORE the listener runs, so a listener that acts synchronously cannot see this
		// instance again and repeat whatever it did.
		this.leases.delete(instanceId);
		this.lostReported += 1;
		this.options.logger.warn(
			{ instanceId, why, renewedAt: lease.renewedAt, expiresAt: lease.expiresAt },
			`${this.options.subject} stopped renewing its liveness lease`,
		);
		try {
			this.options.onLost(instanceId, lease, why);
		} catch (error) {
			this.options.logger.error(
				{ instanceId, err: String(error) },
				"the instance-lost handler threw; the watch continues",
			);
		}
	}

	private applyEntry(key: string, operation: string, value: Uint8Array): void {
		if (key === this.options.selfInstanceId) {
			// Our own lease, echoed back by our own watch. See `selfInstanceId`.
			return;
		}
		if (operation !== "PUT" || value.length === 0) {
			const lease = this.leases.get(key);
			if (lease !== undefined) {
				// A DEL is a graceful shutdown; a PURGE is the bucket TTL expiring the key. Both mean
				// the instance is gone, and both arrive faster than the sweep would find it.
				this.reportLost(
					key,
					lease,
					operation === "DEL" ? "the lease was released" : "the lease TTL expired",
				);
			}
			return;
		}
		let parsed: T;
		try {
			parsed = this.options.parse(JSON.parse(new TextDecoder().decode(value)));
		} catch (error) {
			this.options.logger.warn(
				{ key, err: String(error) },
				`ignoring an unreadable ${this.options.bucketName} lease`,
			);
			return;
		}
		if (parsed.instanceId !== key) {
			// The key IS the instance id by contract. A value that disagrees cannot be attributed, and
			// acting on it would end or adopt another instance's calls.
			this.options.logger.warn(
				{ key, instanceId: parsed.instanceId },
				`ignoring a ${this.options.bucketName} lease whose value names a different instance`,
			);
			return;
		}
		const known = this.leases.has(key);
		this.leases.set(key, parsed);
		if (!known) {
			this.options.logger.info(
				{ instanceId: key, expiresAt: parsed.expiresAt },
				`${this.options.subject} is live`,
			);
		}
	}

	/** Set while the loop is in a backoff, so a shutdown can end it immediately. */
	private wakeSleep: (() => void) | undefined;

	private async runWatchLoop(): Promise<void> {
		let attempt = 0;
		while (!this.stopped) {
			const bucket = this.options.bucket();
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
				this.watching = true;
				attempt = 0;
				this.options.logger.info(
					`watching the ${this.options.bucketName} KV bucket for instance liveness`,
				);
				for await (const entry of watch) {
					if (this.stopped) {
						break;
					}
					this.applyEntry(entry.key, entry.operation, entry.value);
				}
			} catch (error) {
				if (!this.stopped) {
					this.options.logger.warn(
						{ err: String(error) },
						`the ${this.options.bucketName} watch ended; re-establishing it`,
					);
				}
			}
			this.watching = false;
			this.stopWatch = undefined;
			// Everything this process believes about its peers came from a feed it is no longer on.
			// The leases are KEPT rather than cleared, deliberately: dropping them would silently stop
			// this watcher reporting anything, while the sweep on their own `expiresAt` still reaches
			// the right verdict from the last value each instance published.
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

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
		this.stopWatch?.();
		this.wakeSleep?.();
		await this.watchLoop;
		this.watchLoop = undefined;
	}
}
