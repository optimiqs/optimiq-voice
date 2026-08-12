import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV } from "../nats/nats.tokens";
import { ConferenceRegistry } from "./conference-registry";
import { ParkRegistry } from "./park-registry";
import type { EngineEnv } from "../config/engine-env";

/**
 * Binds the shared claim buckets to the park and conference registries, and keeps this instance's
 * claims alive.
 *
 * ## Why `onApplicationBootstrap` and not `onModuleInit`
 *
 * The buckets do not exist until `JetStreamService.onModuleInit` has connected and opened the views.
 * Nest runs every `onModuleInit` before any `onApplicationBootstrap`, so this is the earliest hook
 * at which the buckets are guaranteed to be there — and binding early matters: a call parked in the
 * window before the bind would take a LOCAL claim in a clustered deployment, which is the split the
 * buckets exist to prevent.
 *
 * ## Why the heartbeat is a process-wide timer and not per claim
 *
 * A timer per parked call is a timer per parked call, and a busy tenant parks a lot of them. One
 * tick that renews everything this instance holds is a handful of KV writes on a schedule, and — far
 * more importantly — it is ONE thing to reason about when a claim goes stale, rather than N timers
 * that may each have been cancelled by a different code path.
 *
 * ## What a failed tick means, and what it deliberately does not do
 *
 * Nothing dramatic. Three heartbeat opportunities occur strictly before lease expiry so a broker
 * blip does not cost a tenant an orbit that is holding a live caller; a failed tick logs and the
 * next one succeeds.
 * The registries own the interesting half — a park claim another instance has taken over is DROPPED
 * locally rather than fought for, and a conference claim another participant's instance renewed
 * first is simply adopted — see their own `heartbeat` methods for why those two differ.
 */
@Injectable()
export class ClaimHeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly logger = getLogger("engine.claims");
	private timer: ReturnType<typeof setInterval> | undefined;
	private activeTick: Promise<void> | undefined;
	private ticks = 0;
	private failures = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
		private readonly parks: ParkRegistry,
		private readonly conferences: ConferenceRegistry,
	) {}

	/** What `/healthz` reports about the claim plane. */
	get stats(): {
		readonly shared: boolean;
		readonly ticks: number;
		readonly failures: number;
	} {
		return { shared: this.parks.isShared, ticks: this.ticks, failures: this.failures };
	}

	onApplicationBootstrap(): void {
		const instanceId = this.env.ENGINE_INSTANCE_ID;
		this.parks.bindClaims(this.jetstream.parkClaims, instanceId);
		this.conferences.bindClaims(this.jetstream.conferenceClaims, instanceId);

		if (!this.parks.isShared) {
			// No bucket configured: a single-instance deployment, by choice. No timer, no round trips,
			// and the registries behave exactly as they did before claims existed.
			this.logger.info(
				{ instanceId },
				"park and conference claims are local to this process; no shared claim bucket is configured",
			);
			return;
		}

		this.logger.info(
			{ instanceId, intervalMs: this.env.ENGINE_CLAIM_HEARTBEAT_MS },
			"park and conference claims are shared; starting the heartbeat",
		);
		this.timer = setInterval(() => {
			void this.tick();
		}, this.env.ENGINE_CLAIM_HEARTBEAT_MS);
		this.timer.unref?.();
	}

	onApplicationShutdown(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** One renewal pass. Overlapping timer and explicit calls share the pass already in flight. */
	tick(): Promise<void> {
		if (this.activeTick !== undefined) {
			return this.activeTick;
		}

		const activeTick = this.runTick();
		this.activeTick = activeTick;
		void activeTick.finally(() => {
			if (this.activeTick === activeTick) {
				this.activeTick = undefined;
			}
		});
		return activeTick;
	}

	private async runTick(): Promise<void> {
		this.ticks += 1;
		try {
			await this.parks.heartbeat();
			await this.conferences.heartbeat();
		} catch (error) {
			// A throw here would come from the broker client, and an unhandled one on an interval takes
			// the process down mid-shift. The lease outlives several missed ticks by design.
			this.failures += 1;
			this.logger.warn({ err: String(error) }, "a claim heartbeat tick failed");
		}
	}
}
