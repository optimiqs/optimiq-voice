import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppLogger, getLogger } from "@optimiq-voice/logging";
import { AppModule } from "./app.module";
import { ChannelOrchestrator } from "./calls/channel-orchestrator.service";
import { loadEngineEnv } from "./config/engine-env";
import { AriConnectionService } from "./media/ari-connection.service";
import { MediadService } from "./media/mediad.service";

/**
 * The engine's bootstrap.
 *
 * The ORDER here is the contract, and it is written out rather than left to Nest's module
 * lifecycle because two of the steps are things Nest cannot know:
 *
 * 1. **Environment first.** A missing `ARI_PASSWORD` must stop the process before anything opens a
 *    socket, not surface as a `401` on the first inbound call.
 * 2. **Nest, then the HTTP listener.** `/healthz` must be answerable before the ARI socket opens,
 *    so an orchestrator that fails to connect is visible as `degraded` rather than as a process
 *    that never finished starting.
 * 3. **Handler, THEN socket.** The orchestrator is wired into the ARI connection before the socket
 *    is opened. A `StasisStart` that arrives with no handler registered is a call that rings until
 *    the carrier gives up.
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

	await app.listen({ port: env.ENGINE_PORT, host: env.ENGINE_HOST });
	logger.info({ port: env.ENGINE_PORT, host: env.ENGINE_HOST }, "engine HTTP listener up");

	const ari = app.get(AriConnectionService);
	const mediad = app.get(MediadService);
	const orchestrator = app.get(ChannelOrchestrator);

	ari.setEventHandler((event) => {
		// Fire-and-forget on purpose: awaiting here would serialise every channel's work behind
		// every other channel's. `handleEvent` never rejects (it catches and logs), so the
		// `void` is safe rather than a swallowed failure.
		void orchestrator.handleEvent(event);
	});
	mediad.setEventHandler((event) => {
		void orchestrator.handleEvent(event);
	});

	await ari.start();
	// A no-op unless ENGINE_MEDIA_DRIVER=mediad. Without this call the driver's commands go out
	// and no events ever come back — no teardown, no CDR — which is why it sits beside ari.start()
	// rather than being left to a module hook: the handler-then-socket order is the same contract.
	await mediad.start();
	logger.info({ app: env.ARI_APP }, "engine ready");

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
