import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from "@nestjs/common";
import { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import { AriConnectionService } from "../media/ari-connection.service";
import { MediadService } from "../media/mediad.service";
import { SipdLivenessService } from "../media/sipd-liveness.service";
import { SipdService } from "../media/sipd.service";
import { SplitPlaneMediaPort } from "../media/split-plane.port";
import { ChannelWatchService } from "../nats/channel-watch.service";
import { EngineLivenessService } from "../nats/engine-liveness.service";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { ParkHandoffService } from "../nats/park-handoff.service";
import { RoutingArtifactSource } from "../routing/routing-artifact.source";
import { EventLoopLagMonitor } from "./event-loop-lag";
import type { EngineEnv } from "../config/engine-env";
import type { MediaPort } from "../media/media-port";
import type { RpcLatencyReport } from "../nats/rpc-latency";
import type { EventLoopLagReport } from "./event-loop-lag";
import type { FastifyReply } from "fastify";

/**
 * The engine's health surface.
 *
 * ## Why `draining` is UNHEALTHY
 *
 * A draining instance still has live calls and must keep serving them, but it must stop receiving
 * new ones. Reporting `503` is how a load balancer is told to take it out of rotation while the
 * process keeps running — which is the entire point of a drain, as opposed to a restart.
 *
 * ## Why the selected media event feed is the deciding dependency
 *
 * An engine whose command client works but whose selected event feed is down is the worst possible
 * state: it looks alive, answers health checks, and silently loses call lifecycle. Under ARI that
 * feed is the WebSocket; under mediad it is the `media.evt.v1.>` subscription after a successful
 * responder probe. An unselected ARI socket is intentionally idle and cannot make mediad unhealthy.
 *
 * ## Why `park` is reported but never decides the status
 *
 * ## Why the sipd dialog feed decides the status too
 *
 * Under the split plane `sip.evt.v1.>` is the ONLY source of `dialog.answered` and
 * `dialog.terminated`. An engine whose media subscription is fine but whose dialog feed has ended
 * still admits INVITEs and never ends a leg: no hangup, no CDR, and mediad ports held until the
 * idle reaper takes them. That is the same "looks alive, loses lifecycle" state the media feed is
 * folded in for, so it is folded in on the same terms — and only when this deployment signals on
 * `apps/sipd`, because an unselected feed is intentionally idle.
 *
 * ## Why `park` is reported but never decides the status
 *
 * A park-handoff responder is a MULTI-INSTANCE facility: an instance answers for the calls it has
 * parked so a colleague on another instance can collect them. A single-instance deployment
 * configures no shared claim bucket and therefore opens no subscription, and that is a correct
 * state, not a degraded one — see `ParkHandoffService.onApplicationBootstrap`. Folding it into
 * `status` would take every single-instance deployment out of its load balancer's rotation.
 *
 * The status computation is the deciding contract here, not the payload: the container
 * `HEALTHCHECK` in `apps/engine/Dockerfile` reads `response.ok` and nothing else, so a section
 * added to the body cannot affect it, and a section that changed `status` would.
 */
@Controller()
export class HealthController {
	constructor(
		private readonly ari: AriConnectionService,
		private readonly mediad: MediadService,
		private readonly sipd: SipdService,
		private readonly sipdLiveness: SipdLivenessService,
		private readonly engineLiveness: EngineLivenessService,
		private readonly channelWatch: ChannelWatchService,
		private readonly jetstream: JetStreamService,
		private readonly orchestrator: ChannelOrchestrator,
		private readonly parkHandoff: ParkHandoffService,
		private readonly routing: RoutingArtifactSource,
		private readonly lag: EventLoopLagMonitor,
		@Inject(MEDIA_PORT) private readonly media: MediaPort,
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
	) {}

	@Get("/healthz")
	@HttpCode(HttpStatus.OK)
	health(@Res({ passthrough: true }) reply: FastifyReply): HealthReport {
		const report = this.report();
		if (report.status !== "ok") {
			void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
		}
		return report;
	}

	/**
	 * Liveness, as distinct from readiness: the process is up and its event loop is turning.
	 * A liveness probe that fails on a dependency outage restarts a healthy process and turns a
	 * broker blip into an outage.
	 */
	@Get("/livez")
	@HttpCode(HttpStatus.OK)
	live(): { readonly status: "ok" } {
		return { status: "ok" };
	}

	private report(): HealthReport {
		const ariConnected = this.ari.isConnected;
		const mediaDriver = this.mediad.isSelected ? "mediad" : "ari";
		const mediaReady = mediaDriver === "mediad" ? this.mediad.isReady : ariConnected;
		const signallingReady = !this.sipd.isSelected || this.sipd.subscriptionState === "subscribed";
		const natsReady = this.jetstream.isReady;
		const draining = this.orchestrator.isDraining;
		const park = this.parkHandoff.stats;
		const routing = this.routing.stats;

		return {
			status: mediaReady && signallingReady && natsReady && !draining ? "ok" : "degraded",
			draining,
			activeChannels: this.orchestrator.activeChannelCount,
			media: {
				driver: mediaDriver,
				ready: mediaReady,
			},
			ari: {
				connected: ariConnected,
				stream: this.ari.streamStatus,
				application: this.ari.applicationName,
				asteriskVersion: this.ari.asteriskVersion,
				eventsReceived: this.ari.eventCount,
			},
			mediad: {
				reachable: this.mediad.isReachable,
				subscription: this.mediad.subscriptionState,
				eventsReceived: this.mediad.eventCount,
				// Where a call setup's media half actually goes. See `RpcLatency`.
				rpc: this.mediad.rpcLatency,
			},
			sipd: {
				selected: this.sipd.isSelected,
				subscription: this.sipd.subscriptionState,
				eventsReceived: this.sipd.eventCount,
				watchingLeases: this.sipdLiveness.isWatching,
				liveInstances: this.sipdLiveness.liveInstances,
				instancesLost: this.sipdLiveness.lostCount,
				// The signalling half of the same question, empty under the ARI driver, which has no
				// `apps/sipd` client to ask.
				rpc: this.media instanceof SplitPlaneMediaPort ? this.media.signallingLatency : {},
			},
			// The engine's own liveness and adoption, reported and NOT status-deciding — the same terms
			// as `routing.staleRecoveries`. An instance whose own lease is missing is still handling
			// its calls correctly; degrading its status would pull it out of a load balancer over a
			// condition that hurts only its PEERS, and would flap as the next renewal succeeds. Alert
			// on `leaseHeld == false` and on `increase(channelsAdopted) > 0`; do not route on either.
			engine: {
				instanceId: this.env.ENGINE_INSTANCE_ID,
				leaseHeld: this.engineLiveness.isLeaseHeld,
				leaseRenewFailures: this.engineLiveness.renewFailureCount,
				watchingPeers: this.engineLiveness.isWatching,
				livePeers: this.engineLiveness.liveInstances,
				peersLost: this.engineLiveness.lostCount,
				channelsAdopted: this.orchestrator.adoptedChannelCount,
				channelWatch: {
					watching: this.channelWatch.isWatching,
					adopted: this.channelWatch.adoptedCount,
					staleRecoveries: this.channelWatch.staleRecoveryCount,
					...(this.channelWatch.lastEntryTimestamp === undefined
						? {}
						: { lastEntryAt: this.channelWatch.lastEntryTimestamp }),
				},
			},
			// How far behind the single thread every call setup runs on is. Reported, never
			// status-deciding: a loop 200 ms behind is SLOW, not broken, and pulling the instance out
			// of rotation for it would move the same load onto fewer threads. See `EventLoopLagMonitor`.
			eventLoop: this.lag.report,
			nats: {
				connected: natsReady,
				server: this.jetstream.serverUrl,
			},
			park: {
				listening: park.listening,
				subject: this.parkHandoff.subject,
				served: park.served,
			},
			routing: {
				watching: routing.watching,
				cached: routing.cached,
				invalidations: routing.invalidations,
				staleRecoveries: routing.staleRecoveries,
				...(routing.lastWatchEntryAt === undefined
					? {}
					: { lastWatchEntryAt: routing.lastWatchEntryAt }),
			},
		};
	}
}

export interface HealthReport {
	readonly status: "ok" | "degraded";
	readonly draining: boolean;
	readonly activeChannels: number;
	readonly media: {
		readonly driver: "ari" | "mediad";
		readonly ready: boolean;
	};
	readonly ari: {
		readonly connected: boolean;
		readonly stream: string;
		readonly application: string;
		readonly asteriskVersion?: string;
		readonly eventsReceived: number;
	};
	readonly mediad: {
		readonly reachable: boolean;
		readonly subscription: "idle" | "subscribed" | "closed";
		readonly eventsReceived: number;
		/** Round-trip latency to `mediad`, per operation, since boot. See `RpcLatency`. */
		readonly rpc: Record<string, RpcLatencyReport>;
	};
	/**
	 * The signalling plane's event feed, as this instance sees it.
	 *
	 * `selected: false` is the ordinary ARI answer and never degrades the status. When it is
	 * selected, a `subscription` of anything but `"subscribed"` is the one state worth paging on:
	 * calls still arrive and none of them can ever end.
	 */
	readonly sipd: {
		readonly selected: boolean;
		readonly subscription: "idle" | "subscribed" | "closed";
		readonly eventsReceived: number;
		/** Whether the `sip-instances` lease watch is up. False means edge deaths go unnoticed. */
		readonly watchingLeases: boolean;
		/** The edges holding a live lease right now. Empty with calls up is worth paging on. */
		readonly liveInstances: readonly string[];
		/** Edge deaths this process has acted on, each one a set of legs it ended and billed. */
		readonly instancesLost: number;
		/** Round-trip latency to `apps/sipd`, per command, since boot. See `RpcLatency`. */
		readonly rpc: Record<string, RpcLatencyReport>;
	};
	/**
	 * This instance's own liveness and what it has adopted. Reported, never status-deciding — see
	 * the comment beside the value.
	 */
	readonly engine: {
		readonly instanceId: string;
		/** False means peers believe this instance is dead and may contest its live channels. */
		readonly leaseHeld: boolean;
		readonly leaseRenewFailures: number;
		/** Whether the `engine-instances` watch is up. False means peer deaths go unnoticed. */
		readonly watchingPeers: boolean;
		readonly livePeers: readonly string[];
		/** Peer deaths this process has acted on, each one a contest over that peer's channels. */
		readonly peersLost: number;
		/** Channels taken over from a peer proved dead by its instance lease. Monotonic. */
		readonly channelsAdopted: number;
		readonly channelWatch: {
			readonly watching: boolean;
			/** Channels adopted off the watch because their owner's CHANNEL lease had lapsed. */
			readonly adopted: number;
			/** A wedged watch, recovered. Alert on any increase; see `ChannelWatchService`. */
			readonly staleRecoveries: number;
			readonly lastEntryAt?: number;
		};
	};
	/**
	 * Event-loop delay, in milliseconds beyond the sampling interval. The engine's ceiling is one
	 * thread; this is the number that says how close to it this instance is.
	 */
	readonly eventLoop: EventLoopLagReport;
	readonly nats: {
		readonly connected: boolean;
		readonly server: string;
	};
	/**
	 * The cross-instance park plane, as this instance participates in it.
	 *
	 * `listening: false` with a `served` of zero is the ordinary single-instance answer. On a
	 * multi-instance deployment it is the one thing worth an alert: it means calls parked here
	 * cannot be collected from any other instance, and the only symptom a user reports is an orbit
	 * that rings back instead of connecting.
	 */
	/**
	 * The routing-artifact watch, as this instance sees it. Reported, never status-deciding — see
	 * the class note for why a stalled watch is a page for a human rather than a rotation change.
	 */
	readonly routing: {
		readonly watching: boolean;
		readonly cached: number;
		readonly invalidations: number;
		/**
		 * How many times this instance caught its own watch alive-but-behind and re-established it.
		 *
		 * Non-zero is not a fault to route around — the watch recovered, which is the point — but it
		 * IS the signal that something outside this process is stopping flow-control replies, and it
		 * is the number to alert on. See `RoutingArtifactSource` for the mechanism.
		 */
		readonly staleRecoveries: number;
		readonly lastWatchEntryAt?: string;
	};
	readonly park: {
		readonly listening: boolean;
		/** The instance-scoped subject this engine answers on, so an operator can `nats req` it. */
		readonly subject: string;
		readonly served: number;
	};
}
