import { getLogger } from "@optimiq-voice/logging";
import { LiveGateway } from "./live-gateway";
import { LIVE_PATH } from "./live-protocol";
import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

const logger = getLogger("api.live");

/**
 * Attaches the live WebSocket gateway to the HTTP server's `upgrade` event.
 *
 * ## Why here and not in a Nest adapter
 *
 * `app.getHttpAdapter().getHttpServer()` is the Node `http.Server` Fastify is listening on, and an
 * `upgrade` listener on it runs before Fastify's router sees anything — which is exactly what a
 * WebSocket handshake needs, because a handshake is not a request Fastify can route. Mirrors
 * `registerAuthTransport`: raw transport wiring, done after `NestFactory.create` (so the container
 * can build the gateway) and before `listen` (so the listener exists when the first client arrives).
 *
 * ## The listener does not consume upgrades it does not own
 *
 * `handleUpgrade` returns without touching the socket when the path is not {@link LIVE_PATH}. Node
 * destroys an upgrade nothing answered, which is the correct default; a gateway that destroyed
 * every upgrade it saw would break any future feature that wants one.
 */
export async function registerLiveTransport(app: INestApplication): Promise<boolean> {
	const gateway = app.get(LiveGateway);
	const server = app.getHttpAdapter().getHttpServer() as Server;
	if (typeof server?.on !== "function") {
		logger.warn(
			"the HTTP server does not accept upgrade listeners — the live channel is not mounted",
		);
		return false;
	}

	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		// The handler is async because session resolution is; the event is not. A rejection here
		// would be unhandled and would take the process down, so it is caught and the socket is
		// closed — an upgrade that failed for an unexpected reason must not be left half-open.
		void gateway.handleUpgrade(request, socket, head).catch((error) => {
			logger.error({ err: error }, "a live upgrade failed");
			socket.destroy();
		});
	});

	gateway.start();
	logger.info(`live WebSocket channel serving ${LIVE_PATH}`);
	await Promise.resolve();
	return true;
}
