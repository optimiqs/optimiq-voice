import { getLogger } from "@optimiq-voice/logging";
import { attachUpgradeHandler } from "../core/http/upgrade-router";
import { SessionGateway } from "./session-gateway";
import { SESSION_PATH } from "./session-protocol";
import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

const logger = getLogger("api.session");

/**
 * Attaches the session-protocol gateway to the HTTP server's `upgrade` event.
 *
 * The same wiring `registerLiveTransport` performs, for the same reason and at the same point in
 * boot — after `NestFactory.create` so the container can build the gateway, before `listen` so the
 * listener exists when the first client arrives.
 *
 * ## Two gateways on one event, and how that is made safe
 *
 * Both gateways register a claim with `attachUpgradeHandler`, which installs ONE `upgrade` listener
 * and offers each handshake to the claims in turn. Neither gateway destroys an upgrade it does not
 * recognise — it returns `false` so the next claim sees it — and the router destroys what nobody
 * claims, which Node itself stops doing the moment any `upgrade` listener exists.
 */
export async function registerSessionTransport(app: INestApplication): Promise<boolean> {
	const gateway = app.get(SessionGateway);
	const server = app.getHttpAdapter().getHttpServer() as Server;
	if (typeof server?.on !== "function") {
		logger.warn(
			"the HTTP server does not accept upgrade listeners — the session protocol is not mounted",
		);
		return false;
	}

	attachUpgradeHandler(server, (request, socket, head) =>
		gateway.handleUpgrade(request, socket, head),
	);

	gateway.start();
	logger.info(`session-protocol WebSocket serving ${SESSION_PATH}`);
	await Promise.resolve();
	return true;
}
