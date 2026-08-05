import { Controller, Get, HttpStatus, Query, Redirect } from "@nestjs/common";
import { createUpdateMembershipStatus } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";
import { PublicRoute } from "../auth/public-route.decorator";
import { identityConfig } from "../core/identityConfig";
import { APP_URL } from "../envs";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

@Controller("api/identity")
export class IdentityInviteController {
	/**
	 * Anonymous by definition: it is the link in an invitation email, clicked by someone who has
	 * no session yet. The `token` query parameter is the credential. Dies with the identity
	 * service in Step 9, replaced by better-auth's `/api/auth/organization/accept-invitation`.
	 */
	@Get("accept-invite")
	@PublicRoute()
	@Redirect(undefined, HttpStatus.FOUND)
	async acceptInvite(@Query("token") token: string) {
		try {
			await createUpdateMembershipStatus(identityConfig)(token);
			return { url: APP_URL };
		} catch (error) {
			logger.verbose("error updating membership status", error);
			return { url: identityConfig.workspaceInviteFailUrl };
		}
	}
}
