import "reflect-metadata";
import { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { getLogger } from "@optimiq-voice/logger";
import { AppModule } from "./app.module";
import { AuthBootstrapModule, loadAuthBootstrap } from "./auth/auth-esm.bridge";
import { HTTP_BRIDGE_PORT } from "./envs";

const logger = getLogger({ service: "api", filePath: __filename });

/**
 * The better-auth slice is additive and optional: an environment without `DATABASE_URL` /
 * `AUTH_SECRET` / `AUTH_URL` still boots the gRPC identity path exactly as before.
 */
async function loadAuthSlice(): Promise<AuthBootstrapModule | undefined> {
	try {
		const bootstrap = await loadAuthBootstrap();
		if (!bootstrap.isAuthSliceEnabled()) {
			logger.info("better-auth slice disabled (DATABASE_URL, AUTH_SECRET or AUTH_URL not set)");
			return undefined;
		}
		return bootstrap;
	} catch (error) {
		logger.error("failed to load the better-auth slice; continuing without it", error);
		return undefined;
	}
}

async function bootstrap() {
	const authSlice = await loadAuthSlice();
	const rootModule: Type<unknown> = authSlice
		? authSlice.createApiRootModule([AppModule])
		: AppModule;

	const app = await NestFactory.create<NestFastifyApplication>(rootModule, new FastifyAdapter());
	app.enableShutdownHooks();

	// Raw Fastify wiring has to exist before `listen`, which is when Nest installs its own router
	// and not-found handler.
	if (authSlice) {
		await authSlice.registerAuthTransport(app);
		logger.info("better-auth mounted on /api/auth/*");
	}

	await app.listen(HTTP_BRIDGE_PORT, "0.0.0.0");
	logger.info(`HTTP API is running on port ${HTTP_BRIDGE_PORT}`);
}

bootstrap().catch((error) => {
	logger.error("failed to start API", error);
	process.exitCode = 1;
});
