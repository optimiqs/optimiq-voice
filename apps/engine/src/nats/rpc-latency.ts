/**
 * How long the engine waits on the other planes, kept per operation and reported on `/healthz`.
 *
 * Every step of a call setup that is not a routing decision is a round trip to `apps/sipd` or
 * `apps/mediad`, and the engine's own CPU profile cannot see any of it — a process waiting on a
 * reply is a process at 95 % idle. Without this, "setup-to-ring got slower" has three candidate
 * owners and no evidence separating them; with it, an operator reads which plane is slow off the
 * same endpoint that already says whether it is reachable.
 *
 * ## Why buckets rather than samples
 *
 * A reservoir of raw samples is a per-call allocation on the hottest path in the process, and its
 * percentiles are only as honest as its sampling. Fixed logarithmic buckets cost one integer
 * increment per call, are exact about which decade a latency fell in, and cannot grow — which
 * matters more than a percentile precise to the millisecond on a number whose job is to say
 * "the media plane is answering in tens of milliseconds, not hundreds".
 */

/** Upper bounds in milliseconds. The last bucket is everything slower, including timeouts. */
const BUCKET_BOUNDS: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000];

export class RpcLatency {
	private readonly operations = new Map<string, OperationCounters>();

	/**
	 * Records one completed round trip.
	 *
	 * `failed` counts the calls that produced no usable reply — a timeout, `no responders`, or a
	 * reply that is not the contract. They are counted separately AND folded into the latency,
	 * because a timeout is the slowest possible answer and hiding it would make a plane that has
	 * stopped answering look faster than one that is merely busy.
	 */
	record(operation: string, milliseconds: number, failed = false): void {
		let counters = this.operations.get(operation);
		if (counters === undefined) {
			counters = {
				count: 0,
				failed: 0,
				max: 0,
				buckets: new Array<number>(BUCKET_BOUNDS.length + 1).fill(0),
			};
			this.operations.set(operation, counters);
		}
		counters.count += 1;
		if (failed) {
			counters.failed += 1;
		}
		if (milliseconds > counters.max) {
			counters.max = Math.round(milliseconds);
		}
		let index = BUCKET_BOUNDS.length;
		for (let bound = 0; bound < BUCKET_BOUNDS.length; bound += 1) {
			if (milliseconds <= (BUCKET_BOUNDS[bound] ?? 0)) {
				index = bound;
				break;
			}
		}
		counters.buckets[index] = (counters.buckets[index] ?? 0) + 1;
	}

	/** Per operation, since boot. Monotonic counters plus the bucketed percentiles. */
	get snapshot(): Record<string, RpcLatencyReport> {
		const report: Record<string, RpcLatencyReport> = {};
		for (const [operation, counters] of this.operations) {
			report[operation] = {
				count: counters.count,
				failed: counters.failed,
				p50: percentile(counters, 0.5),
				p99: percentile(counters, 0.99),
				maxMs: counters.max,
			};
		}
		return report;
	}
}

/**
 * The upper bound of the bucket the requested quantile falls in, in milliseconds. `-1` means slower
 * than the last bound — a decade the buckets deliberately do not resolve, because anything past
 * five seconds on these subjects is an outage rather than a latency.
 */
function percentile(counters: OperationCounters, quantile: number): number {
	const target = counters.count * quantile;
	let seen = 0;
	for (let index = 0; index < counters.buckets.length; index += 1) {
		seen += counters.buckets[index] ?? 0;
		if (seen >= target) {
			return index < BUCKET_BOUNDS.length ? (BUCKET_BOUNDS[index] ?? -1) : -1;
		}
	}
	return -1;
}

interface OperationCounters {
	count: number;
	failed: number;
	max: number;
	readonly buckets: number[];
}

export interface RpcLatencyReport {
	readonly count: number;
	readonly failed: number;
	/** The bucket bound the median fell at or under, in milliseconds. `-1` is "slower than 5 s". */
	readonly p50: number;
	readonly p99: number;
	readonly maxMs: number;
}
