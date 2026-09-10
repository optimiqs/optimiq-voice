import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";

/**
 * The engine's Prometheus registry.
 *
 * ## A module singleton rather than a Nest provider
 *
 * The same decision, for the same reason, as `apps/api/src/core/metrics/metrics.ts`: the private
 * listener is started from `main.ts` before any injector exists and must come up whether or not
 * every feature module resolved. The registry is a bag of counters with no dependencies and no
 * lifecycle, so a singleton is what it actually is. `EngineMetrics` is the provider that FILLS it,
 * because the values it publishes live on injected services.
 *
 * The consequence to know about: this module must be imported exactly once per process, which ESM
 * guarantees, and a test that wants a clean registry calls {@link resetMetricsForTest}.
 *
 * ## Why almost everything here is a scrape-time gauge
 *
 * The engine already counts what matters — active channels, adoptions, stale-watch recoveries, RPC
 * round trips — because `/healthz` reports all of it. Instrumenting the hot path a second time
 * would add atomics to a call setup in order to learn a number the process already knows. So the
 * gauges READ those counters when a scraper asks, and the only thing on the call path that this
 * file adds is nothing at all.
 */
export const metricsRegistry = new Registry();

collectDefaultMetrics({
	register: metricsRegistry,
	prefix: "engine_",
	// The single most useful number this process produces: the engine's ceiling is ONE thread, and
	// `E2E-load.md` found it pegged at one core with nothing that saw it coming. `EventLoopLagMonitor`
	// answers the same question on `/healthz` in rolling windows; this is the aggregatable form.
	eventLoopMonitoringPrecision: 10,
});

/**
 * Publishes a gauge whose value is read at scrape time.
 *
 * The read runs on the scrape request, so it must be synchronous and cheap — a `Map.size`, a
 * counter field, a getter that returns one. Anything that touches the network does not belong here:
 * the engine has one thread and a scrape must never be able to hold it.
 *
 * A read that THROWS is swallowed and leaves the previous value standing. A provider that is
 * mid-shutdown must not turn the whole scrape into a 500 at exactly the moment somebody is looking
 * at it.
 *
 * Idempotent by name: a harness that builds two applications in one process replaces its gauge
 * rather than throwing on the duplicate, which would take a boot down for a metric.
 */
export function registerGauge(name: string, help: string, read: () => number): void {
	replaceExisting(name);
	new Gauge({
		name,
		help,
		registers: [metricsRegistry],
		collect(this: Gauge<string>) {
			try {
				this.set(read());
			} catch {
				// Deliberately silent; see the note above.
			}
		},
	});
}

/**
 * Publishes a labelled gauge filled by a scrape-time read that may emit any number of series.
 *
 * The caller decides the label values, so it also owns the cardinality: every `set` here must come
 * from a CLOSED vocabulary — a refusal reason, an RPC operation name, a plane — never a leg id, a
 * channel id or an extension number. `reset()` runs first so a series whose source has gone away
 * disappears instead of freezing at its last value.
 */
export function registerLabelledGauge(
	name: string,
	help: string,
	labelNames: readonly string[],
	read: (set: (labels: Record<string, string>, value: number) => void) => void,
): void {
	replaceExisting(name);
	new Gauge({
		name,
		help,
		labelNames: [...labelNames],
		registers: [metricsRegistry],
		collect(this: Gauge<string>) {
			try {
				this.reset();
				read((labels, value) => {
					this.set(labels, value);
				});
			} catch {
				// Deliberately silent; see `registerGauge`.
			}
		},
	});
}

/**
 * Publishes a monotonic counter whose value is read at scrape time.
 *
 * Prometheus draws a counter and a gauge differently — `rate()` on a gauge is meaningless — and
 * every number this file reads off `/healthz`'s counters is genuinely monotonic, so it is declared
 * as one. `Counter` has no setter, so the value is applied as a delta against what was last
 * published; a source that went BACKWARDS (a service replaced under a test harness) is treated as a
 * reset and skipped rather than made to count down, which a counter cannot do.
 */
export function registerCounter(name: string, help: string, read: () => number): void {
	replaceExisting(name);
	let published = 0;
	const counter = new Counter({
		name,
		help,
		registers: [metricsRegistry],
		collect() {
			try {
				const current = read();
				if (current > published) {
					counter.inc(current - published);
					published = current;
				}
			} catch {
				// Deliberately silent; see `registerGauge`.
			}
		},
	});
}

/** The same, labelled. The cardinality rule of {@link registerLabelledGauge} applies unchanged. */
export function registerLabelledCounter(
	name: string,
	help: string,
	labelNames: readonly string[],
	read: (set: (labels: Record<string, string>, value: number) => void) => void,
): void {
	replaceExisting(name);
	const published = new Map<string, number>();
	const counter = new Counter({
		name,
		help,
		labelNames: [...labelNames],
		registers: [metricsRegistry],
		collect() {
			try {
				read((labels, value) => {
					const key = JSON.stringify(labels);
					const last = published.get(key) ?? 0;
					if (value > last) {
						counter.inc(labels, value - last);
						published.set(key, value);
					} else if (last > 0 && value === 0) {
						// A source that reset to zero: publish nothing further rather than counting
						// down, and start the next delta from zero so it is counted from the reset.
						published.set(key, 0);
					}
				});
			} catch {
				// Deliberately silent; see `registerGauge`.
			}
		},
	});
}

function replaceExisting(name: string): void {
	if (metricsRegistry.getSingleMetric(name) !== undefined) {
		metricsRegistry.removeSingleMetric(name);
	}
}

/**
 * Zeroes every metric. For tests that assert a scrape from a known starting point.
 *
 * Deliberately `resetMetrics` and not `clear`: the default collectors are attached once at module
 * load and cannot be re-attached, so a test that cleared the registry would take the process
 * metrics out of every scrape that followed it in the same run.
 */
export function resetMetricsForTest(): void {
	metricsRegistry.resetMetrics();
}
