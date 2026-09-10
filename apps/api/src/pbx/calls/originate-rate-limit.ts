/**
 * A fixed-window counter per organization, for `POST /api/v1/calls`.
 *
 * ## Where the count lives
 *
 * In `shared_rate_window`, through {@link SharedRateWindowService} — **not** in this process's heap.
 * It used to be the latter, and this file said so: three API replicas behind a load balancer allowed
 * three times the configured rate. What this limiter bounds is money, so a ceiling an operator
 * multiplies by accident every time they scale out was not a limitation to write down, it was a
 * defect. The counter is now one row per organization per minute, incremented under the row lock, so
 * the ceiling means the same thing at any replica count.
 *
 * The store may be unreachable. When it is, the verdict is ALLOW: a database fault must not stop a
 * tenant placing calls, and the failure mode this limiter exists to prevent — a compromised key
 * dialling in a loop — is not made likelier by a query timing out. That is a deliberate fail-open
 * and is the one behaviour here worth arguing with.
 *
 * ## Why the key is the ORGANIZATION and not the user or the extension
 *
 * Because the thing being bounded is money. A compromised API key holds `calls.originate` for a
 * whole tenant and can rotate the extension it dials from on every request, so a per-extension
 * counter would be a limit an attacker steps around by counting to ten. The tenant is the billing
 * boundary, so the tenant is the counter.
 *
 * The cost is stated too: one enthusiastic user can exhaust the window for their colleagues. At the
 * default that means sixty calls a minute from one organization, which is well above any human dial
 * button and well below anything worth a carrier invoice.
 */

import { getLogger } from "@optimiq-voice/logging";
import type { SharedRateWindowService, SharedRateWindowState } from "../shared/shared-rate-window";

const logger = getLogger("api.pbx");

const WINDOW_MS = 60_000;

export interface OriginateRateVerdict {
	readonly allowed: boolean;
	readonly remaining: number;
	/** Seconds until the window resets — what a `Retry-After` carries. */
	readonly retryAfterSeconds: number;
}

/** The meter name this limiter's rows are filed under in `shared_rate_window`. */
export const ORIGINATE_RATE_SCOPE = "originate";

export class OriginateRateLimiter {
	constructor(
		private readonly limitPerMinute: number,
		private readonly windows: SharedRateWindowService,
	) {}

	/** Records one attempt against `organizationId` and says whether it is allowed. */
	async consume(organizationId: string, now: Date = new Date()): Promise<OriginateRateVerdict> {
		if (this.limitPerMinute <= 0) {
			// `0` disables the limit, for a deployment that bounds origination somewhere else.
			return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
		}
		let state: SharedRateWindowState;
		try {
			state = await this.windows.consume({
				organizationId,
				scope: ORIGINATE_RATE_SCOPE,
				key: organizationId,
				windowMs: WINDOW_MS,
				increment: 1,
				now,
			});
		} catch (error) {
			// Fail open, loudly. See the note at the top of this file.
			logger.error({ organizationId, error }, "the origination rate limiter could not count");
			return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
		}
		return {
			allowed: state.count <= this.limitPerMinute,
			remaining: Math.max(0, this.limitPerMinute - state.count),
			retryAfterSeconds: Math.max(
				1,
				Math.ceil((state.windowResetAt.getTime() - now.getTime()) / 1000),
			),
		};
	}
}
