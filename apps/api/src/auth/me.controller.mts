import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { AuthService, type SessionOverview } from "./auth.service.mjs";
import { RequirePermissions } from "./require-permissions.decorator.mjs";
import { RequirePermissionsGuard } from "./require-permissions.guard.mjs";
import { Session } from "./session.decorator.mjs";
import type { AppSession } from "@optimiq-voice/auth";

/** Who the caller is, which organization they are acting in and what that grants them. */
@Controller("api/v1/me")
@UseGuards(RequirePermissionsGuard)
export class MeController {
	constructor(@Inject(AuthService) private readonly authService: AuthService) {}

	@Get()
	@RequirePermissions()
	async getMe(@Session() session: AppSession): Promise<SessionOverview> {
		return await this.authService.getSessionOverview(session);
	}
}
