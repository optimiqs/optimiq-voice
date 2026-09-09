import { getLogger } from "@optimiq-voice/logging";
import { attachUpgradeHandler } from "../core/http/upgrade-router";
import { LiveGateway } from "./live-gateway";
import { LIVE_PATH } from "./live-protocol";
import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

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
 * ## The gateway does not consume upgrades it does not own
 *
 * `handleUpgrade` returns `false` without touching the socket when the path is not
 * {@link LIVE_PATH}, so a future feature that wants that path can claim it. Destroying an upgrade
 * NOBODY claims is `attachUpgradeHandler`'s job — Node will not do it once a listener exists.
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

	attachUpgradeHandler(server, (request, socket, head) =>
		gateway.handleUpgrade(request, socket, head),
	);

	gateway.start();
	logger.info(`live WebSocket channel serving ${LIVE_PATH}`);
	await Promise.resolve();
	return true;
}
