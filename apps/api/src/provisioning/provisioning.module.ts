import { Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PbxModule } from "../pbx/pbx.module";
import { ProvisioningCatalogController } from "./catalog/catalog.controller";
import { DevicesController, DeviceProfilesController } from "./devices/devices.controller";
import {
	DeviceKeysService,
	DeviceLinesService,
	DeviceProfileKeysService,
	DeviceProfilesService,
	DevicesService,
} from "./devices/devices.service";
import { loadProvisioningEnv } from "./provisioning-env";
import { PROVISIONING_ENV } from "./provisioning.tokens";
import { ProvisioningRateLimiter } from "./render/provision-rate-limit";
import { ProvisionController } from "./render/provision.controller";
import { ProvisionEventPublisher } from "./render/provision.publisher";
import { ProvisionRepository } from "./render/provision.repository";
import { ProvisionService } from "./render/provision.service";
import type { ProvisioningEnv } from "./provisioning-env";

const logger = getLogger("api.provisioning");

/**
 * Device provisioning: the MAC-addressed inventory, the vendor catalogue, and the one endpoint a
 * phone talks to.
 *
 * ## Why this is its own module when the PBX area is one module for fourteen slices
 *
 * `pbx.module.ts` explains why its fourteen slices share one module: they share one connection
 * pool, one Effect runtime and one routing publisher, so fourteen modules would be fourteen
 * `imports` lines and fourteen chances to build a second pool. Provisioning shares those three
 * things too — it `imports: [PbxModule]` and injects them rather than constructing anything — but
 * it differs in the way that decides module boundaries: **it publishes a route with no session.**
 *
 * Every route in `PbxModule` is `@RequirePermissions`-guarded, which is why `main.ts` refuses to
 * mount it without the auth slice. `/provision/:token/config` is deliberately outside that, and a
 * reviewer asking "what in this application is reachable without authentication?" should be able to
 * answer it by reading one module rather than by grepping fourteen slices for `@PublicRoute`.
 *
 * The second reason is ownership: the provisioning surface has its own environment contract
 * (`PROVISION_*`), its own failure taxonomy, its own rate limiter and its own event stream, none of
 * which the PBX area has any use for. Folding them in would put five files' worth of concepts into
 * a module whose documentation is already about something else.
 *
 * ## What it takes from `PbxModule`
 *
 * `PBX_DATABASE` (one pool, not two), `PBX_EFFECT_RUNTIME` (so the device CRUD is the same
 * declarative engine as every other resource, including the same 404/409 mapping and the same
 * tenant transaction), and `PBX_ENV` (for `NATS_URL`, so the broker URL has one owner). Nothing is
 * re-created here.
 *
 * ## Mounting
 *
 * `main.ts` mounts it alongside `PbxModule`, gated on the same two conditions, because both of
 * those are prerequisites: without `PBX_DATABASE_URL` there is nothing to read, and without the
 * auth slice the CRUD half would be fourteen unauthenticated tenant-scoped endpoints. See the note
 * in `main.ts` for why the mount is not in `app.module.ts`.
 */
@Module({
	imports: [PbxModule],
	controllers: [
		DevicesController,
		DeviceProfilesController,
		ProvisioningCatalogController,
		/**
		 * The one controller in this application with a route that requires no session.
		 *
		 * Listed last and commented here so it is impossible to add a second one without noticing.
		 */
		ProvisionController,
	],
	providers: [
		{ provide: PROVISIONING_ENV, useFactory: (): ProvisioningEnv => loadProvisioningEnv() },
		{
			/**
			 * One limiter for the whole process, not one per request.
			 *
			 * Nest providers are singletons by default, which is exactly what a counter needs — a
			 * request-scoped limiter would count to one and allow everything. Constructed through a
			 * factory so its budget comes from the parsed environment rather than from a constant.
			 */
			provide: ProvisioningRateLimiter,
			useFactory: (env: ProvisioningEnv) =>
				new ProvisioningRateLimiter(env.PROVISION_RATE_LIMIT_PER_MINUTE),
			inject: [PROVISIONING_ENV],
		},
		ProvisionRepository,
		ProvisionEventPublisher,
		ProvisionService,
		DevicesService,
		DeviceLinesService,
		DeviceKeysService,
		DeviceProfilesService,
		DeviceProfileKeysService,
	],
	exports: [DevicesService, DeviceProfilesService, ProvisionService],
})
export class ProvisioningModule {
	constructor() {
		logger.info(
			"device provisioning mounted on /api/v1/devices, /api/v1/device-profiles and /provision/*",
		);
	}
}
