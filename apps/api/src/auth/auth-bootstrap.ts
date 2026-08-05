import { type INestApplication, Module, type Type } from "@nestjs/common";
import { registerAuthHttp } from "./auth-http.plugin";
import { isAuthSliceConfigured } from "./auth.config";
import { AuthModule } from "./auth.module";
import { AUTH_PLATFORM } from "./auth.tokens";
import type { AuthHttpServer } from "./auth-http.plugin";
import type { AuthPlatform } from "./auth.platform";

/**
 * The entry point of the auth slice — what `src/main.ts` imports.
 *
 * Historically this was reached through a CommonJS → ES-module bridge, because `apps/api`
 * compiled to CommonJS while the slice had to compile with `moduleResolution: bundler` to see
 * `@optimiq-voice/{auth,db,config}`. `apps/api` is now an ES-module package on the oikos
 * tsconfig, so the bridge, the slice's own `tsconfig.json` and the `.mts` split are all gone and
 * this is an ordinary module.
 */

export { isAuthSliceConfigured as isAuthSliceEnabled };

/**
 * Builds the root module: the existing `AppModule` plus the auth slice.
 *
 * Composition happens here rather than in `AppModule`'s `imports` so that the slice can be
 * omitted entirely when it is not configured, and so `verify-auth-slice.ts` can mount it alone.
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
