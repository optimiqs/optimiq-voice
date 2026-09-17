import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { startMetricsServer, type MetricsServer } from "./metrics-server";

/**
 * The private listener.
 *
 * Its whole job is to be uninteresting: one route, everything else a 404, and a failure to bind
 * that is logged and survived rather than thrown. The last case is the one that matters
 * operationally — `EADDRINUSE` on a telemetry port must never stop an engine that can carry calls.
 */

const started: MetricsServer[] = [];

async function start(address: string): Promise<MetricsServer | undefined> {
	const server = await startMetricsServer(address);
	if (server !== undefined) {
		started.push(server);
	}
	return server;
}

afterEach(async () => {
	for (const server of started.splice(0)) {
		await server.close();
	}
});

describe("the metrics listener", () => {
	it("serves the registry on /metrics as text", async () => {
		// Port 0: the kernel picks, so a suite running beside another cannot race a fixed number.
		const server = await start("127.0.0.1:0");
		expect(server).toBeDefined();

		const response = await fetch(`http://${server?.address ?? ""}/metrics`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toContain("engine_nodejs_eventloop_lag_seconds");
	});

	it("answers 404 on any other path or method", async () => {
		const server = await start("127.0.0.1:0");
		const base = `http://${server?.address ?? ""}`;

		expect((await fetch(`${base}/`)).status).toBe(404);
		expect((await fetch(`${base}/healthz`)).status).toBe(404);
		expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(404);
		// A query string is a scraper's business and must not turn the one route into a 404.
		expect((await fetch(`${base}/metrics?x=1`)).status).toBe(200);
	});

	it("is off when the address is empty", async () => {
		expect(await start("")).toBeUndefined();
	});

	it("is off, and does not throw, when the address is not host:port", async () => {
		expect(await start("9201")).toBeUndefined();
		expect(await start("127.0.0.1:not-a-port")).toBeUndefined();
	});

	it("survives a port that is already taken rather than failing the boot", async () => {
		const squatter = createServer();
		await new Promise<void>((resolve) => {
			squatter.listen(0, "127.0.0.1", () => {
				resolve();
			});
		});
		const taken = squatter.address();
		const port = taken !== null && typeof taken === "object" ? taken.port : 0;

		expect(await start(`127.0.0.1:${String(port)}`)).toBeUndefined();

		await new Promise<void>((resolve) => {
			squatter.close(() => {
				resolve();
			});
		});
	});
});
