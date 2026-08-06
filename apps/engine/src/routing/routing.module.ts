import { Global, Module } from "@nestjs/common";
import { CallSignalBus } from "./call-signals";
import { DidIndexSource } from "./did-index.source";
import { RoutingArtifactSource } from "./routing-artifact.source";

/**
 * The routing plane.
 *
 * `@Global` for the same reason `NatsModule` is: both providers are cross-cutting singletons whose
 * identity is the point. A second {@link CallSignalBus} would mean the orchestrator emitting a
 * B-leg's answer into a bus nobody is listening on, and a second {@link RoutingArtifactSource}
 * would mean two memory caches, two KV watches, and a window where one of them is stale.
 * {@link DidIndexSource} joins them because it is the same kind of thing one layer earlier: the
 * lookup that decides which tenant a call belongs to before any of the above can be scoped.
 *
 * The plan walker itself is NOT a provider: one is constructed per call, over that call's channel
 * and that call's plan, and it holds per-walk state (retry counters, visited nodes, the notes).
 * A singleton walker would have to carry a map keyed by channel and would be one bug away from
 * running one call's IVR against another call's counters.
 */
@Global()
@Module({
	providers: [CallSignalBus, RoutingArtifactSource, DidIndexSource],
	exports: [CallSignalBus, RoutingArtifactSource, DidIndexSource],
})
export class RoutingModule {}
