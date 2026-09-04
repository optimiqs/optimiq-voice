import { Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV, MEDIA_PORT } from "../nats/nats.tokens";
import { SipdCommandClient } from "../nats/sipd-command.client";
import { AriConnectionService } from "./ari-connection.service";
import { AriMediaAdapter } from "./ari-media.adapter";
import { MediadService } from "./mediad.service";
import { SipdService } from "./sipd.service";
import { SplitPlaneMediaPort } from "./split-plane.port";
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
		// The signalling plane's EVENT half. Not a `MEDIA_PORT` candidate and never will be: it serves
		// no command, it only turns `sip.evt.v1` into the same union the two drivers above produce. It
		// is constructed unconditionally for the reason the other two are — the factory below stays a
		// one-line choice — and starts only on a deployment that signals on `apps/sipd`.
		SipdService,
		{
			provide: MEDIA_PORT,
			useFactory: (
				env: EngineEnv,
				ari: AriConnectionService,
				mediad: MediadService,
				jetstream: JetStreamService,
			): MediaPort => {
				if (env.ENGINE_MEDIA_DRIVER === "mediad") {
					// The COMPOSITE (split-plane) port of `plans/sipd-invite-design.md` §3.2: signalling on
					// `apps/sipd`, media on `apps/mediad`. This is the first `MediaPort` for which `answer`,
					// `ring` and `originate` are servable — they become compositions of a `mediad` session
					// and a `sipd` dialog command rather than the refusals `MediadMediaPort` returns on its
					// own. The one illegal pairing (signalling on `sipd`, media on Asterisk) is refused per
					// call in `placeInvitedCall` until `ENGINE_SIGNALLING_DRIVER` refuses it at boot (§3.5).
					//
					// `SipdCommandClient` reads the live NATS connection each call rather than capturing it,
					// because Nest builds providers before it opens the connection in
					// `JetStreamService.onModuleInit` — the same accessor `NatsMediadTransport` uses.
					getLogger("engine.media").warn(
						{ driver: "mediad", signalling: "sipd" },
						"ENGINE_MEDIA_DRIVER=mediad: media is served by apps/mediad and signalling by " +
							"apps/sipd via the composite split-plane MediaPort. answer/ring/originate/hangup " +
							"are compositions across both planes; operations above the built rungs (early " +
							"media, re-INVITE hold, conferencing) still FAIL LOUDLY rather than silently do " +
							"nothing. See SplitPlaneMediaPort and MediadMediaPort for the coverage map.",
					);
					return new SplitPlaneMediaPort(
						mediad.port,
						new SipdCommandClient(() => jetstream.rawConnection),
					);
				}
				return new AriMediaAdapter(ari.client, ari.applicationName);
			},
			inject: [ENGINE_ENV, AriConnectionService, MediadService, JetStreamService],
		},
	],
	exports: [AriConnectionService, MediadService, SipdService, MEDIA_PORT],
})
export class AriModule {}
