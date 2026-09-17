import { monitorEventLoopDelay } from "node:perf_hooks";
import {
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";

/** How long a reported window lasts before it is rolled over and the next one starts empty. */
const WINDOW_MS = 60_000;
/** The sampling resolution of the underlying libuv timer, in milliseconds. */
const RESOLUTION_MS = 10;

/**
 * The engine's event-loop delay, sampled and reported in rolling windows.
 *
 * The engine is the one process on this platform whose ceiling is a SINGLE thread: every routing
 * walk, every KV round trip's continuation and every event's handler run on it. `/healthz`
 * answering quickly proves the loop is turning, not that it is turning promptly — a loop 200 ms
 * behind still answers a probe in 200 ms, which reads as healthy and is the difference between a
 * caller hearing ringback in 50 ms and in half a second. `monitorEventLoopDelay` measures the gap
 * directly, in the libuv timer that a blocked loop delays.
 *
 * Two windows are kept and both are reported. The LIFETIME histogram is never reset, so a spike
 * that happened before anyone looked is still visible; the ROLLING one is rolled over every minute,
 * so an operator (or a load harness sampling once a second) sees what the loop is doing NOW rather
 * than an average diluted by every idle minute since boot. A rolled-over window is reported until
 * the next rollover replaces it, so a read always has a complete window to answer with rather than
 * a partial one that flatters a loop that has only just started to suffer.
 */
@Injectable()
export class EventLoopLagMonitor implements OnApplicationBootstrap, OnApplicationShutdown {
	private readonly lifetime = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
	private readonly rolling = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
	private lastWindow: EventLoopLagWindow | undefined;
	private rollover: NodeJS.Timeout | undefined;

	onApplicationBootstrap(): void {
		this.start();
	}

	onApplicationShutdown(): void {
		this.stop();
	}

	start(): void {
		if (this.rollover !== undefined) {
			return;
		}
		this.lifetime.enable();
		this.rolling.enable();
		this.rollover = setInterval(() => {
			this.lastWindow = summarize(this.rolling);
			this.rolling.reset();
		}, WINDOW_MS);
		// The process must not be held open by a metrics timer; a drain that has ended every call is
		// finished whether or not the next window has closed.
		this.rollover.unref();
	}

	stop(): void {
		if (this.rollover !== undefined) {
			clearInterval(this.rollover);
			this.rollover = undefined;
		}
		this.lifetime.disable();
		this.rolling.disable();
	}

	get report(): EventLoopLagReport {
		return {
			// The window in progress, not the last completed one: a caller reading this under load
			// wants the lag it is causing, and waiting up to a minute for it defeats the point.
			current: summarize(this.rolling),
			...(this.lastWindow === undefined ? {} : { lastWindow: this.lastWindow }),
			lifetime: summarize(this.lifetime),
		};
	}
}

/**
 * The histogram in milliseconds. `monitorEventLoopDelay` counts in NANOseconds, and its `min` on a
 * loop that has never been late is the resolution itself rather than zero, so every figure here is
 * the delay ON TOP of a sample interval — which is the number that means "the loop was busy".
 */
function summarize(histogram: ReturnType<typeof monitorEventLoopDelay>): EventLoopLagWindow {
	const ms = (nanoseconds: number): number =>
		Math.round(Math.max(0, nanoseconds / 1e6 - RESOLUTION_MS) * 100) / 100;
	return {
		samples: histogram.count,
		mean: Number.isNaN(histogram.mean) ? 0 : ms(histogram.mean),
		p50: ms(histogram.percentile(50)),
		p99: ms(histogram.percentile(99)),
		max: ms(histogram.max),
	};
}

export interface EventLoopLagWindow {
	readonly samples: number;
	/** Milliseconds of delay beyond the sampling interval. */
	readonly mean: number;
	readonly p50: number;
	readonly p99: number;
	readonly max: number;
}

export interface EventLoopLagReport {
	readonly current: EventLoopLagWindow;
	readonly lastWindow?: EventLoopLagWindow;
	readonly lifetime: EventLoopLagWindow;
}
