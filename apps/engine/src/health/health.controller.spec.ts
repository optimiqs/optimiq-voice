import { describe, expect, it } from "bun:test";
import { EventLoopLagMonitor } from "./event-loop-lag";
import { HealthController } from "./health.controller";
import type { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import type { AriConnectionService } from "../media/ari-connection.service";
import type { MediadService } from "../media/mediad.service";
import type { SipdLivenessService } from "../media/sipd-liveness.service";
import type { SipdService, SipdSubscriptionState } from "../media/sipd.service";
import type { ChannelWatchService } from "../nats/channel-watch.service";
import type { EngineLivenessService } from "../nats/engine-liveness.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { ParkHandoffService } from "../nats/park-handoff.service";
import type { RoutingArtifactSource } from "../routing/routing-artifact.source";
import type { FastifyReply } from "fastify";

/**
 * The one endpoint an orchestrator acts on.
 *
 * Every case here is about the STATUS as much as the body, because the container `HEALTHCHECK` in
 * `apps/engine/Dockerfile` reads `response.ok` and nothing else. A field added to the payload is
 * free; a field that moves `status` takes the instance out of rotation.
 */

const PARK_SUBJECT = "rpc.engine.v1.park-handoff.engine-a";

interface Parts {
	readonly ariConnected?: boolean;
	readonly mediaDriver?: "ari" | "mediad";
	readonly mediadReady?: boolean;
	readonly mediadReachable?: boolean;
	readonly sipdSubscription?: SipdSubscriptionState;
	readonly sipdWatchingLeases?: boolean;
	readonly sipdLiveInstances?: readonly string[];
	readonly sipdInstancesLost?: number;
	readonly natsReady?: boolean;
	readonly draining?: boolean;
	readonly parkListening?: boolean;
	readonly parkServed?: number;
	/** When the routing-cache watch last delivered anything. Absent means it never has. */
	readonly routingLastWatchEntryAt?: string;
	readonly routingWatching?: boolean;
	readonly routingStaleRecoveries?: number;
	readonly engineLeaseHeld?: boolean;
	readonly engineLivePeers?: readonly string[];
	readonly enginePeersLost?: number;
	readonly engineChannelsAdopted?: number;
	readonly channelWatchStaleRecoveries?: number;
}

function harness(parts: Parts = {}) {
	const ari = {
		isConnected: parts.ariConnected ?? true,
		streamStatus: "open",
		applicationName: "optimiq-engine",
		asteriskVersion: "22.9.0",
		eventCount: 41,
	} as unknown as AriConnectionService;
	const mediad = {
		isSelected: parts.mediaDriver === "mediad",
		isReady: parts.mediadReady ?? true,
		isReachable: parts.mediadReachable ?? true,
		subscriptionState: (parts.mediadReady ?? true) ? "subscribed" : "idle",
		eventCount: 12,
		rpcLatency: {},
	} as unknown as MediadService;

	const sipd = {
		isSelected: parts.mediaDriver === "mediad",
		subscriptionState: parts.sipdSubscription ?? "subscribed",
		eventCount: 5,
	} as unknown as SipdService;

	const sipdLiveness = {
		isWatching: parts.sipdWatchingLeases ?? true,
		liveInstances: parts.sipdLiveInstances ?? ["sipd-7c9f"],
		lostCount: parts.sipdInstancesLost ?? 0,
	} as unknown as SipdLivenessService;

	const engineLiveness = {
		isLeaseHeld: parts.engineLeaseHeld ?? true,
		renewFailureCount: 0,
		isWatching: true,
		liveInstances: parts.engineLivePeers ?? [],
		lostCount: parts.enginePeersLost ?? 0,
	} as unknown as EngineLivenessService;

	const channelWatch = {
		isWatching: true,
		adoptedCount: 0,
		staleRecoveryCount: parts.channelWatchStaleRecoveries ?? 0,
		lastEntryTimestamp: undefined,
	} as unknown as ChannelWatchService;

	const jetstream = {
		isReady: parts.natsReady ?? true,
		serverUrl: "nats://127.0.0.1:4222",
	} as unknown as JetStreamService;

	const orchestrator = {
		isDraining: parts.draining ?? false,
		activeChannelCount: 3,
		adoptedChannelCount: parts.engineChannelsAdopted ?? 0,
	} as unknown as ChannelOrchestrator;

	const parkHandoff = {
		stats: { listening: parts.parkListening ?? true, served: parts.parkServed ?? 0 },
		subject: PARK_SUBJECT,
	} as unknown as ParkHandoffService;

	const routing = {
		stats: {
			cached: 2,
			hits: 9,
			kvReads: 1,
			rpcCalls: 0,
			invalidations: 4,
			watchRevision: 0,
			staleRecoveries: parts.routingStaleRecoveries ?? 0,
			watching: parts.routingWatching ?? true,
			...(parts.routingLastWatchEntryAt === undefined
				? {}
				: { lastWatchEntryAt: parts.routingLastWatchEntryAt }),
		},
	} as unknown as RoutingArtifactSource;

	const statuses: number[] = [];
	const reply = {
		status: (code: number) => {
			statuses.push(code);
			return reply;
		},
	} as unknown as FastifyReply;

	const controller = new HealthController(
		ari,
		mediad,
		sipd,
		sipdLiveness,
		engineLiveness,
		channelWatch,
		jetstream,
		orchestrator,
		parkHandoff,
		routing,
		new EventLoopLagMonitor(),
		{} as never,
		{ ENGINE_INSTANCE_ID: "engine-a" } as never,
	);
	return { controller, reply, statuses };
}

describe("/healthz", () => {
	it("reports ok with every dependency up", () => {
		const h = harness();
		const report = h.controller.health(h.reply);

		expect(report.status).toBe("ok");
		// Nothing overrode the 200 the decorator set.
		expect(h.statuses).toEqual([]);
	});

	it("reports the park-handoff responder this instance is running", () => {
		const h = harness({ parkListening: true, parkServed: 7 });
		const report = h.controller.health(h.reply);

		expect(report.park).toEqual({ listening: true, subject: PARK_SUBJECT, served: 7 });
	});

	it("uses mediad readiness and ignores the intentionally idle ARI socket", () => {
		const h = harness({ mediaDriver: "mediad", mediadReady: true, ariConnected: false });
		const report = h.controller.health(h.reply);

		expect(report.status).toBe("ok");
		expect(report.media).toEqual({ driver: "mediad", ready: true });
		expect(report.ari.connected).toBe(false);
		expect(report.mediad).toEqual({
			reachable: true,
			subscription: "subscribed",
			eventsReceived: 12,
			rpc: {},
		});
		expect(h.statuses).toEqual([]);
	});

	it("reports degraded when the selected sipd dialog feed has ended", () => {
		// The state the section exists for: media is fine, NATS is fine, and no call can ever end.
		const h = harness({ mediaDriver: "mediad", sipdSubscription: "closed" });
		const report = h.controller.health(h.reply);

		expect(report.status).toBe("degraded");
		expect(report.sipd).toEqual({
			selected: true,
			subscription: "closed",
			eventsReceived: 5,
			watchingLeases: true,
			liveInstances: ["sipd-7c9f"],
			instancesLost: 0,
			rpc: {},
		});
		expect(h.statuses).toEqual([503]);
	});

	it("ignores the intentionally idle sipd feed under the ARI driver", () => {
		const h = harness({ mediaDriver: "ari", sipdSubscription: "idle" });
		const report = h.controller.health(h.reply);

		expect(report.status).toBe("ok");
		expect(report.sipd.selected).toBe(false);
		expect(h.statuses).toEqual([]);
	});

	it("reports degraded when the selected mediad feed is not ready", () => {
		const h = harness({ mediaDriver: "mediad", mediadReady: false, ariConnected: true });
		const report = h.controller.health(h.reply);

		expect(report.status).toBe("degraded");
		expect(report.media).toEqual({ driver: "mediad", ready: false });
		expect(h.statuses).toEqual([503]);
	});

	it("stays ok when no park-handoff responder is listening", () => {
		// The single-instance answer. A deployment with one engine configures no shared claim bucket
		// and opens no subscription, which is correct rather than degraded — folding it into `status`
		// would take every single-instance deployment out of its load balancer's rotation.
		const h = harness({ parkListening: false });
		const report = h.controller.health(h.reply);

		expect(report.park.listening).toBe(false);
		expect(report.status).toBe("ok");
		expect(h.statuses).toEqual([]);
	});

	it("still reports the park section while draining, so a drain can be watched", () => {
		const h = harness({ draining: true, parkServed: 2 });
		const report = h.controller.health(h.reply);

		expect(report.status).toBe("degraded");
		expect(h.statuses).toEqual([503]);
		// The counter is what tells an operator whether the parked calls have been collected yet.
		expect(report.park.served).toBe(2);
	});

	it("keeps the ok-check answering on the fields the HEALTHCHECK reads", () => {
		for (const parts of [
			{ ariConnected: false },
			{ natsReady: false },
			{ draining: true },
		] satisfies Parts[]) {
			const h = harness(parts);
			expect(h.controller.health(h.reply).status).toBe("degraded");
			expect(h.statuses).toEqual([503]);
		}
	});
});

/**
 * The routing-cache watch's worst failure is a live iterator that has stopped delivering, which is
 * invisible from outside the process. Publishing when it last delivered is what makes it visible —
 * and it must NOT move the status, because a stale artifact still routes calls and a quiet
 * deployment legitimately has nothing to report.
 */
describe("the routing-artifact watch", () => {
	it("reports when the watch last delivered an entry", () => {
		const at = "2026-09-09T17:00:00.000Z";
		const h = harness({ routingLastWatchEntryAt: at });
		expect(h.controller.health(h.reply).routing).toEqual({
			watching: true,
			cached: 2,
			invalidations: 4,
			staleRecoveries: 0,
			lastWatchEntryAt: at,
		});
	});

	it("reports how many times the watch was caught behind the bucket and re-established", () => {
		// Non-zero and still `ok`: the watch recovered on its own, so the rotation must not change.
		// The number is the alert, and it is the only place the flow-control stall is countable.
		const h = harness({ routingStaleRecoveries: 3 });
		const report = h.controller.health(h.reply);
		expect(report.routing.staleRecoveries).toBe(3);
		expect(report.status).toBe("ok");
	});

	it("omits the timestamp on an instance the watch has never delivered to", () => {
		const h = harness();
		expect(h.controller.health(h.reply).routing.lastWatchEntryAt).toBeUndefined();
	});

	it("never takes an instance out of rotation for a watch that is not running", () => {
		const h = harness({ routingWatching: false });
		const report = h.controller.health(h.reply);
		expect(report.routing.watching).toBe(false);
		expect(report.status).toBe("ok");
		expect(h.statuses).toEqual([]);
	});
});

describe("engine liveness and adoption on /healthz", () => {
	/**
	 * Reported, never status-deciding. An instance whose own lease is missing is still handling its
	 * calls correctly — the condition hurts only its PEERS, who may contest its channels — so moving
	 * `status` here would pull a healthy call-handling instance out of rotation and would flap as the
	 * next renewal succeeds. Same terms as `routing.staleRecoveries`.
	 */
	it("reports a lost lease and adopted channels without changing the status", () => {
		const { controller, reply, statuses } = harness({
			engineLeaseHeld: false,
			enginePeersLost: 2,
			engineChannelsAdopted: 5,
			channelWatchStaleRecoveries: 1,
		});
		const body = controller.health(reply);
		expect(body.status).toBe("ok");
		expect(statuses).toEqual([]);
		expect(body.engine.leaseHeld).toBe(false);
		expect(body.engine.peersLost).toBe(2);
		expect(body.engine.channelsAdopted).toBe(5);
		expect(body.engine.channelWatch.staleRecoveries).toBe(1);
		expect(body.engine.instanceId).toBe("engine-a");
	});
});
