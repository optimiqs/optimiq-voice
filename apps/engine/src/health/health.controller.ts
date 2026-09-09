import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import { ChannelOrchestrator } from "../calls/channel-orchestrator.service";
import { AriConnectionService } from "../media/ari-connection.service";
import { MediadService } from "../media/mediad.service";
import { SipdService } from "../media/sipd.service";
import { JetStreamService } from "../nats/jetstream.service";
import { ParkHandoffService } from "../nats/park-handoff.service";
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
		private readonly jetstream: JetStreamService,
		private readonly orchestrator: ChannelOrchestrator,
		private readonly parkHandoff: ParkHandoffService,
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
			},
			sipd: {
				selected: this.sipd.isSelected,
				subscription: this.sipd.subscriptionState,
				eventsReceived: this.sipd.eventCount,
			},
			nats: {
				connected: natsReady,
				server: this.jetstream.serverUrl,
			},
			park: {
				listening: park.listening,
				subject: this.parkHandoff.subject,
				served: park.served,
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
	};
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
	readonly park: {
		readonly listening: boolean;
		/** The instance-scoped subject this engine answers on, so an operator can `nats req` it. */
		readonly subject: string;
		readonly served: number;
	};
}
