import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { AriClient } from "@optimiq-voice/media-ari";
import { toMediaEvent } from "../calls/ari-mapping";
import { ENGINE_ENV } from "../nats/nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { MediaEvent } from "./media-event";
import type { AriEventStream, AriStreamStatus } from "@optimiq-voice/media-ari";

/**
 * Owns the ARI connection: the REST client and the event socket.
 *
 * Deliberately NOT `OnModuleInit`. The socket is started explicitly by `main.ts` AFTER the
 * orchestrator's handler is registered, because a `StasisStart` that arrives before there is
 * anything to handle it is a call that rings forever. Nest's init order would make that ordering
 * implicit and therefore fragile; a start-up sequence that matters should be written down.
 *
 * ## It is also the event seam's boundary
 *
 * ARI events are translated to {@link MediaEvent} HERE, before the handler sees them, so nothing
 * above this class ever holds an `AriEvent`. Together with `ari-media.adapter.ts` on the command
 * side, that makes this file and `calls/ari-mapping.ts` the complete list of places a media-server
 * swap has to touch.
 */
@Injectable()
export class AriConnectionService implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.ari");

	readonly client: AriClient;
	private stream: AriEventStream | undefined;
	private handler: ((event: MediaEvent) => void) | undefined;
	private version: string | undefined;

	constructor(@Inject(ENGINE_ENV) private readonly env: EngineEnv) {
		this.client = new AriClient({
			baseUrl: env.ARI_URL,
			username: env.ARI_USERNAME,
			password: env.ARI_PASSWORD,
			app: env.ARI_APP,
			subscribeAll: env.ARI_SUBSCRIBE_ALL,
			timeoutMs: env.ARI_REQUEST_TIMEOUT_MS,
		});
	}

	get applicationName(): string {
		return this.env.ARI_APP;
	}

	get streamStatus(): AriStreamStatus {
		return this.stream?.status ?? "idle";
	}

	get isConnected(): boolean {
		return this.stream?.isOpen ?? false;
	}

	get asteriskVersion(): string | undefined {
		return this.version;
	}

	get eventCount(): number {
		return this.stream?.eventCount ?? 0;
	}

	/**
	 * Registers the sink for media events. Must be called before {@link start}.
	 *
	 * The handler receives {@link MediaEvent}, never ARI's own union: an ARI event the engine does
	 * not consume is dropped by `toMediaEvent` and never reaches it at all.
	 */
	setEventHandler(handler: (event: MediaEvent) => void): void {
		this.handler = handler;
	}

	/**
	 * Proves the credentials, then opens the event socket.
	 *
	 * Both steps fail fast. A wrong ARI password must stop the process at boot rather than surface
	 * as a `401` on the first inbound call, and an event socket that never opens means the engine
	 * is running but deaf — which looks healthy and answers nothing.
	 */
	async start(): Promise<void> {
		if (this.handler === undefined) {
			throw new Error("AriConnectionService.start() called before an event handler was set.");
		}

		const info = await this.client.ping();
		this.version = info.version;
		this.logger.info(
			{ app: this.env.ARI_APP, asterisk: info.version },
			"connected to the ARI REST endpoint",
		);

		const handler = this.handler;
		this.stream = this.client.createEventStream({
			onEvent: (event) => {
				// The seam, applied at the edge. An event with no domain meaning stops here rather
				// than reaching a handler that would have to know ARI's names to ignore it.
				const media = toMediaEvent(event);
				if (media !== undefined) {
					handler(media);
				}
			},
			onStatusChange: (status) => {
				this.logger.info({ status }, "ARI event socket status changed");
			},
			onError: (error) => {
				this.logger.error({ err: String(error) }, "ARI event socket error");
			},
			onGap: (gap) => {
				// ARI has no replay: events during the gap are gone. Logged at WARN because it is
				// the one signal that in-memory channel state may now disagree with the media
				// server, and the operator's cue to expect orphaned legs.
				this.logger.warn(
					{
						downtimeMs: gap.downtimeMs,
						attempts: gap.attempts,
						eventsBeforeGap: gap.eventsBeforeGap,
					},
					"ARI event socket reconnected — events during the outage were lost",
				);
			},
		});

		await this.stream.start();
		this.logger.info({ url: this.stream.redactedUrl }, "ARI event socket open");
	}

	async onApplicationShutdown(): Promise<void> {
		this.stream?.close();
		this.stream = undefined;
		await Promise.resolve();
	}
}
