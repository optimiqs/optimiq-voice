import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { type AuthPlatform, createAuthPlatform } from "./auth.platform.mjs";
import { AuthService } from "./auth.service.mjs";
import { AUTH_PLATFORM, AUTH_REPOSITORY } from "./auth.tokens.mjs";
import { MeController } from "./me.controller.mjs";
import { OrganizationsController } from "./organizations.controller.mjs";
import { RequirePermissionsGuard } from "./require-permissions.guard.mjs";

/**
 * The better-auth feature slice.
 *
 * Purely additive: it adds `/api/auth/*`, the session hook and the first REST resources without
 * touching the gRPC identity path, which keeps working unchanged until identity-removal Step 3.
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
		RequirePermissionsGuard,
	],
	exports: [AUTH_PLATFORM, AUTH_REPOSITORY, AuthService, RequirePermissionsGuard],
})
export class AuthModule implements OnApplicationShutdown {
	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {}

	/** The slice owns its postgres pool, so shutdown is deterministic instead of process-exit. */
	async onApplicationShutdown(): Promise<void> {
		await this.platform.close();
	}
}
