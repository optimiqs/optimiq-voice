import { Global, Module } from "@nestjs/common";
import { CallSignalBus } from "./call-signals";
import { ClaimHeartbeatService } from "./claim-heartbeat.service";
import { ConferenceRegistry } from "./conference-registry";
import { DidIndexSource } from "./did-index.source";
import { ParkRegistry } from "./park-registry";
import { RoutingArtifactSource } from "./routing-artifact.source";
import { VoicemailMailboxRpcSource } from "./voicemail-mailbox.source";

/**
 * The routing plane.
 *
 * `@Global` for the same reason `NatsModule` is: both providers are cross-cutting singletons whose
 * identity is the point. A second {@link CallSignalBus} would mean the orchestrator emitting a
 * B-leg's answer into a bus nobody is listening on, and a second {@link RoutingArtifactSource}
 * would mean two memory caches, two KV watches, and a window where one of them is stale.
 * {@link DidIndexSource} joins them because it is the same kind of thing one layer earlier: the
 * lookup that decides which tenant a call belongs to before any of the above can be scoped.
 * {@link VoicemailMailboxRpcSource} joins them because it is stateless over the same rpc client
 * proxy and there is nothing per-call about "ask the control plane what is in this mailbox".
 * {@link ConferenceRegistry} joins them because it is the one destination whose state outlives a
 * single walk: two callers dialing the same room are two walks that have to reach one bridge, and
 * a second registry would put them in two. {@link ParkRegistry} joins them for the same reason,
 * more sharply: a parked call outlives its walk BY DESIGN, and its retrieval arrives minutes later
 * as a different call from a different phone. Two registries would mean an orbit that is occupied
 * on one and free on the other, which is two callers on slot 401. Both are now backed by NATS KV
 * compare-and-set claims, which is what makes that guarantee hold ACROSS processes as well as within
 * one; {@link ClaimHeartbeatService} is what binds the buckets to them and keeps this instance's
 * claims alive.
 *
 * The plan walker itself is NOT a provider: one is constructed per call, over that call's channel
 * and that call's plan, and it holds per-walk state (retry counters, visited nodes, the notes).
 * A singleton walker would have to carry a map keyed by channel and would be one bug away from
 * running one call's IVR against another call's counters.
 */
@Global()
@Module({
	providers: [
		CallSignalBus,
		RoutingArtifactSource,
		DidIndexSource,
		VoicemailMailboxRpcSource,
		ConferenceRegistry,
		ParkRegistry,
		ClaimHeartbeatService,
	],
	exports: [
		CallSignalBus,
		RoutingArtifactSource,
		DidIndexSource,
		VoicemailMailboxRpcSource,
		ConferenceRegistry,
		ParkRegistry,
		ClaimHeartbeatService,
	],
})
export class RoutingModule {}
