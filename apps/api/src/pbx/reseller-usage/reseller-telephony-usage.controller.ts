import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import {
	ResellerTelephonyUsageService,
	type ResellerTelephonyUsageView,
} from "./reseller-telephony-usage.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `GET /api/v1/reseller/telephony-usage` — extensions, trunks and DIDs summed across a reseller's
 * children.
 *
 * Under the same `/api/v1/reseller` prefix as the auth-slice reseller controller, and gated the same
 * way (`reseller.read` here, the `is_reseller` capability in the service). It is a separate
 * controller because it reads the PBX database, which the auth slice cannot reach without a module
 * cycle — see `reseller-telephony-usage.service.ts`.
 */
@Controller("api/v1/reseller")
export class ResellerTelephonyUsageController {
	constructor(
		@Inject(ResellerTelephonyUsageService)
		private readonly usage: ResellerTelephonyUsageService,
	) {}

	@Get("telephony-usage")
	@RequirePermissions("reseller.read")
	async telephonyUsage(
		@Session() session: AppSession,
	): Promise<{ data: ResellerTelephonyUsageView }> {
		return { data: await this.usage.usage(session) };
	}
}
