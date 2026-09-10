import { afterEach, describe, expect, it } from "bun:test";
import { EngineMetrics } from "./engine-metrics.service";
import { EventLoopLagMonitor } from "./event-loop-lag";
import { metricsRegistry, registerCounter, registerGauge, resetMetricsForTest } from "./metrics";
import type { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import type { AriConnectionService } from "../media/ari-connection.service";
import type { MediaPort } from "../media/media-port";
import type { MediadService } from "../media/mediad.service";
import type { SipdLivenessService } from "../media/sipd-liveness.service";
import type { SipdService } from "../media/sipd.service";
import type { ChannelWatchService } from "../nats/channel-watch.service";
import type { EngineLivenessService } from "../nats/engine-liveness.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { SipInviteService } from "../nats/sip-invite.service";
import type { RoutingArtifactSource } from "../routing/routing-artifact.source";

/**
 * The scrape, as a scraper sees it.
 *
 * The contract worth defending here is that every series is a READ of a number `/healthz` already
 * reports — so the cases below move the underlying counters and assert the scrape followed, rather
 * than asserting that a registration happened.
 */

interface Parts {
	readonly activeChannels?: number;
	readonly adoptedChannels?: number;
	readonly draining?: boolean;
	readonly served?: number;
	readonly admitted?: number;
	readonly refusals?: Record<string, number>;
	readonly staleRecoveries?: number;
	readonly routingCached?: number;
	readonly leaseHeld?: boolean;
	readonly mediaLatency?: Record<
		string,
		{ count: number; failed: number; p50: number; p99: number; maxMs: number }
	>;
}

function harness(parts: Parts = {}): EngineMetrics {
	const orchestrator = {
		get activeChannelCount() {
			return parts.activeChannels ?? 0;
		},
		get adoptedChannelCount() {
			return parts.adoptedChannels ?? 0;
		},
		get isDraining() {
			return parts.draining ?? false;
		},
	} as unknown as ChannelOrchestrator;
	const ari = { isConnected: true } as unknown as AriConnectionService;
	const mediad = {
		isSelected: true,
		isReady: true,
		rpcLatency: parts.mediaLatency ?? {},
	} as unknown as MediadService;
	const sipd = { isSelected: false, subscriptionState: "idle" } as unknown as SipdService;
	const sipdLiveness = { lostCount: 0 } as unknown as SipdLivenessService;
	const engineLiveness = {
		isLeaseHeld: parts.leaseHeld ?? true,
		renewFailureCount: 0,
		lostCount: 0,
	} as unknown as EngineLivenessService;
	const channelWatch = {
		adoptedCount: 0,
		get staleRecoveryCount() {
			return parts.staleRecoveries ?? 0;
		},
	} as unknown as ChannelWatchService;
	const jetstream = { isReady: true } as unknown as JetStreamService;
	const routing = {
		get stats() {
			return {
				cached: parts.routingCached ?? 0,
				invalidations: 0,
				staleRecoveries: 0,
			};
		},
	} as unknown as RoutingArtifactSource;
	const sipInvite = {
		get stats() {
			return {
				listening: true,
				served: parts.served ?? 0,
				admitted: parts.admitted ?? 0,
				refusals: parts.refusals ?? {},
			};
		},
	} as unknown as SipInviteService;
	// Not started: `report` reads a histogram that answers whether or not it was enabled, and a
	// running rollover timer would outlive the case.
	const lag = new EventLoopLagMonitor();
	const media = {} as unknown as MediaPort;

	const metrics = new EngineMetrics(
		orchestrator,
		ari,
		mediad,
		sipd,
		sipdLiveness,
		engineLiveness,
		channelWatch,
		jetstream,
		routing,
		sipInvite,
		lag,
		media,
	);
	metrics.register();
	return metrics;
}

async function scrape(): Promise<string> {
	return await metricsRegistry.metrics();
}

/** The value of one series, or undefined when it is not in the scrape. */
function seriesValue(body: string, name: string): number | undefined {
	for (const line of body.split("\n")) {
		if (line.startsWith(`${name} `)) {
			return Number(line.slice(name.length + 1));
		}
	}
	return undefined;
}

afterEach(() => {
	resetMetricsForTest();
});

describe("the engine's Prometheus registry", () => {
	it("publishes the default Node collectors under the engine_ prefix", async () => {
		const body = await scrape();
		// Event-loop lag is the reason `collectDefaultMetrics` is here at all: the engine's ceiling
		// is one thread.
		expect(body).toContain("engine_nodejs_eventloop_lag_seconds");
		expect(body).toContain("engine_process_cpu_seconds_total");
	});

	it("publishes every series the runbook names", async () => {
		harness();
		const body = await scrape();
		for (const name of [
			"engine_active_channels",
			"engine_channels_adopted_total",
			"engine_draining",
			"engine_sip_invites_total",
			"engine_sip_admissions_total",
			"engine_media_ready",
			"engine_signalling_ready",
			"engine_nats_connected",
			"engine_lease_held",
			"engine_lease_renew_failures_total",
			"engine_peers_lost_total",
			"engine_sip_instances_lost_total",
			"engine_channel_watch_adopted_total",
			"engine_channel_watch_stale_recoveries_total",
			"engine_routing_stale_recoveries_total",
			"engine_routing_cached",
			"engine_routing_invalidations_total",
			"engine_event_loop_lag_ms",
		]) {
			expect(body).toContain(`# TYPE ${name} `);
		}
	});

	it("reads the live values at scrape time rather than at registration", async () => {
		let channels = 0;
		let draining = false;
		harness({
			get activeChannels() {
				return channels;
			},
			get draining() {
				return draining;
			},
		} as Parts);

		expect(seriesValue(await scrape(), "engine_active_channels")).toBe(0);
		expect(seriesValue(await scrape(), "engine_draining")).toBe(0);

		channels = 7;
		draining = true;
		expect(seriesValue(await scrape(), "engine_active_channels")).toBe(7);
		expect(seriesValue(await scrape(), "engine_draining")).toBe(1);
	});

	it("labels refusals by reason and nothing else", async () => {
		harness({ served: 9, admitted: 6, refusals: { not_permitted: 2, shutting_down: 1 } });
		const body = await scrape();
		expect(body).toContain('engine_sip_refusals_total{reason="not_permitted"} 2');
		expect(body).toContain('engine_sip_refusals_total{reason="shutting_down"} 1');
		expect(seriesValue(body, "engine_sip_admissions_total")).toBe(6);
		expect(seriesValue(body, "engine_sip_invites_total")).toBe(9);
	});

	it("publishes per-plane RPC latency off the report the two planes already keep", async () => {
		harness({
			mediaLatency: {
				"session.create": { count: 12, failed: 1, p50: 5, p99: 50, maxMs: 61 },
				// `-1` is `RpcLatency`'s "slower than the last bucket bound"; a threshold alert must
				// fire on it rather than read it as the fastest possible call.
				"session.destroy": { count: 3, failed: 3, p50: -1, p99: -1, maxMs: 9_000 },
			},
		});
		const body = await scrape();
		expect(body).toContain('engine_rpc_calls_total{plane="media",operation="session.create"} 12');
		expect(body).toContain('engine_rpc_failures_total{plane="media",operation="session.create"} 1');
		expect(body).toContain(
			'engine_rpc_latency_p99_milliseconds{plane="media",operation="session.create"} 50',
		);
		expect(body).toContain(
			'engine_rpc_latency_p50_milliseconds{plane="media",operation="session.destroy"} +Inf',
		);
	});

	it("counts monotonically and never counts down when a source resets", async () => {
		let recoveries = 3;
		registerCounter("engine_test_recoveries_total", "for the spec", () => recoveries);

		expect(seriesValue(await scrape(), "engine_test_recoveries_total")).toBe(3);
		recoveries = 5;
		expect(seriesValue(await scrape(), "engine_test_recoveries_total")).toBe(5);
		// A service replaced under a harness: a counter cannot go backwards, so the last value stands.
		recoveries = 1;
		expect(seriesValue(await scrape(), "engine_test_recoveries_total")).toBe(5);
	});

	it("leaves the previous value standing when a read throws rather than failing the scrape", async () => {
		let broken = false;
		registerGauge("engine_test_gauge", "for the spec", () => {
			if (broken) {
				throw new Error("the provider is mid-teardown");
			}
			return 4;
		});

		expect(seriesValue(await scrape(), "engine_test_gauge")).toBe(4);
		broken = true;
		const body = await scrape();
		expect(seriesValue(body, "engine_test_gauge")).toBe(4);
		// And the rest of the scrape is intact, which is the point.
		expect(body).toContain("engine_nodejs_eventloop_lag_seconds");
	});

	it("registers idempotently, so a second application in one process does not throw", () => {
		harness({ activeChannels: 1 });
		expect(() => harness({ activeChannels: 2 })).not.toThrow();
	});
});
