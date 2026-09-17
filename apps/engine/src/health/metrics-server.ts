import { createServer, type Server } from "node:http";
import { getLogger } from "@optimiq-voice/logging";
import { metricsRegistry } from "./metrics";

const logger = getLogger("engine.metrics");

/**
 * The scrape listener, on a socket of its own.
 *
 * ## Why not a route on the engine's HTTP port
 *
 * The engine's own port serves `/healthz`, which an orchestrator must reach; the scrape payload is
 * a different thing. Channel counts, refusal reasons and per-plane latency together describe a
 * deployment's call traffic closely enough to be reconnaissance, and it is the one endpoint here
 * whose cost grows with the fleet. Every other service in this deployment already serves telemetry
 * on a private listener the ingress does not publish — `apps/api`'s `API_METRICS_ADDR` and
 * `packages/runtime-go`'s health server — and this is the same decision in the same shape: a plain
 * `node:http` server rather than a second Fastify instance, because it has one route and no
 * middleware.
 *
 * It binds loopback by default. An operator whose scraper is on another host sets
 * `ENGINE_METRICS_ADDR` to a private interface; binding `0.0.0.0` is their explicit choice and the
 * boot log says which address was taken.
 */
export interface MetricsServer {
	readonly address: string;
	close(): Promise<void>;
}

/**
 * Starts the listener. An empty address disables it and returns undefined.
 *
 * A bind failure is NOT fatal, and that is the one judgement call here: `EADDRINUSE` on the metrics
 * port must not stop an engine that can otherwise carry calls. It is logged at error level with the
 * address, which is what an operator needs to fix it, and the process keeps its actual job.
 */
export async function startMetricsServer(address: string): Promise<MetricsServer | undefined> {
	if (address === "") {
		logger.info("the metrics listener is disabled (ENGINE_METRICS_ADDR is empty)");
		return undefined;
	}
	const separator = address.lastIndexOf(":");
	if (separator <= 0) {
		logger.error({ address }, "ENGINE_METRICS_ADDR is not host:port; the metrics listener is off");
		return undefined;
	}
	const host = address.slice(0, separator);
	const port = Number.parseInt(address.slice(separator + 1), 10);
	// Port 0 is allowed and means "any free port", which is how a test binds without racing another
	// suite for a fixed number. The bound port is reported on `address` and in the boot log.
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		logger.error({ address }, "ENGINE_METRICS_ADDR has no valid port; the metrics listener is off");
		return undefined;
	}

	const server = createServer((request, response) => {
		// One route. Everything else is 404 rather than a redirect or an index, so a scraper
		// misconfiguration is loud and nothing here can be probed for shape.
		if (request.method !== "GET" || (request.url ?? "").split("?")[0] !== "/metrics") {
			response.writeHead(404).end();
			return;
		}
		metricsRegistry
			.metrics()
			.then((body) => {
				response.writeHead(200, { "content-type": metricsRegistry.contentType }).end(body);
			})
			.catch((error: unknown) => {
				// A 500 rather than a partial body: a scrape that half-succeeds is silently wrong,
				// and only a failure is alertable.
				logger.error({ err: String(error) }, "a metrics scrape failed");
				response.writeHead(500).end();
			});
	});
	// A scraper that opens a connection and never sends anything must not hold a socket for ever.
	server.headersTimeout = 5_000;
	server.requestTimeout = 15_000;

	return await new Promise<MetricsServer | undefined>((resolve) => {
		server.once("error", (error: unknown) => {
			logger.error({ address, err: String(error) }, "the metrics listener could not bind");
			resolve(undefined);
		});
		server.listen(port, host, () => {
			// The BOUND address, not the requested one: port 0 asks the kernel to choose, and a log
			// line naming ":0" tells an operator nothing about where to point a scraper.
			const bound = server.address();
			const actual =
				bound !== null && typeof bound === "object" ? `${host}:${String(bound.port)}` : address;
			logger.info({ address: actual }, `metrics are served on http://${actual}/metrics`);
			resolve(closeable(server, actual));
		});
	});
}

function closeable(server: Server, address: string): MetricsServer {
	return {
		address,
		close: async () =>
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
				// Sockets a scraper is holding open with keep-alive would otherwise delay shutdown
				// past the orchestrator's patience for a listener nothing is waiting on.
				server.closeAllConnections();
			}),
	};
}
