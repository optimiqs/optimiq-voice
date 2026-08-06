import { Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { AuthModule } from "../auth/auth.module";
import { PbxModule } from "../pbx/pbx.module";
import { LiveGateway } from "./live-gateway";
import { LiveHub } from "./live-hub.service";
import { LIVE_PATH } from "./live-protocol";

const logger = getLogger("api.live");

/**
 * The live-operations channel.
 *
 * ## Why it imports `PbxModule` rather than reading the environment itself
 *
 * The hub needs `NATS_URL` and the KV-bucket bootstrap flag, both of which are already parsed
 * exactly once as `PBX_ENV`. Re-reading `process.env` here would be a second parse of the same
 * variables with its own defaults — which is the failure the oikos §6 rule exists to prevent — and
 * a second `PbxEnv` whose `PBX_ENSURE_KV_BUCKETS` could disagree with the publishers'.
 *
 * The coupling is real and worth naming: this module cannot mount without the PBX area. That is
 * correct rather than incidental — every topic it serves is a projection of state the PBX area's
 * processes write, and a live channel on a deployment with no telephony database would be a socket
 * with nothing on the other end.
 *
 * `AuthModule` is imported for the same reason: the gateway authenticates the upgrade through the
 * SAME `auth.api.getSession` call the HTTP `preHandler` uses, and resolves the membership role
 * through the same `AuthService`. A socket with its own cookie parsing would be a second
 * authorization implementation, which is precisely the thing that drifts.
 *
 * ## Why the gateway is a provider and not a controller
 *
 * It serves no HTTP route. `main.ts` attaches it to the server's `upgrade` event through
 * `live-bootstrap.ts`, next to `registerAuthTransport` and for the same reason: raw transport
 * wiring has to exist before `listen`, which is when Nest installs its own router. Making it a
 * provider is what lets Nest own its lifecycle (`OnApplicationShutdown` closes every socket) while
 * the transport stays outside the HTTP router.
 */
@Module({
	imports: [AuthModule, PbxModule],
	providers: [LiveHub, LiveGateway],
	exports: [LiveHub, LiveGateway],
})
export class LiveModule {
	constructor() {
		logger.info(`live channel mounted on ${LIVE_PATH}`);
	}
}
