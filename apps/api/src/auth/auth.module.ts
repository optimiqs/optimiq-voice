import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { type AuthPlatform, createAuthPlatform } from "./auth.platform";
import { AuthService } from "./auth.service";
import { AUTH_PLATFORM, AUTH_REPOSITORY } from "./auth.tokens";
import { CallTokenService } from "./call-token.service";
import { MeController } from "./me.controller";
import { OrganizationsController } from "./organizations.controller";
import { RequirePermissionsGuard } from "./require-permissions.guard";

/**
 * The better-auth feature slice.
 *
 * It adds `/api/auth/*`, the session hook, the first REST resources and — since identity-removal
 * Step 3 — the **global** session guard over every Nest HTTP route. The gRPC identity path is
 * still untouched: `RuntimeHostService` starts those servers outside Nest and they keep
 * authenticating through `createAuthInterceptor` until Step 2 lands the tenant mapping.
 *
 * The guard is registered here rather than in `main.ts` so that it exists exactly when the slice
 * does: an environment without `DATABASE_URL` / `AUTH_SECRET` / `AUTH_URL` boots `AppModule`
 * alone and behaves precisely as it did before.
 */
@Module({
	controllers: [MeController, OrganizationsController],
	providers: [
		{ provide: AUTH_PLATFORM, useFactory: (): AuthPlatform => createAuthPlatform() },
		{
			provide: AUTH_REPOSITORY,
			useFactory: (platform: AuthPlatform) => platform.repository,
			inject: [AUTH_PLATFORM],
		},
		AuthService,
		CallTokenService,
		RequirePermissionsGuard,
		{ provide: APP_GUARD, useExisting: RequirePermissionsGuard },
	],
	exports: [AUTH_PLATFORM, AUTH_REPOSITORY, AuthService, CallTokenService, RequirePermissionsGuard],
})
export class AuthModule implements OnApplicationShutdown {
	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {}

	/** The slice owns its postgres pool, so shutdown is deterministic instead of process-exit. */
	async onApplicationShutdown(): Promise<void> {
		await this.platform.close();
	}
}
