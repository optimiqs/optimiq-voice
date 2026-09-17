import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { subjectFilterFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV } from "../nats/nats.tokens";
import { decodeSipdEvent } from "./sipd-event-mapping";
import type { EngineEnv } from "../config/engine-env";
import type { MediaEvent } from "./media-event";
import type { Subscription } from "nats";

/**
 * The signalling plane's event feed: `sip.evt.v1.>` into the engine's own {@link MediaEvent} union.
 *
 * The counterpart of `MediadService`'s subscription half, and deliberately the same shape — a handler
 * is registered, then `start()` is called explicitly — so the engine's start-up sequence reads the
 * same way whichever planes are in play. What it deliberately does NOT have is `MediadService`'s
 * command half: commands towards the edge go out through {@link import("../nats/sipd-command.client").SipdCommandClient},
 * which is owned by the composite `MediaPort` rather than by a subscription service.
 *
 * ## Why this is a SECOND source rather than a replacement
 *
 * Under the split plane a leg's facts arrive from two processes at once. `mediad` reports what
 * happened to the audio (`session.ended`, `dtmf.received` off RFC 4733, recordings); `sipd` reports
 * what happened to the dialog (`dialog.answered`, `dialog.terminated`, INFO digits). Both map into
 * one union and both are handed to the same `ChannelOrchestrator.handleEvent`, which is the whole
 * claim of `plans/sipd-invite-design.md` §7.1: the layer above cannot tell which plane spoke.
 *
 * ## Why a CORE subscription on a subject a JetStream stream also captures
 *
 * Not a contradiction — a JetStream publish is a publish, so a core subscriber sees it live while the
 * `SIP` stream keeps it for whoever needs it later. The engine wants the former: a leg torn down NOW
 * on a `dialog.terminated`, without paying for a durable consumer's ack round trip on the call path.
 * The identical argument `MediadService` makes for `media.evt.v1.>`, and §10.2 states it again for
 * this family.
 *
 * **And no queue group, for the reason stated on `MediadService.start`.** Admission is made exclusive
 * with a `channels` KV compare-and-set before an orchestrator creates local state; after that every
 * replica may see the wire event and only the owner has the registry and signals that can act on it.
 * Queueing this feed would let NATS hand a `dialog.terminated` to a non-owner and strand the owner
 * holding a leg for a call that ended.
 *
 * ## Why there is no boot probe, where `MediadService` has one
 *
 * `MediadService.onModuleInit` refuses to start when no `mediad` answers, because
 * `ENGINE_MEDIA_DRIVER=mediad` is an operator asserting a dependency that must exist. There is no
 * equivalent assertion for this feed and inventing one would be worse than useless: an engine with no
 * `sipd` reachable is a completely normal deployment (every ARI deployment is one), calls arrive on
 * this plane by ADMISSION rather than by subscription, and the honest failure of an absent edge is
 * "no INVITE ever arrives" — which needs no probe to be visible. `apps/sipd`'s own liveness is its
 * `sip-dialogs` claim lease (§6.2), not a synthetic request from here.
 */
@Injectable()
export class SipdService implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.sipd");

	private handler: ((event: MediaEvent) => void) | undefined;
	private subscription: Subscription | undefined;
	private subscriptionStateValue: SipdSubscriptionState = "idle";
	private eventsReceived = 0;
	private draining = false;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {}

	/**
	 * Whether this deployment signals on `apps/sipd`.
	 *
	 * Read off `ENGINE_MEDIA_DRIVER` and not off a signalling switch of its own, and that is a
	 * placeholder with a date on it rather than a shortcut. §3.5 adds `ENGINE_SIGNALLING_DRIVER` and
	 * refuses the one illegal combination — signalling on `sipd`, media on ARI — at BOOT, because
	 * `sipd` holds no ARI credential and no channel name and every call on that pairing would fail
	 * after starting successfully. Until that variable exists, `mediad` is the only media plane a
	 * `sipd`-signalled call can possibly use, so keying off it selects exactly the same deployments
	 * and refuses exactly the same one. `placeInvitedCall` states the same gate on the admission side,
	 * which is where a refused INVITE gets a SIP status a caller can act on.
	 */
	get isSelected(): boolean {
		return this.env.ENGINE_MEDIA_DRIVER === "mediad";
	}

	get subscriptionState(): SipdSubscriptionState {
		return this.subscriptionStateValue;
	}

	get eventCount(): number {
		return this.eventsReceived;
	}

	/**
	 * Registers the sink for dialog events. Must be called before {@link start}.
	 *
	 * Same contract as `AriConnectionService.setEventHandler` and `MediadService.setEventHandler`: the
	 * handler receives {@link MediaEvent} and never `sipd`'s own envelopes.
	 */
	setEventHandler(handler: (event: MediaEvent) => void): void {
		this.handler = handler;
	}

	/** Subscribes to the dialog feed. A no-op on a deployment that does not signal on `sipd`. */
	async start(): Promise<void> {
		if (!this.isSelected || this.subscription !== undefined) {
			return;
		}
		const handler = this.handler;
		if (handler === undefined) {
			throw new Error("SipdService.start() called before an event handler was set.");
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			throw new Error("SipdService.start() called before the NATS connection was open.");
		}

		const filter = subjectFilterFor.allSipDialogs();
		this.subscription = connection.subscribe(filter);
		const subscription = this.subscription;
		try {
			// `subscribe` is local until the server processes its SUB command. The flush pong is the
			// barrier that proves no dialog event published after `start()` returns can outrun this
			// subscriber — which on this family means a `dialog.terminated` for a call admitted moments
			// later, and therefore a leg the engine would hold forever.
			await connection.flush();
		} catch (error) {
			if (this.subscription === subscription) {
				this.subscription = undefined;
			}
			subscription.unsubscribe();
			this.subscriptionStateValue = "closed";
			throw error;
		}
		this.subscriptionStateValue = "subscribed";
		const decoder = new TextDecoder();

		void (async () => {
			try {
				for await (const message of subscription) {
					this.eventsReceived += 1;
					try {
						const decoded = decodeSipdEvent(
							message.subject,
							JSON.parse(decoder.decode(message.data)) as unknown,
						);
						if (decoded === undefined) {
							// Poison, or an event from a newer `sipd` this contract version has never heard
							// of. Logged and dropped: additive evolution is the rule everywhere on this
							// backbone, so an unknown event is a normal outcome and not an error.
							this.logger.debug(
								{ subject: message.subject },
								"ignoring an unreadable sip dialog event",
							);
							continue;
						}
						if (decoded.event !== undefined) {
							handler(decoded.event);
						}
					} catch (error) {
						// A throw while handling one message must not end the whole dialog feed: the next
						// message is somebody else's call ending.
						this.logger.error(
							{ subject: message.subject, err: String(error) },
							"failed to handle a sip dialog event",
						);
					}
				}
			} catch (error) {
				this.logger.error({ filter, err: String(error) }, "the sip dialog subscription failed");
			} finally {
				if (this.subscription === subscription) {
					this.subscription = undefined;
				}
				this.subscriptionStateValue = "closed";
				if (!this.draining) {
					this.logger.warn({ filter }, "the sip dialog subscription ended unexpectedly");
				}
			}
		})();

		this.logger.info({ filter }, "subscribed to the sipd dialog feed");
	}

	async onApplicationShutdown(): Promise<void> {
		this.draining = true;
		// `drain` delivers what is already in flight before closing; `unsubscribe` would drop it, and
		// the messages in flight during a shutdown are the ends of the calls being drained.
		const subscription = this.subscription;
		await subscription?.drain();
		this.subscription = undefined;
		this.subscriptionStateValue = "closed";
	}
}

export type SipdSubscriptionState = "idle" | "subscribed" | "closed";
