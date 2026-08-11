import { Module } from "@nestjs/common";
import { AriModule } from "../media/ari.module";
import { CALLS_EFFECT_RUNTIME, MEDIA_PORT } from "../nats/nats.tokens";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { makeVerbExecutorRuntime } from "../verbs/verb-executor";
import { CallControlRegistry } from "./call-control-registry";
import { ChannelOrchestrator } from "./channel-orchestrator.service";
import type { MediaPort } from "../media/media-port";

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
 *
 * `CallControlRegistry` is there for the same reason one layer up, and it is the harder case: the
 * executor has to be able to hold, park and transfer a call, all of which need the orchestrator —
 * which is built FROM this runtime. The registry is constructed first, injected into the factory,
 * and filled in by the orchestrator's own constructor; the executor reads it lazily on each
 * dispatch. Nest never sees a cycle, and neither class imports the other.
 */
@Module({
	imports: [AriModule],
	providers: [
		DtmfRegistry,
		CallControlRegistry,
		{
			provide: CALLS_EFFECT_RUNTIME,
			useFactory: (media: MediaPort, dtmf: DtmfRegistry, callControl: CallControlRegistry) =>
				makeVerbExecutorRuntime({
					media,
					collectDtmf: (context, verb) => dtmf.forChannel(context.channelId).collect(verb),
					callControl,
				}),
			inject: [MEDIA_PORT, DtmfRegistry, CallControlRegistry],
		},
		ChannelOrchestrator,
	],
	exports: [ChannelOrchestrator, CallControlRegistry],
})
export class CallsModule {}
