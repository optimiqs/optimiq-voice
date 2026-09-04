import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import {
	SoftphoneCredentialsService,
	type SoftphoneCredentialsResponse,
} from "./softphone.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `GET /api/v1/me/softphone` — the caller's own browser softphone credentials.
 *
 * `@RequirePermissions()` (authenticated, no grant) and NOT a `devices.*` permission: this is
 * self-service, and its whole reason for existing is that a user who holds an extension but not
 * `devices.write` can still bring a softphone online. The endpoint resolves the caller's OWN
 * extension from the session — no id is accepted from the client — so the authorization IS the
 * ownership. See `softphone.service.ts`.
 */
@Controller("api/v1/me/softphone")
export class SoftphoneController {
	constructor(
		@Inject(SoftphoneCredentialsService) private readonly softphone: SoftphoneCredentialsService,
	) {}

	@Get()
	@RequirePermissions()
	async get(@Session() session: AppSession): Promise<SoftphoneCredentialsResponse> {
		return await this.softphone.forSelf(session);
	}
}
