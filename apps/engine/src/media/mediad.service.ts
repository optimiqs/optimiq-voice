import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { RPC_SUBJECTS, subjectFilterFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV } from "../nats/nats.tokens";
import { decodeMediadEvent } from "./mediad-event-mapping";
import { MediadMediaPort } from "./mediad-media.port";
import { NatsMediadTransport } from "./mediad-transport";
import type { EngineEnv } from "../config/engine-env";
import type { MediaEvent } from "./media-event";
import type { Subscription } from "nats";

export const MEDIAD_REACHABILITY_PROBE_INTERVAL_MS = 5_000;

/**
 * Owns the `mediad` media plane: the command transport, continuous reachability checks, and the
 * event subscription.
 *
 * The counterpart of `AriConnectionService`, and deliberately the same shape — a handler is
 * registered, then `start()` is called explicitly — so that whichever driver is selected, the
 * engine's start-up sequence reads the same way.
 *
 * ## Why it refuses to boot rather than degrading
 *
 * `ENGINE_MEDIA_DRIVER=mediad` is an operator saying "serve media from the Go plane". If no
 * `mediad` answers, the honest outcome is a process that does not start. The alternative — booting
 * and failing per call — is the failure mode this whole design keeps rejecting: a service that
 * looks healthy and answers no calls, discovered by a customer rather than by a deploy.
 *
 * The check is a real request on a real subject, not a config assertion: `release-session` for an
 * id nothing holds, which any live instance answers `ok: true, released: false` in microseconds and
 * which changes no state. A config-only check would prove that somebody set a variable.
 */
@Injectable()
export class MediadService implements OnModuleInit, OnApplicationShutdown {
	private readonly logger = getLogger("engine.mediad");

	readonly port: MediadMediaPort;
	private handler: ((event: MediaEvent) => void) | undefined;
	private subscription: Subscription | undefined;
	private reachable = false;
	private subscriptionStateValue: MediadSubscriptionState = "idle";
	private eventsReceived = 0;
	private draining = false;
	private probeTimer: ReturnType<typeof setInterval> | undefined;
	private probeInFlight: Promise<boolean> | undefined;
	private probeSequence = 0;
	private hasProbed = false;
	private lastProbeError: string | undefined;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
	) {
		this.port = new MediadMediaPort(
			new NatsMediadTransport(() => this.jetstream.rawConnection),
			env.ENGINE_MEDIAD_RPC_TIMEOUT_MS,
		);
	}

	/** Whether this driver is the selected one. Read by the module factory and by `/healthz`. */
	get isSelected(): boolean {
		return this.env.ENGINE_MEDIA_DRIVER === "mediad";
	}

	/** Whether the latest reachability probe received a valid reply from mediad. */
	get isReachable(): boolean {
		return this.reachable;
	}

	/** The live event feed's state, exposed to readiness and operators. */
	get subscriptionState(): MediadSubscriptionState {
		return this.subscriptionStateValue;
	}

	/** A selected mediad plane is ready only while both its probes and event subscription succeed. */
	get isReady(): boolean {
		return this.isSelected && this.reachable && this.subscriptionStateValue === "subscribed";
	}

	get eventCount(): number {
		return this.eventsReceived;
	}

	/**
	 * Registers the sink for media events. Must be called before {@link start}.
	 *
	 * Same contract as `AriConnectionService.setEventHandler`: the handler receives
	 * {@link MediaEvent}, never `mediad`'s own envelopes, so the orchestrator above cannot tell the
	 * two media planes apart.
	 */
	setEventHandler(handler: (event: MediaEvent) => void): void {
		this.handler = handler;
	}

	/**
	 * Proves a `mediad` is reachable.
	 *
	 * Runs on module init rather than from `main.ts` so that a deployment which has selected this
	 * driver cannot start without one, whatever calls `start()` later.
	 */
	async onModuleInit(): Promise<void> {
		if (!this.isSelected) {
			return;
		}
		if (!(await this.probeReachability())) {
			throw new Error(
				"ENGINE_MEDIA_DRIVER=mediad, but no mediad answered " +
					`${RPC_SUBJECTS.mediaReleaseSession} on ${this.jetstream.serverUrl}. ` +
					"Start apps/mediad, or set ENGINE_MEDIA_DRIVER=ari to serve media with Asterisk. " +
					`(${this.lastProbeError ?? "unknown probe failure"})`,
			);
		}
		this.startReachabilityProbes();
		this.logger.info(
			{ timeoutMs: this.env.ENGINE_MEDIAD_RPC_TIMEOUT_MS },
			"mediad answered the boot probe; the media plane is apps/mediad",
		);
	}

	/** Runs one coalesced liveness probe. A failure degrades readiness until a later probe succeeds. */
	async probeReachability(): Promise<boolean> {
		if (!this.isSelected || this.draining) {
			return false;
		}
		const inFlight = this.probeInFlight;
		if (inFlight !== undefined) {
			return await inFlight;
		}

		const probe = this.runReachabilityProbe();
		this.probeInFlight = probe;
		try {
			return await probe;
		} finally {
			if (this.probeInFlight === probe) {
				this.probeInFlight = undefined;
			}
		}
	}

	private async runReachabilityProbe(): Promise<boolean> {
		const wasReachable = this.reachable;
		const hadProbed = this.hasProbed;
		this.hasProbed = true;
		this.probeSequence += 1;
		try {
			await this.port.releaseSession(
				`engine-reachability-probe-${Date.now()}-${this.probeSequence}`,
			);
			this.reachable = true;
			this.lastProbeError = undefined;
			if (hadProbed && !wasReachable) {
				this.logger.info({}, "mediad reachability recovered");
			}
			return true;
		} catch (error) {
			this.reachable = false;
			this.lastProbeError = String(error);
			if (hadProbed && wasReachable) {
				this.logger.warn(
					{ err: this.lastProbeError },
					"mediad stopped answering reachability probes; readiness is degraded",
				);
			}
			return false;
		}
	}

	private startReachabilityProbes(): void {
		if (this.probeTimer !== undefined || this.draining) {
			return;
		}
		this.probeTimer = setInterval(() => {
			void this.probeReachability();
		}, MEDIAD_REACHABILITY_PROBE_INTERVAL_MS);
		this.probeTimer.unref?.();
	}

	private stopReachabilityProbes(): void {
		if (this.probeTimer !== undefined) {
			clearInterval(this.probeTimer);
			this.probeTimer = undefined;
		}
	}

	/**
	 * Subscribes to the media plane's lifecycle events.
	 *
	 * A CORE subscription on a subject a JetStream stream also captures, which is not a
	 * contradiction: a JetStream publish is a publish, so a core subscriber sees it live while the
	 * MEDIA stream keeps it for whoever needs it later. The engine wants the former — a leg to tear
	 * down NOW — and must not pay for a durable consumer's ack round trip on the call path.
	 *
	 * Org-wide (`media.evt.v1.>`) rather than per session, which is why `watchChannel` has nothing
	 * to do under this driver: there is no per-leg subscription that could stop early.
	 *
	 * This subscription MUST NOT use a queue group. Admission is made exclusive with a `channels` KV
	 * compare-and-set before an orchestrator creates local state; after that, every replica may see
	 * the wire event, but only the owner has the channel registry/signals that can act on it. Queueing
	 * this feed would let NATS deliver a later DTMF or end event to a non-owner and strand the owner.
	 */
	async start(): Promise<void> {
		if (!this.isSelected) {
			return;
		}
		if (this.subscription !== undefined) {
			return;
		}
		const handler = this.handler;
		if (handler === undefined) {
			throw new Error("MediadService.start() called before an event handler was set.");
		}
		const connection = this.jetstream.rawConnection;
		if (connection === undefined) {
			throw new Error("MediadService.start() called before the NATS connection was open.");
		}

		const filter = subjectFilterFor.allMedia();
		this.subscription = connection.subscribe(filter);
		const subscription = this.subscription;
		try {
			// `subscribe` is local until the server processes its SUB command. The flush pong is the
			// barrier that proves no event published after `start()` returns can outrun this subscriber.
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
						const decoded = decodeMediadEvent(
							message.subject,
							JSON.parse(decoder.decode(message.data)) as unknown,
						);
						if (decoded === undefined) {
							// Poison, or an event from a newer `mediad` this contract version has never
							// heard of. Logged and dropped: additive evolution is the rule everywhere on
							// this backbone, so an unknown event is a normal outcome, not an error.
							this.logger.debug({ subject: message.subject }, "ignoring an unreadable media event");
							continue;
						}
						if (decoded.event !== undefined) {
							handler(decoded.event);
						}
					} catch (error) {
						// A throw while handling one message must not end the whole media event feed.
						this.logger.error(
							{ subject: message.subject, err: String(error) },
							"failed to handle a media event",
						);
					}
				}
			} catch (error) {
				this.logger.error({ filter, err: String(error) }, "the media event subscription failed");
			} finally {
				if (this.subscription === subscription) {
					this.subscription = undefined;
				}
				this.subscriptionStateValue = "closed";
				if (!this.draining) {
					this.logger.warn({ filter }, "the media event subscription ended unexpectedly");
				}
			}
		})();

		this.logger.info({ filter }, "subscribed to the mediad event feed");
	}

	async onApplicationShutdown(): Promise<void> {
		this.draining = true;
		this.stopReachabilityProbes();
		await this.probeInFlight;
		// `drain` delivers what is already in flight before closing; `unsubscribe` would drop it,
		// and the messages in flight during a shutdown are the ends of the calls being drained.
		const subscription = this.subscription;
		await subscription?.drain();
		this.subscription = undefined;
		this.subscriptionStateValue = "closed";
	}
}

export type MediadSubscriptionState = "idle" | "subscribed" | "closed";
