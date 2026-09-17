import { expect } from "chai";
import {
	metricsRegistry,
	observeHttpRequest,
	registerAsyncGauge,
	registerGauge,
	resetMetricsForTest,
} from "../../src/core/metrics/metrics";
import { metricsListenAddress, startMetricsServer } from "../../src/core/metrics/metrics-server";

/**
 * The API's Prometheus surface.
 *
 * The cases that matter are all about the two ways a metrics endpoint takes a process down: an
 * unbounded label set, and a scrape that can throw.
 */
describe("api metrics", () => {
	beforeEach(() => {
		resetMetricsForTest();
	});

	it("labels a request by its route PATTERN and status class, never by URL or code", async () => {
		observeHttpRequest("get", "/api/v1/extensions/:id", 200, 0.012);
		observeHttpRequest("GET", "/api/v1/extensions/:id", 404, 0.003);

		const body = await metricsRegistry.metrics();

		expect(body).to.include('route="/api/v1/extensions/:id"');
		expect(body).to.include('status="2xx"');
		expect(body).to.include('status="4xx"');
		// The exact code would multiply the series count for no operational question.
		expect(body).to.not.include('status="404"');
		// Upper-cased, so `get` and `GET` are one series rather than two.
		expect(body).to.not.include('method="get"');
	});

	it("labels an unmatched request as `unmatched`, so a 404 flood cannot invent labels", async () => {
		observeHttpRequest("POST", undefined, 404, 0.001);

		expect(await metricsRegistry.metrics()).to.include('route="unmatched"');
	});

	it("carries the Node runtime collectors", async () => {
		const body = await metricsRegistry.metrics();

		expect(body).to.include("process_cpu_seconds_total");
		expect(body).to.include("nodejs_eventloop_lag_seconds");
	});

	it("reads a registered gauge at scrape time", async () => {
		let connections = 3;
		registerGauge("api_test_clients", "Clients.", () => connections);

		expect(await metricsRegistry.metrics()).to.include("api_test_clients 3");
		connections = 9;
		expect(await metricsRegistry.metrics()).to.include("api_test_clients 9");
	});

	it("replaces a gauge registered twice under the same name rather than throwing", () => {
		registerGauge("api_test_duplicate", "First.", () => 1);
		expect(() => {
			registerGauge("api_test_duplicate", "Second.", () => 2);
		}).to.not.throw();
	});

	it("keeps serving when an async gauge's read fails", async () => {
		registerGauge("api_test_healthy", "Still here.", () => 42);
		registerAsyncGauge("api_test_broken", "Never answers.", [], async () => {
			await Promise.resolve();
			throw new Error("the broker is unreachable");
		});

		const body = await metricsRegistry.metrics();

		expect(body).to.include("api_test_healthy 42");
	});
});

describe("api metrics listener", () => {
	it("defaults to loopback, off the public port", () => {
		expect(metricsListenAddress({} as NodeJS.ProcessEnv)).to.equal("127.0.0.1:9200");
	});

	it("is disabled by an empty address", async () => {
		expect(await startMetricsServer({ API_METRICS_ADDR: "" } as NodeJS.ProcessEnv)).to.equal(
			undefined,
		);
	});

	it("refuses a malformed address rather than binding something unintended", async () => {
		expect(await startMetricsServer({ API_METRICS_ADDR: "9200" } as NodeJS.ProcessEnv)).to.equal(
			undefined,
		);
		expect(
			await startMetricsServer({ API_METRICS_ADDR: "127.0.0.1:nope" } as NodeJS.ProcessEnv),
		).to.equal(undefined);
	});

	it("serves /metrics and 404s everything else", async () => {
		const server = await startMetricsServer({
			API_METRICS_ADDR: "127.0.0.1:0",
		} as NodeJS.ProcessEnv);
		expect(server).to.not.equal(undefined);
		try {
			// Port 0 asks the kernel for a free port, so the address to fetch is the bound one.
			const bound = server?.address ?? "";
			const port = bound.slice(bound.lastIndexOf(":") + 1);
			const scrape = await fetch(`http://127.0.0.1:${port}/metrics`);
			expect(scrape.status).to.equal(200);
			expect(scrape.headers.get("content-type")).to.include("text/plain");
			expect(await scrape.text()).to.include("process_cpu_seconds_total");

			expect((await fetch(`http://127.0.0.1:${port}/`)).status).to.equal(404);
			expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).to.equal(
				404,
			);
		} finally {
			await server?.close();
		}
	});
});
