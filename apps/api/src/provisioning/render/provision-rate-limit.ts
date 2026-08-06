/**
 * A fixed-window counter per token reference.
 *
 * ## What this is, stated plainly
 *
 * **Single-instance.** The counters live in this process's heap. A deployment running three API
 * replicas behind a load balancer therefore allows three times the configured rate, because each
 * replica counts only what it saw. That is a real limitation and it is written here rather than
 * discovered later.
 *
 * It is still worth having. The thing this stops is a leaked provisioning URL being fetched in a
 * loop — a scraper, a misconfigured phone in a reboot cycle, someone walking a token space — and a
 * limit that is 3x looser than intended still stops all three. What it is NOT is a defence against
 * a distributed attacker with a valid token, and nothing at this layer would be: the answer to a
 * leaked token is rotation, which is a button on the device.
 *
 * The Redis-backed version is a follow-up and slots in behind the same two-method interface.
 *
 * ## Why the key is the token REFERENCE and not the source address
 *
 * Phones behind one NAT share a source address — an office of forty handsets rebooting after a
 * power cut is forty requests from one IP in a few seconds, and a per-IP limit would refuse most of
 * them. The reference identifies the device, which is the thing whose fetch rate is bounded by
 * physics. A request carrying an unknown reference never allocates a counter at all (see
 * `provision.service.ts`: the limiter is consulted AFTER the reference resolves), so an attacker
 * enumerating references cannot use this to exhaust memory.
 */

interface Window {
	/** Epoch milliseconds at which this window's count resets. */
	resetAt: number;
	count: number;
}

export interface RateLimitVerdict {
	readonly allowed: boolean;
	/** Requests still available in the current window. */
	readonly remaining: number;
	/** Seconds until the window resets — what a `Retry-After` header carries. */
	readonly retryAfterSeconds: number;
}

const WINDOW_MS = 60_000;

/**
 * How many idle counters may accumulate before a sweep runs.
 *
 * A `Map` that only ever grows is a leak with a slow fuse. Sweeping on write — rather than on a
 * timer — means the cost is paid by the traffic that caused it and there is no interval keeping a
 * process alive at shutdown.
 */
const SWEEP_THRESHOLD = 4_096;

export class ProvisioningRateLimiter {
	private readonly windows = new Map<string, Window>();

	constructor(private readonly limitPerMinute: number) {}

	/** Records one attempt against `key` and says whether it is allowed. */
	consume(key: string, now: number = Date.now()): RateLimitVerdict {
		if (this.windows.size >= SWEEP_THRESHOLD) {
			this.sweep(now);
		}

		const existing = this.windows.get(key);
		const window =
			existing === undefined || existing.resetAt <= now
				? { resetAt: now + WINDOW_MS, count: 0 }
				: existing;
		window.count += 1;
		this.windows.set(key, window);

		const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
		return {
			allowed: window.count <= this.limitPerMinute,
			remaining: Math.max(0, this.limitPerMinute - window.count),
			retryAfterSeconds,
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
