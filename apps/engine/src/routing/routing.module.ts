import { Global, Module } from "@nestjs/common";
import { CallSignalBus } from "./call-signals";
import { ClaimHeartbeatService } from "./claim-heartbeat.service";
import { ConferenceRegistry } from "./conference-registry";
import { DidIndexSource } from "./did-index.source";
import { ExtensionFeatureRpcPort } from "./extension-feature.source";
import { LastCallerRpcSource } from "./last-caller.source";
import { ParkRegistry } from "./park-registry";
import { RoutingArtifactSource } from "./routing-artifact.source";
import { SharedLineRegistry } from "./shared-line-registry";
import { SupervisorAuthzRpcPort } from "./supervisor-authz.source";
import { TrunkStatusPublisher } from "./trunk-status.publisher";
import { VoicemailGreetingRpcPort } from "./voicemail-greeting.source";
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
 * {@link ExtensionFeatureRpcPort}, {@link LastCallerRpcSource} and {@link VoicemailGreetingRpcPort}
 * join it on exactly those terms — one rpc client, no per-call state, and a pair of counters a
 * health check reads. They are here
 * rather than in `CallsModule` for the reason the mailbox source is: the star codes that use them
 * are executed by the plan walker, and the walker's collaborators are this module's.
 * {@link SupervisorAuthzRpcPort} joins them on those same terms with one difference worth writing
 * down: its ABSENCE is not a degradation. Every other port here missing means a feature announces
 * "not available"; this one missing means `*0` is refused, because the engine would have no way to
 * establish that the handset may listen to somebody else's conversation. It is registered here so
 * that the deployed engine always has it and the refusal branch stays a safety net rather than the
 * normal path — see `supervisor-authz.source.ts` and `PlanWalkerDependencies.supervision`, which say
 * the same thing from the two other ends.
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
		/**
		 * The trunk-health producer. Here rather than in `CallsModule` because its two
		 * collaborators are this module's: the artifact source that resolves an endpoint name back
		 * to a trunk row, and (via the global NATS module) the event client. It holds no per-call
		 * state — a trunk's reachability is a fact about the tenant, not about any walk.
		 */
		TrunkStatusPublisher,
		DidIndexSource,
		VoicemailMailboxRpcSource,
		ExtensionFeatureRpcPort,
		LastCallerRpcSource,
		VoicemailGreetingRpcPort,
		SupervisorAuthzRpcPort,
		ConferenceRegistry,
		ParkRegistry,
		SharedLineRegistry,
		ClaimHeartbeatService,
	],
	exports: [
		CallSignalBus,
		RoutingArtifactSource,
		TrunkStatusPublisher,
		DidIndexSource,
		VoicemailMailboxRpcSource,
		ExtensionFeatureRpcPort,
		LastCallerRpcSource,
		VoicemailGreetingRpcPort,
		SupervisorAuthzRpcPort,
		ConferenceRegistry,
		ParkRegistry,
		SharedLineRegistry,
		ClaimHeartbeatService,
	],
})
export class RoutingModule {}
