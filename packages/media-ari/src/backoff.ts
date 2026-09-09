/**
 * Reconnect backoff — pure, so the reconnect policy can be asserted without a socket or a clock.
 */

export interface BackoffOptions {
	/** Delay before the first retry. */
	readonly baseMs: number;
	/** Multiplier per attempt. */
	readonly factor: number;
	/** Ceiling, before jitter. */
	readonly maxMs: number;
	/**
	 * Fraction of the computed delay that is randomised, in `[0, 1]`.
	 *
	 * This is not a nicety. When a media server restarts, every engine instance loses its socket in
	 * the same millisecond; with a deterministic backoff they all reconnect in the same millisecond
	 * too, and the thundering herd knocks the freshly-started Asterisk over again. `0.5` spreads
	 * the herd across half the window.
	 */
	readonly jitter: number;
	/**
	 * How many reconnect attempts before the stream gives up, or `undefined` for "never".
	 *
	 * `undefined` is the default and is a deliberate choice rather than an omission: for telephony,
	 * a media server that comes back after an hour should find the engine still trying. A caller
	 * that would rather fail its health check than retry a permanently-wrong credential forever
	 * sets this, and gets a terminal error and a `closed` status when it is reached.
	 */
	readonly maxAttempts?: number;
}

/** The policy the ARI event stream uses unless a caller overrides it. */
export const DEFAULT_BACKOFF: BackoffOptions = {
	baseMs: 250,
	factor: 2,
	maxMs: 30_000,
	jitter: 0.5,
};

/**
 * Delay before retry number `attempt` (1-based), with jitter applied.
 *
 * `random` is injected rather than read from `Math.random` so a spec can pin the exact value; it
 * must return a number in `[0, 1)`.
 */
export function computeBackoffDelayMs(
	attempt: number,
	options: BackoffOptions = DEFAULT_BACKOFF,
	random: () => number = Math.random,
): number {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new RangeError(`attempt must be an integer >= 1, received ${String(attempt)}`);
	}

	const exponential = options.baseMs * options.factor ** (attempt - 1);
	const capped = Math.min(exponential, options.maxMs);
	const jitterSpan = capped * options.jitter;
	// The jitter is subtracted, never added: the cap is a real ceiling, so a retry never waits
	// longer than `maxMs` no matter how many attempts have accumulated.
	return Math.round(capped - jitterSpan * random());
}
