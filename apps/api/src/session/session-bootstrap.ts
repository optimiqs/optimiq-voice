import { getLogger } from "@optimiq-voice/logging";
import { SessionGateway } from "./session-gateway";
import { SESSION_PATH } from "./session-protocol";
import type { INestApplication } from "@nestjs/common";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

const logger = getLogger("api.session");

/**
 * Attaches the session-protocol gateway to the HTTP server's `upgrade` event.
 *
 * The same wiring `registerLiveTransport` performs, for the same reason and at the same point in
 * boot — after `NestFactory.create` so the container can build the gateway, before `listen` so the
 * listener exists when the first client arrives.
 *
 * ## Two listeners on one event, and why that is safe
 *
 * Node emits `upgrade` to EVERY listener, and both gateways return without touching the socket when
 * the path is not theirs. That is what makes them composable, and it is why neither one destroys an
 * upgrade it does not recognise: Node destroys an upgrade nothing answered, which is the correct
 * default, and a gateway that pre-empted it would break whichever of the two was registered second.
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

	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		// The handler is async because session resolution is; the event is not. A rejection here would
		// be unhandled and would take the process down.
		void gateway.handleUpgrade(request, socket, head).catch((error) => {
			logger.error({ err: error }, "a session upgrade failed");
			socket.destroy();
		});
	});

	gateway.start();
	logger.info(`session-protocol WebSocket serving ${SESSION_PATH}`);
	await Promise.resolve();
	return true;
}
