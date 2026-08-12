import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { isRenderConfigured, missingRenderConfiguration } from "../provisioning-env";
import { PROVISIONING_ENV } from "../provisioning.tokens";
import { catalogEntries } from "./catalog";
import type { ProvisioningEnv } from "../provisioning-env";
import type { CatalogVendorEntry } from "./catalog";

/**
 * `GET /api/v1/provisioning/catalog` — which vendors this deployment can provision, and whether it
 * can provision anything at all.
 *
 * ## Why the client asks instead of knowing
 *
 * `apps/web` mirrors most contracts rather than importing them, and could mirror the vendor list
 * too. It does not, for the reason the feature-code parameter fields are also served: this
 * describes the **deployment**, not the schema. A client that hard-coded five vendors would offer a
 * picker whose entries the API it is talking to might not have a template for, and — more
 * importantly — could not tell an administrator that `PROVISION_SIP_SERVER` is unset, which is the
 * single most useful thing this endpoint says.
 *
 * `caveats` travels with each entry on purpose. None of these templates has been rendered into a
 * physical handset in this repository, and somebody about to buy forty phones should be able to read
 * that from the form rather than from a commit message.
 */
@Controller("api/v1/provisioning")
export class ProvisioningCatalogController {
	constructor(@Inject(PROVISIONING_ENV) private readonly env: ProvisioningEnv) {}

	/**
	 * `provisioning.read` rather than `devices.read`, and never unauthenticated.
	 *
	 * The catalogue is not a secret — it is five vendor names — but `missing` names the environment
	 * variables an operator has not set, which is deployment reconnaissance. So it is behind a
	 * permission; the only question was which.
	 *
	 * It used to be `devices.read`, on the reasoning that this describes the devices that grant lets
	 * you see. That reads well and is one resource off: the permission registry declares a
	 * `provisioning` resource whose read entry is described as "inspect vendor catalogues and
	 * rendered device configuration", which is this endpoint stated in advance and which was
	 * enforcing nothing anywhere. A permission whose description names a route, guarding no route,
	 * while that route is guarded by a neighbouring grant, is the exact shape the W7 permission
	 * audit was looking for.
	 *
	 * `manager` gained `provisioning.read` in the same change, so no role lost the device form's
	 * vendor list by this narrowing — what it loses is the ability to read the deployment's
	 * configuration gaps from a role that has no reason to.
	 */
	@Get("catalog")
	@RequirePermissions("provisioning.read")
	catalog(): { readonly data: ProvisioningCatalog } {
		return {
			data: {
				vendors: catalogEntries(),
				configured: isRenderConfigured(this.env),
				missing: missingRenderConfiguration(this.env),
				baseUrl: this.env.PROVISION_BASE_URL ?? null,
				sipServer: this.env.PROVISION_SIP_SERVER ?? null,
				sipPort: this.env.PROVISION_SIP_PORT,
				sipTransport: this.env.PROVISION_SIP_TRANSPORT,
				rateLimitPerMinute: this.env.PROVISION_RATE_LIMIT_PER_MINUTE,
				requireIpAllowlist: this.env.PROVISION_REQUIRE_IP_ALLOWLIST,
			},
		};
	}
}

export interface ProvisioningCatalog {
	readonly vendors: readonly CatalogVendorEntry[];
	/** Whether the render endpoint would answer a phone today. */
	readonly configured: boolean;
	/** The environment variables still missing. Empty when `configured`. */
	readonly missing: readonly string[];
	/** The public base a provisioning URL is built from, or `null` when unset. */
	readonly baseUrl: string | null;
	readonly sipServer: string | null;
	readonly sipPort: number;
	readonly sipTransport: string;
	readonly rateLimitPerMinute: number;
	readonly requireIpAllowlist: boolean;
}
