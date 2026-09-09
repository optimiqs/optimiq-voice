import {
	Inject,
	Injectable,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
} from "@nestjs/common";
import {
	engineRenegotiateRequestSchema,
	subjectFor,
	type EngineRenegotiateResponse,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { SplitPlaneMediaPort } from "./split-plane.port";
import type { EngineEnv } from "../config/engine-env";
import type { MediaPort } from "./media-port";
import type { Subscription } from "nats";

@Injectable()
export class SipRenegotiateService implements OnApplicationBootstrap, OnApplicationShutdown {
	private subscription?: Subscription;
	private draining = false;
	private readonly active = new Set<string>();
	private readonly logger = getLogger("engine.sip-renegotiate");
	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		private readonly jetstream: JetStreamService,
		@Inject(MEDIA_PORT) private readonly media: MediaPort,
	) {}

	onApplicationBootstrap(): void {
		if (this.subscription || !(this.media instanceof SplitPlaneMediaPort)) return;
		this.subscription = this.jetstream.rawConnection?.subscribe(
			subjectFor.engineRenegotiateRpc(this.env.ENGINE_INSTANCE_ID),
			{
				callback: (error, message) => {
					if (error) {
						this.logger.error({ err: error }, "SDP subscription failed");
						return;
					}
					void this.answer(message.data).then((reply) =>
						message.respond(new TextEncoder().encode(JSON.stringify(reply))),
					);
				},
			},
		);
	}

	async answer(data: Uint8Array): Promise<EngineRenegotiateResponse> {
		const parsed = engineRenegotiateRequestSchema.safeParse(
			(() => {
				try {
					return JSON.parse(new TextDecoder().decode(data));
				} catch {
					return undefined;
				}
			})(),
		);
		if (!parsed.success) return { ok: false, legId: "", reason: "bad_request" };
		const request = parsed.data;
		if (this.draining) return { ok: false, legId: request.legId, reason: "shutting_down" };
		if (!(this.media instanceof SplitPlaneMediaPort))
			return { ok: false, legId: request.legId, reason: "not_supported" };
		if (this.active.has(request.legId) || this.active.size >= 128)
			return { ok: false, legId: request.legId, reason: "internal" };
		this.active.add(request.legId);
		try {
			return await this.media.renegotiate(request);
		} catch (error) {
			this.logger.warn({ legId: request.legId, err: String(error) }, "SDP renegotiation failed");
			return { ok: false, legId: request.legId, reason: "internal" };
		} finally {
			this.active.delete(request.legId);
		}
	}

	onApplicationShutdown(): void {
		this.draining = true;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	}
}
