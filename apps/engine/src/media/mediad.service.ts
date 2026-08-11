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

/**
 * Owns the `mediad` media plane: the command transport, the boot-time readiness check, and the
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
	private draining = false;

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
		await this.assertReachable();
	}

	private async assertReachable(): Promise<void> {
		const probeSessionId = `engine-boot-probe-${Date.now()}`;
		try {
			await this.port.releaseSession(probeSessionId);
		} catch (error) {
			throw new Error(
				"ENGINE_MEDIA_DRIVER=mediad, but no mediad answered " +
					`${RPC_SUBJECTS.mediaReleaseSession} on ${this.jetstream.serverUrl}. ` +
					"Start apps/mediad, or set ENGINE_MEDIA_DRIVER=ari to serve media with Asterisk. " +
					`(${String(error)})`,
			);
		}
		this.logger.info(
			{ timeoutMs: this.env.ENGINE_MEDIAD_RPC_TIMEOUT_MS },
			"mediad answered the boot probe; the media plane is apps/mediad",
		);
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
	 */
	async start(): Promise<void> {
		if (!this.isSelected) {
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
		const decoder = new TextDecoder();

		void (async () => {
			for await (const message of subscription) {
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
					// A throw inside a subscription's async iterator would end the subscription and
					// take the whole media event feed with it, which is a far worse outcome than one
					// dropped message.
					this.logger.error(
						{ subject: message.subject, err: String(error) },
						"failed to handle a media event",
					);
				}
			}
			if (!this.draining) {
				this.logger.warn({ filter }, "the media event subscription ended unexpectedly");
			}
		})();

		this.logger.info({ filter }, "subscribed to the mediad event feed");
		await Promise.resolve();
	}

	async onApplicationShutdown(): Promise<void> {
		this.draining = true;
		// `drain` delivers what is already in flight before closing; `unsubscribe` would drop it,
		// and the messages in flight during a shutdown are the ends of the calls being drained.
		await this.subscription?.drain();
		this.subscription = undefined;
	}
}
