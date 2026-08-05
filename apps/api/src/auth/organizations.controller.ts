import { Controller, Get, Inject, Param, ParseUUIDPipe } from "@nestjs/common";
import { AuthService, type OrganizationView } from "./auth.service";
import { RequirePermissions } from "./require-permissions.decorator";
import { Session } from "./session.decorator";
import type { OrganizationMemberSummary } from "./auth.repository";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Organizations the caller belongs to.
 *
 * Organizations are created and mutated through better-auth's own organization endpoints under
 * `/api/auth/organization/*`; this controller only reads.
 */
@Controller("api/v1/organizations")
export class OrganizationsController {
	constructor(@Inject(AuthService) private readonly authService: AuthService) {}

	@Get()
	@RequirePermissions()
	async listMine(@Session() session: AppSession): Promise<{ data: readonly OrganizationView[] }> {
		return { data: await this.authService.listMyOrganizations(session) };
	}

	@Get(":organizationId/members")
	@RequirePermissions("members.read")
	async listMembers(
		@Param("organizationId", ParseUUIDPipe) organizationId: string,
		@Session() session: AppSession,
	): Promise<{ data: readonly OrganizationMemberSummary[] }> {
		return {
			data: await this.authService.listMembers(organizationId, session, "members.read"),
		};
	}
}
