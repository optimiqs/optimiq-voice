import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";
import { makeTrunkEvent, validateEvent } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { CALL_EVENTS_CLIENT } from "../nats/nats.tokens";
import { RoutingArtifactSource } from "./routing-artifact.source";
import type { MediaTrunkEndpointStatusEvent, TrunkEndpointStatus } from "../media/media-event";

/**
 * The trunk-health producer: `trunk-endpoint-status` media events become
 * `trunk.evt.v1.<orgId>.<trunkId>.status.changed` on the backbone.
 *
 * ## Why this did not exist, and what changed
 *
 * Asterisk has been qualifying trunks all along (`qualify_frequency` in the PJSIP config) and
 * raising `PeerStatusChange` for every transition — and `packages/media-ari` deliberately dropped
 * it as an unknown event, so `trunk.status` read "unknown" for every trunk forever. The event now
 * has a typed shape, `toMediaEvent` translates it, and this class is the missing half: the thing
 * that turns "PJSIP endpoint carrier-a is Unreachable" into a fact about a tenant's `trunk` row.
 *
 * ## The id mapping: endpoint name → trunk row, resolved HERE, via the routing artifact
 *
 * A `PeerStatusChange` names an ENDPOINT and nothing else — no organization, no row id. The
 * subject this event must be published on requires both, so the resolution cannot be deferred to
 * the API consumer: there is no subject to defer it on. What the engine does hold is every
 * compiled routing artifact its KV watch has seen, and the artifact's `trunk-dial` attempts carry
 * `{ trunkId, name }` pairs where `name` is exactly what the dial template turns into the PJSIP
 * endpoint (`PJSIP/{number}@{trunk}`). `RoutingArtifactSource.findTrunkEndpoint` is that reverse
 * lookup, and its memory-only scope is deliberate — see its own comment.
 *
 * An endpoint no held artifact names is DROPPED, with one warning per endpoint name rather than
 * one per transition. That covers two real shapes: an endpoint that is not a trunk at all (a desk
 * phone with a qualify), and a trunk of an organization whose artifact this process has never
 * held. The second self-heals — the watch replays every artifact key on (re)connect, and the next
 * transition after the artifact lands resolves — and publishing a guessed subject instead would
 * file one tenant's outage under another's row, which is the one failure worse than a stale
 * "unknown".
 *
 * ## Only transitions are published
 *
 * Asterisk already raises the event per transition rather than per tick, and this class keeps a
 * last-published map anyway, because reconnects and driver quirks can repeat a verdict. The event
 * is named `status.changed`; a repeat is not a change, and every publish becomes a `trunk` row
 * UPDATE at the consumer.
 */
@Injectable()
export class TrunkStatusPublisher {
	private readonly logger = getLogger("engine.trunk-status");
	/** endpoint name → last status handed to the broker, for the repeat suppression above. */
	private readonly lastPublished = new Map<string, TrunkEndpointStatus>();
	/** Endpoints already warned about, so an unresolvable qualify target logs once, not forever. */
	private readonly warnedUnresolved = new Set<string>();
	private published = 0;
	private suppressed = 0;
	private unresolved = 0;
	private rejected = 0;

	constructor(
		@Inject(CALL_EVENTS_CLIENT) private readonly client: ClientProxy,
		private readonly routing: RoutingArtifactSource,
	) {}

	/** Counters `/healthz` and the specs read. */
	get stats(): {
		readonly published: number;
		readonly suppressed: number;
		readonly unresolved: number;
		readonly rejected: number;
	} {
		return {
			published: this.published,
			suppressed: this.suppressed,
			unresolved: this.unresolved,
			rejected: this.rejected,
		};
	}

	/**
	 * Handles one qualify transition. Never throws — the caller is the media-event dispatch, and a
	 * carrier's reachability report must not be able to end anything.
	 */
	async handle(event: MediaTrunkEndpointStatusEvent): Promise<void> {
		if (this.lastPublished.get(event.endpoint) === event.status) {
			this.suppressed += 1;
			return;
		}

		const resolved = this.routing.findTrunkEndpoint(event.endpoint);
		if (resolved === undefined) {
			this.unresolved += 1;
			if (!this.warnedUnresolved.has(event.endpoint)) {
				this.warnedUnresolved.add(event.endpoint);
				this.logger.warn(
					{ endpoint: event.endpoint, status: event.status },
					"a qualify transition names an endpoint no held routing artifact calls a trunk; " +
						"dropping it (this logs once per endpoint)",
				);
			}
			return;
		}

		try {
			const envelope = makeTrunkEvent("status.changed", {
				orgId: resolved.organizationId,
				trunkId: resolved.trunkId,
				source: "engine",
				data: {
					status: event.status,
					reason: event.reason,
					...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
					endpoint: event.endpoint,
				},
			});
			// The same second check `CallEventPublisher` makes: the cross-check that catches an
			// envelope whose orgId disagrees with its own subject's org token.
			validateEvent(envelope.subject, envelope);
			await firstValueFrom(this.client.emit(envelope.subject, envelope));
			this.published += 1;
			// Recorded only AFTER the broker took it: a failed publish must stay a change so the
			// next transition (or retry) is not suppressed into permanence.
			this.lastPublished.set(event.endpoint, event.status);
			this.logger.info(
				{
					endpoint: event.endpoint,
					trunkId: resolved.trunkId,
					status: event.status,
					latencyMs: event.latencyMs,
				},
				"trunk status transition published",
			);
		} catch (error) {
			this.rejected += 1;
			this.logger.error(
				{ endpoint: event.endpoint, status: event.status, err: String(error) },
				"failed to publish a trunk status transition",
			);
		}
	}
}
