import { Module } from "@nestjs/common";
import { MEDIA_PORT } from "../nats/nats.tokens";
import { AriConnectionService } from "./ari-connection.service";
import { AriMediaAdapter } from "./ari-media.adapter";
import type { MediaPort } from "./media-port";

/**
 * The media plane, as the engine sees it.
 *
 * The only place `AriClient` is constructed, and the only place `AriMediaAdapter` is named.
 * Everything downstream injects {@link MEDIA_PORT} and therefore depends on the domain contract in
 * `media-port.ts`, not on Asterisk. Swapping in `apps/mediad` is a change to the `useFactory`
 * below and nothing else — which is the claim plan §8 risk 1 rests on, made structural.
 */
@Module({
	providers: [
		AriConnectionService,
		{
			provide: MEDIA_PORT,
			useFactory: (connection: AriConnectionService): MediaPort =>
				new AriMediaAdapter(connection.client, connection.applicationName),
			inject: [AriConnectionService],
		},
	],
	exports: [AriConnectionService, MEDIA_PORT],
})
export class AriModule {}
