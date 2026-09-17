import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { Mailer, MailModule } from "../mail";
import { createMailerEmailDelivery } from "./auth-email.delivery";
import { clearAuthRuntime, publishAuthRuntime } from "./auth-platform.registry";
import { type AuthPlatform, createAuthPlatform } from "./auth.platform";
import { AuthService } from "./auth.service";
import { AUTH_PLATFORM, AUTH_REPOSITORY } from "./auth.tokens";
import { BrandingController } from "./branding/branding.controller";
import { BrandingService } from "./branding/branding.service";
import { CallTokenService } from "./call-token.service";
import { MailTemplateController } from "./mail-templates/mail-template.controller";
import { MailTemplateService } from "./mail-templates/mail-template.service";
import { MeController } from "./me.controller";
import { OrganizationSuspensionService } from "./organization-suspension.service";
import { OrganizationsController } from "./organizations.controller";
import { RequirePermissionsGuard } from "./require-permissions.guard";
import { ResellerController } from "./reseller/reseller.controller";
import { ResellerService } from "./reseller/reseller.service";
import { SessionErrorsFilter } from "./session-errors.filter";
import { SsoController } from "./sso/sso.controller";
import { SsoService } from "./sso/sso.service";

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
	controllers: [
		MeController,
		OrganizationsController,
		ResellerController,
		BrandingController,
		SsoController,
		MailTemplateController,
	],
	providers: [
		ResellerService,
		BrandingService,
		SsoService,
		MailTemplateService,
		{
			provide: AUTH_PLATFORM,
			// Async: the platform now reads the enabled SSO providers at boot so `genericOAuth` can be
			// registered with them. Nest awaits an async `useFactory`, so `AUTH_PLATFORM` resolves to the
			// composed runtime exactly as before — only the construction is asynchronous now.
			useFactory: async (mailer: Mailer): Promise<AuthPlatform> =>
				await createAuthPlatform(createMailerEmailDelivery(mailer)),
			inject: [Mailer],
		},
		{
			provide: AUTH_REPOSITORY,
			useFactory: (platform: AuthPlatform) => platform.repository,
			inject: [AUTH_PLATFORM],
		},
		AuthService,
		CallTokenService,
		OrganizationSuspensionService,
		RequirePermissionsGuard,
		{ provide: APP_GUARD, useExisting: RequirePermissionsGuard },
		{ provide: APP_FILTER, useClass: SessionErrorsFilter },
	],
	exports: [
		AUTH_PLATFORM,
		AUTH_REPOSITORY,
		AuthService,
		CallTokenService,
		RequirePermissionsGuard,
		// Exported so the PBX mail consumers (voicemail-to-email, and the fax/emergency senders when
		// they are wired the same way) can resolve the per-org mail-template cascade + branding product
		// name. `PbxModule` imports `AuthModule`, so this is the seam that lets a consumer in that
		// module reach `resolveComposition` without a second copy of the branding read.
		MailTemplateService,
		// Exported for the same reason: the logo-byte route lives in `PbxModule` (that is where the
		// media object store is) and resolves the effective branding — and therefore the logo's object
		// key — through this service.
		BrandingService,
	],
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
