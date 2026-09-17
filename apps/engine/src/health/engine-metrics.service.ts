import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import { AriConnectionService } from "../media/ari-connection.service";
import { MediadService } from "../media/mediad.service";
import { SipdLivenessService } from "../media/sipd-liveness.service";
import { SipdService } from "../media/sipd.service";
import { SplitPlaneMediaPort } from "../media/split-plane.port";
import { ChannelWatchService } from "../nats/channel-watch.service";
import { EngineLivenessService } from "../nats/engine-liveness.service";
import { JetStreamService } from "../nats/jetstream.service";
import { MEDIA_PORT } from "../nats/nats.tokens";
import { SipInviteService } from "../nats/sip-invite.service";
import { RoutingArtifactSource } from "../routing/routing-artifact.source";
import { EventLoopLagMonitor } from "./event-loop-lag";
import {
	registerCounter,
	registerGauge,
	registerLabelledCounter,
	registerLabelledGauge,
} from "./metrics";
import type { MediaPort } from "../media/media-port";
import type { RpcLatencyReport } from "../nats/rpc-latency";

/**
 * Publishes the engine's `/healthz` facts as Prometheus series.
 *
 * ## Why this is a provider and the registry is not
 *
 * Everything worth scraping here lives on an injected service, and the numbers already exist: the
 * orchestrator counts its channels, `ChannelWatchService` counts the watches it has un-wedged,
 * `RpcLatency` has bucketed every round trip to `mediad` and `sipd` since boot. A second set of
 * counters on the call path would buy nothing but contention on the one thread this process has, so
 * this class registers READS and nothing else — every gauge below runs when a scraper asks, and the
 * call path is untouched.
 *
 * The registrations happen on application bootstrap rather than in the constructor so that a
 * provider Nest has not finished wiring cannot be read by a scrape that arrives mid-boot. The
 * listener itself comes up in `main.ts` after `app.init()`, for the same reason.
 *
 * ## The cardinality rule
 *
 * Two label vocabularies appear here and both are CLOSED: `reason` is the `SipInviteRefusalReason`
 * union, and `operation`/`plane` are the RPC subjects this codebase names in source. Nothing derived
 * from a call — a leg id, an extension, a caller number — may ever become a label; that is how a
 * metrics endpoint takes a process down, and this process has one thread to lose.
 */
@Injectable()
export class EngineMetrics implements OnApplicationBootstrap {
	constructor(
		private readonly orchestrator: ChannelOrchestrator,
		private readonly ari: AriConnectionService,
		private readonly mediad: MediadService,
		private readonly sipd: SipdService,
		private readonly sipdLiveness: SipdLivenessService,
		private readonly engineLiveness: EngineLivenessService,
		private readonly channelWatch: ChannelWatchService,
		private readonly jetstream: JetStreamService,
		private readonly routing: RoutingArtifactSource,
		private readonly sipInvite: SipInviteService,
		private readonly lag: EventLoopLagMonitor,
		@Inject(MEDIA_PORT) private readonly media: MediaPort,
	) {}

	onApplicationBootstrap(): void {
		this.register();
	}

	/** Registers every series. Idempotent by metric name, so a second application may build safely. */
	register(): void {
		// ---- Calls in flight -----------------------------------------------------------------
		registerGauge(
			"engine_active_channels",
			"Channels this instance is currently orchestrating.",
			() => this.orchestrator.activeChannelCount,
		);
		registerCounter(
			"engine_channels_adopted_total",
			"Channels taken over from a peer proved dead by its instance lease.",
			() => this.orchestrator.adoptedChannelCount,
		);
		registerGauge(
			"engine_draining",
			"1 while this instance is draining and refusing new calls.",
			() => (this.orchestrator.isDraining ? 1 : 0),
		);

		// ---- Admission -----------------------------------------------------------------------
		// Served minus admitted is NOT the refusal count on its own: an INVITE can be served and
		// still be in flight. Both halves are published so the ratio is the scraper's to compute.
		registerCounter(
			"engine_sip_invites_total",
			"INVITEs this instance has answered for, admitted or refused.",
			() => this.sipInvite.stats.served,
		);
		registerCounter(
			"engine_sip_admissions_total",
			"Calls arriving on the sip edge that this instance admitted.",
			() => this.sipInvite.stats.admitted,
		);
		registerLabelledCounter(
			"engine_sip_refusals_total",
			"INVITEs this instance refused, by refusal reason.",
			["reason"],
			(set) => {
				for (const [reason, count] of Object.entries(this.sipInvite.stats.refusals)) {
					set({ reason }, count);
				}
			},
		);

		// ---- Plane readiness -----------------------------------------------------------------
		// The same three booleans `/healthz` computes its status from, so an alert can say WHICH of
		// them was false rather than only that the instance went out of rotation.
		registerGauge(
			"engine_media_ready",
			"1 when the selected media event feed is up — the mediad subscription, or the ARI socket.",
			() => boolean(this.mediad.isSelected ? this.mediad.isReady : this.ari.isConnected),
		);
		registerGauge(
			"engine_signalling_ready",
			"1 when the sipd dialog feed is up, or is not this deployment's source.",
			() => boolean(!this.sipd.isSelected || this.sipd.subscriptionState === "subscribed"),
		);
		registerGauge("engine_nats_connected", "1 when the NATS connection is usable.", () =>
			boolean(this.jetstream.isReady),
		);

		// ---- Liveness and adoption -----------------------------------------------------------
		registerGauge(
			"engine_lease_held",
			"1 while this instance holds its own engine-instances lease. Zero means peers may contest its live channels.",
			() => boolean(this.engineLiveness.isLeaseHeld),
		);
		registerCounter(
			"engine_lease_renew_failures_total",
			"Failed renewals of this instance's own liveness lease.",
			() => this.engineLiveness.renewFailureCount,
		);
		registerCounter(
			"engine_peers_lost_total",
			"Peer engine deaths this instance has acted on.",
			() => this.engineLiveness.lostCount,
		);
		registerCounter(
			"engine_sip_instances_lost_total",
			"Sip edge deaths this instance has acted on, each one a set of legs it ended and billed.",
			() => this.sipdLiveness.lostCount,
		);
		registerCounter(
			"engine_channel_watch_adopted_total",
			"Channels adopted off the KV watch because their owner's channel lease had lapsed.",
			() => this.channelWatch.adoptedCount,
		);
		// The two stale-watch counters are the ones to alert on any increase of: the watch recovered,
		// which is the point, but something outside this process stopped flow-control replies.
		registerCounter(
			"engine_channel_watch_stale_recoveries_total",
			"Times the channel KV watch was caught alive-but-behind and re-established.",
			() => this.channelWatch.staleRecoveryCount,
		);
		registerCounter(
			"engine_routing_stale_recoveries_total",
			"Times the routing-cache KV watch was caught alive-but-behind and re-established.",
			() => this.routing.stats.staleRecoveries,
		);
		registerGauge(
			"engine_routing_cached",
			"Routing artifacts held in this instance's cache.",
			() => this.routing.stats.cached,
		);
		registerCounter(
			"engine_routing_invalidations_total",
			"Cached routing artifacts dropped because the watch said they changed.",
			() => this.routing.stats.invalidations,
		);

		// ---- Where a call setup actually goes -------------------------------------------------
		this.registerRpcLatency();

		// ---- The one thread ------------------------------------------------------------------
		// `collectDefaultMetrics` already publishes `engine_nodejs_eventloop_lag_seconds`, which is
		// the aggregatable form. This is the ROLLING window `/healthz` reports, in milliseconds
		// beyond the sampling interval, so a dashboard and a `curl /healthz` cannot disagree.
		registerGauge(
			"engine_event_loop_lag_ms",
			"p99 event-loop delay in the current rolling window, in milliseconds beyond the sampling interval.",
			() => this.lag.report.current.p99,
		);
	}

	/**
	 * Per-hop RPC latency, from the buckets `RpcLatency` already keeps.
	 *
	 * Published as gauges of the bucket bounds the median and the 99th fell at, rather than as a
	 * Prometheus histogram, because the two planes expose their latency as the SUMMARISED report
	 * (`RpcLatencyReport`) and not as raw bucket counts — turning it into a real `_bucket` series
	 * would mean widening a getter on `apps/engine/src/media`, and the quantiles are what an operator
	 * reads off `/healthz` anyway. The consequence, and it is a real one: these are per-instance and
	 * do NOT aggregate across a fleet the way `histogram_quantile` would. `engine_rpc_calls_total`
	 * and `engine_rpc_failures_total` beside them are honest counters and do.
	 */
	private registerRpcLatency(): void {
		const planes = (): readonly (readonly [string, Record<string, RpcLatencyReport>])[] => [
			["media", this.mediad.rpcLatency],
			["signalling", this.media instanceof SplitPlaneMediaPort ? this.media.signallingLatency : {}],
		];
		const each = (
			pick: (report: RpcLatencyReport) => number,
			set: (labels: Record<string, string>, value: number) => void,
		): void => {
			for (const [plane, reports] of planes()) {
				for (const [operation, report] of Object.entries(reports)) {
					set({ plane, operation }, pick(report));
				}
			}
		};

		registerLabelledCounter(
			"engine_rpc_calls_total",
			"Round trips to another plane, by plane and operation.",
			["plane", "operation"],
			(set) => {
				each((report) => report.count, set);
			},
		);
		registerLabelledCounter(
			"engine_rpc_failures_total",
			"Round trips that produced no usable reply — a timeout, no responders, or an off-contract reply.",
			["plane", "operation"],
			(set) => {
				each((report) => report.failed, set);
			},
		);
		// `-1` is `RpcLatency`'s "slower than the last bucket bound", which is an outage rather than
		// a latency. It is published as `+Inf` so a threshold alert fires on it instead of reading it
		// as the fastest possible call.
		registerLabelledGauge(
			"engine_rpc_latency_p50_milliseconds",
			"The bucket bound the median round trip fell at or under. +Inf means slower than the last bound.",
			["plane", "operation"],
			(set) => {
				each((report) => unbounded(report.p50), set);
			},
		);
		registerLabelledGauge(
			"engine_rpc_latency_p99_milliseconds",
			"The bucket bound the 99th-percentile round trip fell at or under. +Inf means slower than the last bound.",
			["plane", "operation"],
			(set) => {
				each((report) => unbounded(report.p99), set);
			},
		);
		registerLabelledGauge(
			"engine_rpc_latency_max_milliseconds",
			"The slowest round trip seen since boot, by plane and operation.",
			["plane", "operation"],
			(set) => {
				each((report) => report.maxMs, set);
			},
		);
	}
}

function boolean(value: boolean): number {
	return value ? 1 : 0;
}

function unbounded(milliseconds: number): number {
	return milliseconds < 0 ? Number.POSITIVE_INFINITY : milliseconds;
}
