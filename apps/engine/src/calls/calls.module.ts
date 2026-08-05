import { Module } from "@nestjs/common";
import { AriModule } from "../ari/ari.module";
import { CALLS_EFFECT_RUNTIME, MEDIA_PORT } from "../nats/nats.tokens";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { makeVerbExecutorRuntime } from "../verbs/verb-executor";
import { ChannelOrchestrator } from "./channel-orchestrator.service";
import type { MediaPort } from "../ari/media-port";

/**
 * The call-handling feature slice.
 *
 * The Effect runtime is provided under a **Symbol token** via `useFactory`, per the oikos seam
 * (`plans/reference/oikos-conventions.md` §3): `ModuleEffectRuntime` implements
 * `OnApplicationShutdown`, so Nest disposes it — and therefore runs the layer's finalizers —
 * exactly once, when the application shuts down.
 *
 * `DtmfRegistry` is injected into the runtime factory rather than into the executor's layer
 * directly, which is what keeps the executor free of any dependency on the orchestrator. The
 * executor awaits digits; the orchestrator pushes them; neither knows the other exists.
 */
@Module({
	imports: [AriModule],
	providers: [
		DtmfRegistry,
		{
			provide: CALLS_EFFECT_RUNTIME,
			useFactory: (media: MediaPort, dtmf: DtmfRegistry) =>
				makeVerbExecutorRuntime({
					media,
					collectDtmf: (context, verb) => dtmf.forChannel(context.channelId).collect(verb),
				}),
			inject: [MEDIA_PORT, DtmfRegistry],
		},
		ChannelOrchestrator,
	],
	exports: [ChannelOrchestrator],
})
export class CallsModule {}
