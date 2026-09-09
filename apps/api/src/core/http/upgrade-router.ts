import { getLogger } from "@optimiq-voice/logging";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

const logger = getLogger("api.upgrade");

/**
 * A gateway's claim on an upgrade. Resolves `true` when the gateway took ownership of the socket
 * (answered it, refused it with a status, or destroyed it), `false` when the path is not its own.
 */
export type UpgradeClaim = (
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => Promise<boolean>;

/**
 * The single `upgrade` listener every gateway is dispatched through.
 *
 * ## Why one listener rather than one per gateway
 *
 * Node's `http.Server` destroys an upgrade socket only when the server has NO `'upgrade'` listener
 * at all. The moment one is attached, the socket becomes userland's problem — a listener that
 * returns without touching it leaves a fully-established TCP connection open, referenced by
 * nothing and bounded by no timeout. Two gateways that each politely ignored paths they did not
 * own therefore leaked one fd per unmatched handshake, from an unauthenticated request to any
 * path, which is a remote fd exhaustion.
 *
 * So the routing decision belongs in one place that can see every claim: each gateway answers
 * whether the path was its own, and an upgrade nobody claims is destroyed here.
 */
export function attachUpgradeHandler(server: Server, claim: UpgradeClaim): void {
	const claims = registered.get(server);
	if (claims !== undefined) {
		claims.push(claim);
		return;
	}

	const own = [claim];
	registered.set(server, own);
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		// The claims are async because session resolution is; the event is not. A rejection here
		// would be unhandled and would take the process down, so it is caught and the socket is
		// closed — an upgrade that failed for an unexpected reason must not be left half-open.
		void (async () => {
			for (const candidate of own) {
				if (await candidate(request, socket, head)) {
					return;
				}
			}
			// Nobody owns this path.
			socket.destroy();
		})().catch((error) => {
			logger.error({ err: error, url: request.url }, "an upgrade failed");
			socket.destroy();
		});
	});
}

/**
 * Per-server claim lists. Keyed weakly so a server that goes away in a test takes its claims with
 * it, and so a second `attachUpgradeHandler` on the same server extends the existing router rather
 * than installing a second listener that would re-introduce the leak.
 */
const registered = new WeakMap<Server, UpgradeClaim[]>();
