import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppLogger, getLogger } from "@optimiq-voice/logging";
import { AppModule } from "./app.module";
import { ChannelOrchestrator } from "./calls/channel-orchestrator.service";
import { loadEngineEnv } from "./config/engine-env";
import { AriConnectionService } from "./media/ari-connection.service";
import { MediadService } from "./media/mediad.service";
import { SipdService } from "./media/sipd.service";
import { StartupMediaEventBuffer } from "./media/startup-media-event-buffer";

/**
 * The engine's bootstrap.
 *
 * The ORDER here is the contract, and it is written out rather than left to Nest's module
 * lifecycle because two of the steps are things Nest cannot know:
 *
 * 1. **Environment first.** A missing `ARI_PASSWORD` under the ARI driver must stop the process
 *    before anything opens a socket, not surface as a `401` on the first inbound call. The mediad
 *    driver has no ARI dependency and therefore requires no Asterisk credential.
 * 2. **Nest without a listener.** Providers initialise first, but no HTTP port opens while the
 *    media source or recovered channel state is incomplete. A pod cannot report ready halfway
 *    through replay.
 * 3. **Handler, source, recovery, replay.** The selected event source starts into a bounded buffer
 *    before channel KV is hydrated. Events received during recovery are then replayed serially in
 *    arrival order, so no terminal event can slip between the snapshot read and local admission.
 * 4. **Explicit signal handling with a deadline.** Per the oikos bootstrap convention (§7): drain
 *    the calls, then close, then exit — and exit anyway if the drain overruns, because a pod that
 *    refuses to die is worse than one that drops the last few calls.
 */
async function bootstrap(): Promise<void> {
	const logger = getLogger("engine.bootstrap");
	// A unique, stable identity for this process's park and conference claims, filled in BEFORE the
	// env is parsed so the loaded object is the whole truth. The container's hostname is unique per
	// replica under every orchestrator worth the name, and an instance id shared by two processes
	// would mean each of them believing it owns the other's orbits.
	if ((process.env.ENGINE_INSTANCE_ID ?? "") === "" && (process.env.HOSTNAME ?? "") !== "") {
		process.env.ENGINE_INSTANCE_ID = process.env.HOSTNAME;
	}
	const env = loadEngineEnv();

	const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
		logger: new AppLogger(),
		// Nest's own signal hooks are NOT enabled: the drain below has to run before module
		// shutdown, and `enableShutdownHooks` would tear the modules down underneath it.
		abortOnError: false,
	});

	const ari = app.get(AriConnectionService);
	const mediad = app.get(MediadService);
	const orchestrator = app.get(ChannelOrchestrator);

	const sipd = app.get(SipdService);

	const source = env.ENGINE_MEDIA_DRIVER === "ari" ? ari : mediad;
	const startupEvents = new StartupMediaEventBuffer(
		async (event) => await orchestrator.handleEvent(event),
	);
	source.setEventHandler((event) => {
		startupEvents.push(event);
	});
	// The signalling plane is a SECOND source into the same buffer, not an alternative to the first.
	// Under the split plane a leg's facts arrive from two processes — `mediad` reports what happened
	// to the audio and `sipd` reports what happened to the dialog — and both map into one union, so
	// both go through the same recovery buffer and the same handler. A `dialog.terminated` that
	// arrived during hydration must be replayed in arrival order beside a `session.ended`, or a leg
	// admitted moments earlier is held forever. `SipdService.start()` is a no-op on a deployment that
	// does not signal on `apps/sipd`.
	sipd.setEventHandler((event) => {
		startupEvents.push(event);
	});

	await source.start();
	await sipd.start();
	await orchestrator.hydrateChannels();
	await startupEvents.replay();

	await app.listen({ port: env.ENGINE_PORT, host: env.ENGINE_HOST });
	logger.info({ port: env.ENGINE_PORT, host: env.ENGINE_HOST }, "engine HTTP listener up");
	logger.info({ driver: env.ENGINE_MEDIA_DRIVER }, "engine ready");

	installShutdownHandlers({ app, orchestrator, env, logger });
}

function installShutdownHandlers(input: {
	readonly app: NestFastifyApplication;
	readonly orchestrator: ChannelOrchestrator;
	readonly env: ReturnType<typeof loadEngineEnv>;
	readonly logger: ReturnType<typeof getLogger>;
}): void {
	let shuttingDown = false;

	const shutdown = (signal: string): void => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		input.logger.info({ signal }, "shutdown requested; draining calls");

		// The deadline is a hard backstop around the whole sequence, drain included: if anything
		// in it hangs, the process still exits.
		const deadline = setTimeout(() => {
			input.logger.error({ signal }, "shutdown deadline exceeded; exiting");
			process.exit(1);
		}, input.env.ENGINE_DRAIN_TIMEOUT_MS + 10_000);
		deadline.unref();

		void (async () => {
			try {
				await input.orchestrator.drain();
				await input.app.close();
				input.logger.info({ signal }, "shutdown complete");
				process.exit(0);
			} catch (error) {
				input.logger.error({ signal, err: String(error) }, "shutdown failed");
				process.exit(1);
			}
		})();
	};

	process.once("SIGTERM", () => {
		shutdown("SIGTERM");
	});
	process.once("SIGINT", () => {
		shutdown("SIGINT");
	});
}

await bootstrap();
