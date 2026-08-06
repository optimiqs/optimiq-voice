/**
 * The retry policy, isolated so it is testable without a socket.
 *
 * ## What is retried, and what is deliberately not
 *
 * Retrying is only safe when the request either did not happen or is idempotent. So:
 *
 * - **429** — always retried. The carrier is explicitly telling us to come back.
 * - **5xx** — retried, *unless the request opted out*. See below.
 * - **transport failure** (no response at all) — same rule.
 * - **4xx other than 429** — never retried. A 422 is a statement about the request; sending it
 *   again produces the same 422 and burns the budget the ambiguous cases need.
 *
 * ## The opt-out, and why it is not a footnote
 *
 * Telnyx supports `Idempotency-Key` on exactly seven endpoints, all of them email or storage —
 * **not** on `/number_orders`, `/phone_numbers`, `/credential_connections` or
 * `/outbound_voice_profiles` (verified against the OpenAPI spec; see `reference/telnyx-api.md`
 * §Idempotency). That is a hard constraint, not an oversight we can work around with a header.
 *
 * It means an automatic retry of `POST /number_orders` after a timeout can order — and bill — the
 * same DID twice, because the first attempt may well have succeeded on the far side of a socket
 * that died before the response came back. So requests that create billable resources set
 * `retryable: false` and reconcile explicitly instead: the order carries a `customer_reference`
 * we generate, and the caller looks the order up by that reference before deciding to try again.
 * `resources/number-orders.ts` implements that; this module just refuses to guess on its behalf.
 *
 * ## Why the delay is jittered
 *
 * A platform-wide token means every organization's traffic shares one rate-limit bucket. Without
 * jitter, a burst that gets 429'd retries in lockstep and re-creates the burst that caused it —
 * the classic thundering herd, and the reason echoing the carrier's own reset hint is not enough
 * on its own. Full jitter (uniform over `[0, backoff]`) is used rather than equal jitter because
 * it minimizes expected contention for the same expected wait, and because "sometimes retry almost
 * immediately" is the right behaviour when the limit has already cleared.
 *
 * ## There is no `Retry-After`
 *
 * Telnyx does not send one on 429 — it sends `x-ratelimit-reset`, seconds until the window rolls
 * over, and tells clients to use exponential backoff. That value is respected as a FLOOR rather
 * than as the delay: waiting anywhere in `[reset, reset + backoff]` obeys the carrier and still
 * de-synchronizes the herd. `Retry-After` is parsed too, for free, so a future change on their
 * side is honoured rather than ignored.
 */

export interface RetryPolicy {
	/** Total attempts including the first. `1` disables retrying. */
	readonly maxAttempts: number;
	/** Delay before the first retry, doubled each time. */
	readonly baseDelayMs: number;
	/** Ceiling for the doubling, before jitter and before any `Retry-After` floor. */
	readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 4,
	baseDelayMs: 250,
	maxDelayMs: 8_000,
};

/** Whether a completed response is worth another attempt. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * Milliseconds to wait before attempt `attempt + 1`.
 *
 * @param attempt zero-based index of the attempt that just failed.
 * @param retryAfterMs the carrier's `Retry-After`, already in milliseconds, when it sent one.
 * @param random injected so the spec can pin the jitter; defaults to `Math.random`.
 */
export function backoffDelayMs(
	policy: RetryPolicy,
	attempt: number,
	retryAfterMs: number | undefined,
	random: () => number = Math.random,
): number {
	const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
	// Full jitter: uniform over [0, exponential]. See the header for why this and not equal jitter.
	const jittered = Math.round(exponential * random());
	return (retryAfterMs ?? 0) + jittered;
}

/**
 * `Retry-After` in milliseconds, or `undefined` when the header is absent or unusable.
 *
 * The header is defined as either delta-seconds or an HTTP-date. Telnyx sends neither today, but
 * both are handled because a client that only understands one silently ignores the other, which
 * turns a polite carrier instruction into a retry storm.
 */
export function parseRetryAfterMs(
	value: string | null,
	now: number = Date.now(),
): number | undefined {
	if (value === null) {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
	}
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) {
		return undefined;
	}
	return Math.max(0, date - now);
}

/**
 * `x-ratelimit-reset` in milliseconds — seconds until the sliding window rolls over.
 *
 * Explicitly NOT a Unix epoch, despite one Telnyx doc page printing an epoch in its example: the
 * live API returns small integers like `1`, and reading that as an epoch would compute a delay of
 * roughly fifty-five years. Values large enough to be an epoch are therefore rejected rather than
 * used, so a future change in their encoding degrades to plain backoff instead of a hung process.
 */
const MAX_PLAUSIBLE_RESET_SECONDS = 3_600;

export function parseRateLimitResetMs(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+(?:\.\d+)?$/u.test(trimmed)) {
		return undefined;
	}
	const seconds = Number(trimmed);
	if (!Number.isFinite(seconds) || seconds > MAX_PLAUSIBLE_RESET_SECONDS) {
		return undefined;
	}
	return Math.max(0, Math.round(seconds * 1000));
}

/** `setTimeout` as a promise, with the same signature the client injects in tests. */
export async function sleep(milliseconds: number): Promise<void> {
	if (milliseconds <= 0) {
		return;
	}
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}
