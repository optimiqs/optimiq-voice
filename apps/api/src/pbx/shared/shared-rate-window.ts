import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lte, sharedRateWindow, sql } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "./pbx.tokens";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * A counter every replica of this control plane agrees on.
 *
 * ## The thing it replaces
 *
 * The obvious rate limiter is a `Map` in the process, and this codebase has one — the originate
 * limiter's own header says three replicas allow three times the rate. For a burst guard that is a
 * defensible trade. For a SPEND cap it is not: the traffic being capped is spread across replicas by
 * the same load balancer that spreads everyone else's, so the effective ceiling is the configured
 * one times a number that changes when somebody scales the deployment, and a ceiling nobody can
 * state is a ceiling nobody budgeted.
 *
 * ## One statement, no read-then-write
 *
 * ```sql
 * insert into shared_rate_window (…, count) values (…, $increment)
 * on conflict (organization_id, scope, key, window_start)
 * do update set count = shared_rate_window.count + excluded.count, updated_at = now()
 * returning count
 * ```
 *
 * That is atomic without a transaction of its own, and it returns the POST-increment total — so the
 * caller learns whether it crossed the line in the same round trip that recorded that it did. A
 * read-then-write would leave a window in which two replicas both read 49 of 50 and both proceed,
 * which is exactly the shape `OrgLimitsService` documents as an acceptable overshoot for a
 * commercial quota and is NOT acceptable for a fraud control: the overshoot is per concurrent
 * request, and an attacker chooses the concurrency.
 *
 * Under contention this QUEUES on the row lock rather than retrying. That is the property that made
 * a table win over NATS KV, whose increment is a compare-and-set retry loop whose retry rate rises
 * with exactly the traffic the counter exists to limit.
 *
 * ## Fixed windows, and what {@link SharedRateWindowService.rolling} does about them
 *
 * `windowStart` is the caller's instant floored to the window width, so a row's key is a pure
 * function of the clock. The artefact is the usual one: a caller can spend a window's budget at the
 * end of one and again at the start of the next, giving a worst case of twice the ceiling across a
 * window boundary. {@link SharedRateWindowService.rolling} reads the PREVIOUS window too and weights
 * it by how far into the current one we are, which is the standard approximation and is bounded by
 * one window in either direction. The exact alternative is a row per event and an aggregate over a
 * time predicate, which is a scan of the busiest table on the platform on every outbound dial.
 *
 * ## It is not the enforcement
 *
 * This class counts. It never refuses: no ceiling reaches it, and it raises nothing. The decision
 * lives with whoever owns the ceiling — `evaluateTollFraud` for international spend — because a
 * counter that also judged would have to know every caller's policy, and two callers with different
 * policies would then fight over one class.
 */
@Injectable()
export class SharedRateWindowService {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	/**
	 * Adds `increment` to the window covering `now`, and returns the total after the add.
	 *
	 * `increment` may be negative — that is what makes this serve a gauge (an international leg goes
	 * up on answer and down on hangup) as well as a meter. The returned count is clamped at zero for
	 * the caller's benefit while the ROW is left as it is: a hangup whose answer this deployment
	 * never saw drives the stored value below zero, and clamping the row would make the gauge
	 * permanently high instead of self-correcting at the next window boundary. A gauge must fail in
	 * the direction that recovers.
	 *
	 * `expiresAt` is two windows past the end of this one, which is exactly what {@link rolling}
	 * needs to still find the previous window when it reads across a boundary.
	 */
	async consume(input: SharedRateWindowConsume): Promise<SharedRateWindowState> {
		const windowStart = floorToWindow(input.now, input.windowMs);
		const windowResetAt = new Date(windowStart.getTime() + input.windowMs);
		const expiresAt = new Date(windowStart.getTime() + input.windowMs * 3);
		const count = await this.database.withTenantScope(input.organizationId, async (transaction) => {
			const rows = await transaction
				.insert(sharedRateWindow)
				.values({
					organizationId: input.organizationId,
					scope: input.scope,
					key: input.key,
					windowStart,
					windowMs: input.windowMs,
					count: input.increment,
					expiresAt,
				} as never)
				.onConflictDoUpdate({
					target: [
						sharedRateWindow.organizationId,
						sharedRateWindow.scope,
						sharedRateWindow.key,
						sharedRateWindow.windowStart,
					],
					set: {
						// `excluded` rather than a parameter, so the increment travels once and the
						// statement stays a single round trip whatever the concurrency.
						count: sql`${sharedRateWindow.count} + excluded.${sql.raw("count")}`,
						// Pushed forward on every touch: a window that is still being written to is a
						// window the sweeper must not take, whatever it was worth when it was created.
						expiresAt,
						updatedAt: new Date(),
					},
				})
				.returning({ count: sharedRateWindow.count });
			return Number(rows[0]?.count ?? input.increment);
		});
		return { count: Math.max(0, count), windowResetAt, windowStart };
	}

	/** The current window's total, without touching it. Zero when there is no row. */
	async current(input: SharedRateWindowRead): Promise<number> {
		const windowStart = floorToWindow(input.now, input.windowMs);
		return await this.database.withTenantScope(input.organizationId, async (transaction) => {
			const rows = await transaction
				.select({ count: sharedRateWindow.count })
				.from(sharedRateWindow)
				.where(
					and(
						eq(sharedRateWindow.scope, input.scope),
						eq(sharedRateWindow.key, input.key),
						eq(sharedRateWindow.windowStart, windowStart),
					),
				)
				.limit(1);
			return Math.max(0, Number(rows[0]?.count ?? 0));
		});
	}

	/**
	 * The approximate total over the last `windowMs`, weighting the previous fixed window by the
	 * fraction of it the rolling window still covers.
	 *
	 * The standard sliding-window approximation, and the reason the fixed-window artefact does not
	 * make a spend cap useless: at ten seconds past the hour a caller who burnt the whole of the
	 * previous hour still reads as having burnt ~99% of it, so they cannot spend the budget twice
	 * across the boundary. It over-reports a burst that landed at the START of the previous window
	 * and under-reports one at its end, both by at most one window's worth — which is the trade the
	 * class header states.
	 *
	 * Two rows, one query, no aggregate: the pair is a two-row `in` on the unique index.
	 */
	async rolling(input: SharedRateWindowRead): Promise<number> {
		const windowStart = floorToWindow(input.now, input.windowMs);
		const previousStart = new Date(windowStart.getTime() - input.windowMs);
		const elapsed = input.now.getTime() - windowStart.getTime();
		const previousWeight = Math.max(0, 1 - elapsed / input.windowMs);
		return await this.database.withTenantScope(input.organizationId, async (transaction) => {
			const rows = await transaction
				.select({ windowStart: sharedRateWindow.windowStart, count: sharedRateWindow.count })
				.from(sharedRateWindow)
				.where(
					and(
						eq(sharedRateWindow.scope, input.scope),
						eq(sharedRateWindow.key, input.key),
						// `inArray` and not a hand-written `sql\`… in (…)\``: the template form binds the two
						// `Date`s as bare parameters with no column encoder behind them, and the driver
						// rejected the statement before it ever reached postgres — every call to the gate
						// failing open with a query error and no server-side log line to find it by.
						inArray(sharedRateWindow.windowStart, [windowStart, previousStart]),
					),
				);
			let total = 0;
			for (const row of rows) {
				const count = Math.max(0, Number(row.count));
				total +=
					row.windowStart.getTime() === windowStart.getTime() ? count : count * previousWeight;
			}
			return Math.round(total);
		});
	}

	/**
	 * Deletes this organization's expired windows. Returns how many rows went.
	 *
	 * Tenant-scoped rather than platform-wide, because every other write in this area is and because
	 * RLS would refuse an unscoped delete anyway. A caller that wants the whole platform swept runs
	 * this per organization — which is also the shape that keeps one enormous tenant from holding a
	 * lock while everybody else's rows wait behind it.
	 */
	async sweep(organizationId: string, now: Date): Promise<number> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.delete(sharedRateWindow)
				.where(lte(sharedRateWindow.expiresAt, now))
				.returning({ id: sharedRateWindow.id });
			return rows.length;
		});
	}
}

/** One increment. `increment` may be negative; see {@link SharedRateWindowService.consume}. */
export interface SharedRateWindowConsume {
	readonly organizationId: string;
	/** Which meter — `intl-minutes`, `intl-calls`, `originate`. */
	readonly scope: string;
	/** What within it. The tenant-wide convention is the organization's own id. */
	readonly key: string;
	readonly windowMs: number;
	readonly increment: number;
	readonly now: Date;
}

export interface SharedRateWindowRead {
	readonly organizationId: string;
	readonly scope: string;
	readonly key: string;
	readonly windowMs: number;
	readonly now: Date;
}

export interface SharedRateWindowState {
	/** The total after the increment, floored at zero. */
	readonly count: number;
	readonly windowStart: Date;
	/** When this window ends and the count starts again from nothing. */
	readonly windowResetAt: Date;
}

/**
 * The window an instant belongs to.
 *
 * Floored against the UNIX epoch rather than against local midnight or the caller's start time, so
 * every replica computes the same boundary from the clock alone without agreeing on anything first.
 * That is what lets the row key be derived rather than looked up.
 */
export function floorToWindow(now: Date, windowMs: number): Date {
	return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
