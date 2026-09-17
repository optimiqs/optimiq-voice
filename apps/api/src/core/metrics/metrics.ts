import { collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

/**
 * The API's Prometheus registry.
 *
 * ## A module singleton rather than a Nest provider
 *
 * Every other cross-cutting concern in this app is a provider, and this one deliberately is not.
 * The two places that must reach it are `main.ts`'s Fastify hook — which runs before any module is
 * resolved and has no injector — and the private listener, which must come up whether or not the
 * PBX and CDR areas mounted. A provider would mean an injector lookup from `main.ts` and a module
 * every optional area had to import in order to publish one gauge. The registry is a bag of
 * counters with no dependencies and no lifecycle, so a singleton is what it actually is.
 *
 * The consequence to know about: this module must be imported exactly once per process, which ESM
 * guarantees, and a test that wants a clean registry calls {@link resetMetricsForTest}.
 */
export const metricsRegistry = new Registry();

collectDefaultMetrics({
	register: metricsRegistry,
	// Event-loop lag is the single most useful number this process produces: `E2E-load.md` found
	// the engine pegged at one core with no way to see it coming, and the API has the same shape.
	eventLoopMonitoringPrecision: 10,
});

/**
 * HTTP latency, labelled by the ROUTE PATTERN rather than the URL.
 *
 * `/api/v1/extensions/:id` is one series; `/api/v1/extensions/01a087…` would be one series per
 * extension per status, which is how a metrics endpoint takes a process down. Fastify hands the
 * pattern back on `request.routeOptions.url`, and a request that matched no route reports
 * `unmatched` — a 404 flood must not be able to invent labels either.
 */
export const httpRequestDuration = new Histogram({
	name: "api_http_request_duration_seconds",
	help: "HTTP request latency, by method, matched route pattern and status class.",
	labelNames: ["method", "route", "status"],
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
	registers: [metricsRegistry],
});

/** Observes one finished request. `route` must be a pattern, never a URL. */
export function observeHttpRequest(
	method: string,
	route: string | undefined,
	statusCode: number,
	seconds: number,
): void {
	httpRequestDuration.observe(
		{
			method: method.toUpperCase(),
			route: route ?? "unmatched",
			// The class, not the code: a 4xx bucket per endpoint is the operational question, and
			// the exact code is in the logs beside the request that produced it.
			status: `${String(Math.floor(statusCode / 100))}xx`,
		},
		seconds,
	);
}

/**
 * Publishes a gauge whose value is read at scrape time.
 *
 * The read runs on the scrape request, so it must be synchronous and cheap — a `Set.size`, a
 * counter field. Anything that touches the network belongs in {@link registerAsyncGauge}.
 *
 * Idempotent by name: an area that mounts twice (a test harness building two applications in one
 * process) replaces its gauge rather than throwing on the duplicate, which would take the whole
 * boot down for a metric.
 */
export function registerGauge(
	name: string,
	help: string,
	read: () => number,
	labelNames: readonly string[] = [],
): void {
	replaceExisting(name);
	new Gauge({
		name,
		help,
		labelNames: [...labelNames],
		registers: [metricsRegistry],
		collect(this: Gauge<string>) {
			this.set(read());
		},
	});
}

/**
 * Publishes a set of gauges filled by an asynchronous read at scrape time — a JetStream consumer
 * info call, say.
 *
 * `collect` is awaited by prom-client, so a read that hangs hangs the scrape; the caller is
 * responsible for its own timeout. A read that THROWS is swallowed: a broker that is momentarily
 * unreachable must degrade to a stale series, not to a 500 that makes the whole endpoint useless
 * at exactly the moment somebody is looking at it.
 */
export function registerAsyncGauge(
	name: string,
	help: string,
	labelNames: readonly string[],
	read: (set: (labels: Record<string, string>, value: number) => void) => Promise<void>,
): void {
	replaceExisting(name);
	new Gauge({
		name,
		help,
		labelNames: [...labelNames],
		registers: [metricsRegistry],
		async collect(this: Gauge<string>) {
			try {
				await read((labels, value) => {
					this.set(labels, value);
				});
			} catch {
				// Deliberately silent: this runs once per scrape interval, and logging a broker
				// outage fifteen times a minute from the metrics path is its own incident.
			}
		},
	});
}

function replaceExisting(name: string): void {
	if (metricsRegistry.getSingleMetric(name) !== undefined) {
		metricsRegistry.removeSingleMetric(name);
	}
}

/** Clears every metric. For tests that assert a scrape from a known starting point. */
export function resetMetricsForTest(): void {
	metricsRegistry.resetMetrics();
}
