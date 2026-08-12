import { describe, expect, it } from "bun:test";
import { HealthController } from "./health.controller";
import type { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import type { AriConnectionService } from "../media/ari-connection.service";
import type { MediadService } from "../media/mediad.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { ParkHandoffService } from "../nats/park-handoff.service";
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
	readonly natsReady?: boolean;
	readonly draining?: boolean;
	readonly parkListening?: boolean;
	readonly parkServed?: number;
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
	} as unknown as MediadService;

	const jetstream = {
		isReady: parts.natsReady ?? true,
		serverUrl: "nats://127.0.0.1:4222",
	} as unknown as JetStreamService;

	const orchestrator = {
		isDraining: parts.draining ?? false,
		activeChannelCount: 3,
	} as unknown as ChannelOrchestrator;

	const parkHandoff = {
		stats: { listening: parts.parkListening ?? true, served: parts.parkServed ?? 0 },
		subject: PARK_SUBJECT,
	} as unknown as ParkHandoffService;

	const statuses: number[] = [];
	const reply = {
		status: (code: number) => {
			statuses.push(code);
			return reply;
		},
	} as unknown as FastifyReply;

	const controller = new HealthController(ari, mediad, jetstream, orchestrator, parkHandoff);
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
		});
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
