import { type INestApplication, Module, type Type } from "@nestjs/common";
import { registerAuthHttp } from "./auth-http.plugin.mjs";
import { isAuthSliceConfigured } from "./auth.config.mjs";
import { AuthModule } from "./auth.module.mjs";
import { AUTH_PLATFORM } from "./auth.tokens.mjs";
import type { AuthHttpServer } from "./auth-http.plugin.mjs";
import type { AuthPlatform } from "./auth.platform.mjs";

/**
 * The ES-module entry point of the auth slice.
 *
 * `apps/api` still compiles to CommonJS, so `src/main.ts` reaches this file through
 * `src/auth/auth-esm.bridge.ts` (one dynamic import) instead of a static one. Everything above
 * this line is ordinary Nest wiring; the boundary exists only until apps/api adopts the oikos
 * tsconfig. See `src/auth/tsconfig.json`.
 */

export { isAuthSliceConfigured as isAuthSliceEnabled };

/**
 * Builds the root module: the existing `AppModule` plus the auth slice.
 *
 * `AppModule` cannot list `AuthModule` in its `imports` because one is CommonJS and the other is
 * an ES module, so composition happens here, where both are already loaded.
 */
export function createApiRootModule(baseModules: readonly Type<unknown>[]): Type<unknown> {
	class ApiRootModule {}
	Module({ imports: [...baseModules, AuthModule] })(ApiRootModule);
	return ApiRootModule;
}

/**
 * Mounts `/api/auth/*` and the session `preHandler` hook on the Fastify instance.
 *
 * Must run after `NestFactory.create` (the container has to be able to build `AUTH_PLATFORM`)
 * and before `listen` (Nest installs its router and 404 handler during init).
 */
export async function registerAuthTransport(app: INestApplication): Promise<void> {
	const platform = app.get<AuthPlatform>(AUTH_PLATFORM);
	// `HttpServer.getInstance()` is untyped by design (`ServerInstance = any`); the structural
	// `AuthHttpServer` is the only part of Fastify this slice touches.
	const server: AuthHttpServer = app.getHttpAdapter().getInstance();
	registerAuthHttp(server, platform);
	await Promise.resolve();
}
