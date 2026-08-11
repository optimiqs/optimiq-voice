/**
 * A fixed-window counter per organization, for `POST /api/v1/calls`.
 *
 * ## What this is, stated plainly
 *
 * **Single-instance**, exactly like `provisioning/render/provision-rate-limit.ts`: the counters live
 * in this process's heap, so three API replicas behind a load balancer allow three times the
 * configured rate. That is a real limitation and it is written here rather than discovered later.
 * The Redis-backed version slots in behind the same one-method interface.
 *
 * It is a near-copy of the provisioning limiter rather than a shared class, and the reason is that
 * the two are the same MECHANISM guarding different things: that one is keyed by a provisioning
 * token reference and exists to blunt a leaked URL being fetched in a loop, while this one is keyed
 * by a tenant and exists to bound what a compromised API key can spend. Promoting one of them into
 * `shared/` would couple a working module's blast radius to this feature's, for forty lines.
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

interface Window {
	resetAt: number;
	count: number;
}

const WINDOW_MS = 60_000;

/**
 * How many idle counters may accumulate before a sweep runs.
 *
 * Swept on write rather than on a timer, so the cost is paid by the traffic that caused it and an
 * idle process holds no interval. The same arrangement, and the same threshold, as the provisioning
 * limiter — one entry per organization means this is a ceiling nothing realistic reaches.
 */
const SWEEP_THRESHOLD = 4_096;

export interface OriginateRateVerdict {
	readonly allowed: boolean;
	readonly remaining: number;
	/** Seconds until the window resets — what a `Retry-After` carries. */
	readonly retryAfterSeconds: number;
}

export class OriginateRateLimiter {
	private readonly windows = new Map<string, Window>();

	constructor(private readonly limitPerMinute: number) {}

	/** Records one attempt against `organizationId` and says whether it is allowed. */
	consume(organizationId: string, now: number = Date.now()): OriginateRateVerdict {
		if (this.limitPerMinute <= 0) {
			// `0` disables the limit, for a deployment that bounds origination somewhere else.
			return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
		}
		if (this.windows.size >= SWEEP_THRESHOLD) {
			this.sweep(now);
		}
		const existing = this.windows.get(organizationId);
		const window =
			existing === undefined || existing.resetAt <= now
				? { resetAt: now + WINDOW_MS, count: 0 }
				: existing;
		window.count += 1;
		this.windows.set(organizationId, window);
		return {
			allowed: window.count <= this.limitPerMinute,
			remaining: Math.max(0, this.limitPerMinute - window.count),
			retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
		};
	}

	/** Test seam: forgets everything. Never called from a request path. */
	reset(): void {
		this.windows.clear();
	}

	get size(): number {
		return this.windows.size;
	}

	private sweep(now: number): void {
		for (const [key, window] of this.windows) {
			if (window.resetAt <= now) {
				this.windows.delete(key);
			}
		}
	}
}
