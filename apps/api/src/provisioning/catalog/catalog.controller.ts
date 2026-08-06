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
	 * `devices.read` rather than being unauthenticated.
	 *
	 * The catalogue itself is not a secret — it is five vendor names — but `missing` names the
	 * environment variables an operator has not set, which is deployment reconnaissance. Behind the
	 * same permission that lets you see the devices it describes is the right place for it.
	 */
	@Get("catalog")
	@RequirePermissions("devices.read")
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
