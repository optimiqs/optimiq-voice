import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import { AriConnectionService } from "../media/ari-connection.service";
import { JetStreamService } from "../nats/jetstream.service";
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
 * ## Why the ARI socket is the deciding dependency
 *
 * An engine whose REST client works but whose event socket is down is the worst possible state:
 * it looks alive, it answers health checks, and it silently answers no calls, because every call
 * begins with a `StasisStart` on that socket. So the socket, not the HTTP port, is what "healthy"
 * means here.
 */
@Controller()
export class HealthController {
	constructor(
		private readonly ari: AriConnectionService,
		private readonly jetstream: JetStreamService,
		private readonly orchestrator: ChannelOrchestrator,
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
		const natsReady = this.jetstream.isReady;
		const draining = this.orchestrator.isDraining;

		return {
			status: ariConnected && natsReady && !draining ? "ok" : "degraded",
			draining,
			activeChannels: this.orchestrator.activeChannelCount,
			ari: {
				connected: ariConnected,
				stream: this.ari.streamStatus,
				application: this.ari.applicationName,
				asteriskVersion: this.ari.asteriskVersion,
				eventsReceived: this.ari.eventCount,
			},
			nats: {
				connected: natsReady,
				server: this.jetstream.serverUrl,
			},
		};
	}
}

export interface HealthReport {
	readonly status: "ok" | "degraded";
	readonly draining: boolean;
	readonly activeChannels: number;
	readonly ari: {
		readonly connected: boolean;
		readonly stream: string;
		readonly application: string;
		readonly asteriskVersion?: string;
		readonly eventsReceived: number;
	};
	readonly nats: {
		readonly connected: boolean;
		readonly server: string;
	};
}
