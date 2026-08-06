import { Module } from "@nestjs/common";

/**
 * The root module of the API process, and now deliberately empty.
 *
 * Everything this module used to own has been removed with the legacy platform:
 *
 * - `RuntimeHostService` started the gRPC server on `API_BIND_ADDR` (`0.0.0.0:50051`) and, through
 *   `app-runtime.ts`, seeded a default user and a Routr peer before binding the identity, sipnet,
 *   applications, secrets, calls and welcome-demo service builders. That whole surface is gone;
 *   the API speaks HTTP only, and `apps/engine` owns call control.
 * - `IdentityInviteController` served `GET /api/identity/accept-invite`, the landing page for the
 *   legacy identity service's workspace-invitation emails. Links in invitation emails that were
 *   already sent by that service are now dead links. The live path is better-auth's organization
 *   plugin: an invitation is accepted through `POST /api/auth/organization/accept-invitation`,
 *   which `apps/web` drives — see `src/auth/auth-email.delivery.ts` for the mail it sends.
 * - `GET /api/recordings/:id` was removed earlier: it was an anonymous read of any file under the
 *   recording root whose name a caller could guess. `src/cdr/recordings` replaced it with a signed,
 *   expiring URL (`POST /api/v1/recordings/:id/download-url` →
 *   `GET /api/v1/recordings/media?token=…`), where the recording id lives inside the signed blob
 *   and the read still runs through the tenant's RLS policy.
 *
 * The module itself stays because it is still the composition root: `main.ts` boots it directly on
 * a deployment with no auth slice, and wraps it with `createApiRootModule([AppModule], …)`
 * otherwise. The functional areas (`AuthModule`, `PbxModule`, `ProvisioningModule`, `LiveModule`,
 * `CdrModule`) are composed there, conditionally, because each one is gated on its own database
 * URL being configured.
 */
@Module({})
export class AppModule {}
