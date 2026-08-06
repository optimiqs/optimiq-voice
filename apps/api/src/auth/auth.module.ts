import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Mailer, MailModule } from "../mail";
import { createMailerEmailDelivery } from "./auth-email.delivery";
import { clearAuthRuntime, publishAuthRuntime } from "./auth-platform.registry";
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
 * It adds `/api/auth/*`, the session hook, the first REST resources and the **global** session
 * guard over every Nest HTTP route. It is the only authentication path this process has: the gRPC
 * identity surface it coexisted with, and the `accessKeyId → organization.id` ledger that
 * translated between the two, are both deleted.
 *
 * The guard is registered here rather than in `main.ts` so that it exists exactly when the slice
 * does: an environment without `DATABASE_URL` / `AUTH_SECRET` / `AUTH_URL` boots `AppModule`
 * alone and behaves precisely as it did before.
 */
@Module({
	/**
	 * `MailModule` is `@Global()`, so this import is redundant for resolution and is here for a
	 * different reason: it declares that this slice does not work without a mail transport. Four of
	 * better-auth's flows are one-time links, and a reader of this file should not have to know
	 * that a global module happens to exist to find out where they go.
	 */
	imports: [MailModule],
	controllers: [MeController, OrganizationsController],
	providers: [
		{
			provide: AUTH_PLATFORM,
			useFactory: (mailer: Mailer): AuthPlatform =>
				createAuthPlatform(createMailerEmailDelivery(mailer)),
			inject: [Mailer],
		},
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
	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {
		// Published for the code paths Nest does not construct. See `auth-platform.registry.ts`
		// for why the seam exists and when it dies.
		publishAuthRuntime({ platform: this.platform });
	}

	/** The slice owns its postgres pool, so shutdown is deterministic instead of process-exit. */
	async onApplicationShutdown(): Promise<void> {
		clearAuthRuntime();
		await this.platform.close();
	}
}
