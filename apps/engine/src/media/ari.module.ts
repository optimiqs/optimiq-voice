import { Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { AriConnectionService } from "./ari-connection.service";
import { AriMediaAdapter } from "./ari-media.adapter";
import { MediadService } from "./mediad.service";
import type { EngineEnv } from "../config/engine-env";
import type { MediaPort } from "./media-port";

/**
 * The media plane, as the engine sees it.
 *
 * The only place `AriClient` is constructed, the only place `AriMediaAdapter` is named, and now the
 * only place the media plane is CHOSEN. Everything downstream injects {@link MEDIA_PORT} and
 * therefore depends on the domain contract in `media-port.ts`, not on Asterisk and not on `mediad`
 * — which is the claim plan §8 risk 1 rests on, made structural.
 *
 * ## The switch, and why it defaults to `ari`
 *
 * `ENGINE_MEDIA_DRIVER` picks one, and it defaults to `ari` for as long as the capability ladder in
 * `plans/mediad-design.md` §2 is unfinished. A deployment that does not opt in gets exactly the
 * behaviour it had before the variable existed — zero behaviour change by default is what makes the
 * cutover revertible by configuration rather than by a rollback.
 *
 * Both services are constructed either way, and only the selected one creates a client or starts:
 * `MediadService` skips its boot probe and subscription when it is not selected, while
 * `AriConnectionService` does not even construct an `AriClient` under mediad. Constructing both
 * providers keeps the factory below a one-line choice without making mediad require ARI credentials.
 */
@Module({
	providers: [
		AriConnectionService,
		MediadService,
		{
			provide: MEDIA_PORT,
			useFactory: (env: EngineEnv, ari: AriConnectionService, mediad: MediadService): MediaPort => {
				if (env.ENGINE_MEDIA_DRIVER === "mediad") {
					getLogger("engine.media").warn(
						{ driver: "mediad" },
						"ENGINE_MEDIA_DRIVER=mediad: media is served by apps/mediad at rung 2 (bridged " +
							"G.711 calls). Every operation above that rung — playback, recording, hold, " +
							"music on hold, DTMF generation, conferencing — will FAIL LOUDLY rather than " +
							"silently do nothing. See MediadMediaPort for the coverage map.",
					);
					return mediad.port;
				}
				return new AriMediaAdapter(ari.client, ari.applicationName);
			},
			inject: [ENGINE_ENV, AriConnectionService, MediadService],
		},
	],
	exports: [AriConnectionService, MediadService, MEDIA_PORT],
})
export class AriModule {}
