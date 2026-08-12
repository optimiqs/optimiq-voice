import { Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { AuthModule } from "../auth/auth.module";
import { PbxModule } from "../pbx/pbx.module";
import { SessionGateway } from "./session-gateway";
import { SessionHub } from "./session-hub.service";
import { SESSION_PATH } from "./session-protocol";

const logger = getLogger("api.session");

/**
 * The session protocol — the programmability keystone.
 *
 * An external application opens `/api/v1/session`, claims one or more `application` names for its
 * organization, and from then on every call the dial plan routes to those names is handed to it:
 * typed call events out, typed verbs in, for the length of the call.
 *
 * ## Why it is a sibling of `LiveModule` and not part of it
 *
 * The two modules are shaped alike — a hub that owns the broker side, a gateway that owns the
 * sockets, a bootstrap that hangs the gateway off the HTTP upgrade — and they are opposites in the
 * only way that matters. `LiveModule` is a read surface for browsers, gated by `cdr.read`. This is
 * a WRITE surface for machines, gated by `calls.control`, and a frame on it can hang a customer's
 * call up. Sharing a module would have meant sharing a permission, and `live-topics.ts` had already
 * settled that the live feed rides the grant for reading call history — which is emphatically not
 * the grant that should let somebody end a call in progress.
 *
 * The imports are the live module's, for the live module's reasons: `PbxModule` because `NATS_URL`
 * is parsed exactly once as `PBX_ENV`, and `AuthModule` because a socket with its own cookie
 * parsing would be a second authorization implementation.
 *
 * ## Why the gateway is a provider and not a controller
 *
 * It serves no HTTP route. `main.ts` attaches it to the server's `upgrade` event through
 * `session-bootstrap.ts`, next to `registerLiveTransport` — raw transport wiring has to exist
 * before `listen`, and making it a provider is what lets Nest own its lifecycle while the transport
 * stays outside the HTTP router.
 */
@Module({
	imports: [AuthModule, PbxModule],
	providers: [SessionHub, SessionGateway],
	exports: [SessionHub, SessionGateway],
})
export class SessionModule {
	constructor() {
		logger.info(`session protocol mounted on ${SESSION_PATH}`);
	}
}
