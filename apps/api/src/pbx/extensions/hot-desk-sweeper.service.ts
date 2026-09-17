import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import { HotDeskService } from "./hot-desk.service";
import type { PbxEnv } from "../shared/pbx-env";

const logger = getLogger("api.pbx");

/**
 * The other half of a hot-desk session: the end of it that nobody dialled.
 *
 * `*32` is the fast path and handles every agent who remembers. This exists for the one who does
 * not — and that is not a rare case, it is the ordinary end of a shift. Without it, an agent who
 * goes home leaves their extension bound to a desk in an empty room: their calls ring there all
 * night, their own phone is unreachable, and the only recovery is an administrator editing a device
 * line by hand.
 *
 * ## The expiry is a COLUMN, and this is only a reconcile
 *
 * `device_line.hot_desk_expires_at` is durable, so the session's end does not depend on this process
 * being alive when it arrives. A control plane that restarts mid-shift picks up exactly the same
 * backlog on its next tick, and a deployment that runs two replicas gets the same answer from both:
 * `HotDeskService.restore` is idempotent — it clears `home_extension_id` in the same write that
 * restores the binding, so the second replica's pass finds nothing left to do.
 *
 * That idempotence is why there is no lease and no worker id here, which is the argument
 * `projection-outbox.service.ts` makes at length and which does transfer: the work is a
 * compare-and-clear, not a paid external call, so two processes doing it write the same bytes.
 *
 * ## Batched, and deliberately not drained in one tick
 *
 * Each pass restores at most {@link SWEEP_BATCH} lines. Every restore is a repository write, which
 * means a transaction, an audit row and a compile-on-write per line, and a deployment that turned
 * hot desking on for a thousand desks would otherwise recompile a thousand artifacts in one
 * synchronous burst at 18:00. The remainder is picked up on the next tick, which is a minute away.
 */
const SWEEP_BATCH = 50;

@Injectable()
export class HotDeskSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private restored = 0;
	private failed = 0;

	/**
	 * Tokens spelled out for every parameter, including the plain class.
	 *
	 * The area runs under `tsx`/esbuild, which does not emit `design:paramtypes`, so Nest has no type
	 * metadata to resolve a bare class parameter from and injects `undefined` — a `TypeError` on
	 * first use rather than a wiring error at boot. `ProjectionOutboxSweeper` records the same reason.
	 */
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(HotDeskService) private readonly hotDesk: HotDeskService,
	) {}

	get stats(): {
		readonly swept: number;
		readonly restored: number;
		readonly failed: number;
	} {
		return { swept: this.swept, restored: this.restored, failed: this.failed };
	}

	onModuleInit(): void {
		const intervalMs = this.env.PBX_HOT_DESK_SWEEP_INTERVAL_MS;
		if (intervalMs === 0) {
			logger.warn(
				"PBX_HOT_DESK_SWEEP_INTERVAL_MS is 0 — hot-desk sessions expire in the column and are " +
					"never restored by this process. A handset whose agent did not dial the logout code " +
					"keeps their extension until somebody else sweeps or an administrator intervenes.",
			);
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished — a
		// verification script that boots the module and exits must exit.
		this.timer = setInterval(() => {
			void this.sweep();
		}, intervalMs);
		this.timer.unref?.();
		logger.info(
			{ intervalMs, sessionSeconds: this.env.PBX_HOT_DESK_SESSION_SECONDS },
			"hot-desk session sweeper started",
		);
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass. Exported for the spec and for a verification script; the timer is the only caller in
	 * production.
	 *
	 * Re-entrancy is refused rather than queued: a pass that overran its interval is a pass whose
	 * database is slow, and starting a second one on top of it is how a slow control plane becomes a
	 * stopped one.
	 */
	async sweep(): Promise<{ readonly restored: number; readonly failed: number }> {
		if (this.running || this.stopped) {
			return { restored: 0, failed: 0 };
		}
		this.running = true;
		let restored = 0;
		let failed = 0;
		try {
			const lapsed = await this.hotDesk.lapsedSessions(new Date(), SWEEP_BATCH);
			for (const session of lapsed) {
				if (this.stopped) {
					break;
				}
				const number = await this.hotDesk.restore(
					session.organizationId,
					session.line,
					// A different actor ref from the star code's, and that is the point of the ledger row:
					// "this agent logged out" and "this session lapsed" are different facts to whoever
					// reads the audit trail afterwards.
					"api.hot-desk-sweeper",
				);
				if (number === undefined) {
					failed += 1;
					continue;
				}
				restored += 1;
				logger.info(
					{
						organizationId: session.organizationId,
						deviceId: session.line.deviceId,
						lineId: session.line.id,
						extensionNumber: number,
					},
					"a lapsed hot-desk session was restored to its home binding",
				);
			}
		} catch (error) {
			// A sweep that throws must not kill the timer: the next tick is a minute away and the
			// backlog is still in the column.
			logger.error({ error }, "the hot-desk sweep failed");
			failed += 1;
		} finally {
			this.running = false;
			this.swept += 1;
			this.restored += restored;
			this.failed += failed;
		}
		return { restored, failed };
	}
}
