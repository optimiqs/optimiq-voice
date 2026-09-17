import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { isSipInstanceLeaseExpired, sipInstanceLeaseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { InstanceLivenessWatcher } from "../nats/instance-liveness.watcher";
import { JetStreamService } from "../nats/jetstream.service";
import type { SipInstanceLease } from "@optimiq-voice/events";

export { INSTANCE_LEASE_SWEEP_INTERVAL_MS as SIPD_LEASE_SWEEP_INTERVAL_MS } from "../nats/instance-liveness.watcher";

/**
 * Watches the `sip-instances` bucket and reports a `sipd` that stopped renewing its lease.
 *
 * ## The failure this exists for
 *
 * A `sipd` that is SIGKILLed takes every dialog it held with it — sockets, transaction state and
 * CSeq are all local to that process, so nothing can fail them over. What must not also be lost is
 * the ENGINE's knowledge that those calls ended. Without it the media keeps flowing through
 * `mediad` (correctly: `mediad` does not need `sipd`), the engine holds the channels forever, no CDR
 * is written, and the phone's own BYE is answered `481` by whatever process replaced the dead one.
 * A live, silent, unbillable, un-endable call.
 *
 * `apps/sipd`'s own reaper covers the case where a SURVIVING instance sweeps a dead peer's dialog
 * claims. This service covers the case that reaper structurally cannot: a single-instance edge,
 * which is every developer stack and every small deployment, where there is no survivor.
 *
 * The watch, the sweep and the report-once rule live in {@link InstanceLivenessWatcher}, which
 * `engine-instances` uses too — the two buckets record the same fact about two planes, and the only
 * thing that differs is the verdict a loss drives. See that class for why each half is there.
 */
@Injectable()
export class SipdLivenessService implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.sipd-liveness");
	private listener: ((instanceId: string, lease: SipInstanceLease) => void) | undefined;
	private readonly watcher = new InstanceLivenessWatcher<SipInstanceLease>({
		bucketName: "sip-instances",
		subject: "a sip edge",
		logger: this.logger,
		bucket: () => this.jetstream.sipInstances,
		parse: (raw) => sipInstanceLeaseSchema.parse(raw),
		isExpired: isSipInstanceLeaseExpired,
		onLost: (instanceId, lease) => {
			this.logger.warn({ instanceId }, "ending the legs the dead sip edge held");
			this.listener?.(instanceId, lease);
		},
	});

	constructor(private readonly jetstream: JetStreamService) {}

	/**
	 * Registers the sink for instance losses. Must be called before {@link start}.
	 *
	 * The listener is called ONCE per lost instance, on the engine's own timers rather than inside a
	 * watch iteration, and must not throw: a throw here would end the watch that is the only thing
	 * watching the signalling plane.
	 */
	setInstanceLostHandler(handler: (instanceId: string, lease: SipInstanceLease) => void): void {
		this.listener = handler;
	}

	get isWatching(): boolean {
		return this.watcher.isWatching;
	}

	/** The instances currently holding a live lease, for `/healthz`. */
	get liveInstances(): readonly string[] {
		return this.watcher.liveInstances;
	}

	/** How many instance losses this process has reported. `/healthz` and the tests read it. */
	get lostCount(): number {
		return this.watcher.lostCount;
	}

	/** Starts the watch and the expiry sweep. Idempotent. */
	start(): void {
		if (this.listener === undefined) {
			throw new Error(
				"SipdLivenessService.start() called before an instance-lost handler was set.",
			);
		}
		this.watcher.start();
	}

	/** Reports every instance whose lease has lapsed at `now`. Driven by the sweep timer. */
	sweep(now: number): void {
		this.watcher.sweep(now);
	}

	async onApplicationShutdown(): Promise<void> {
		await this.watcher.stop();
	}
}
