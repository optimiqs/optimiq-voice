import { Controller, Get, HttpStatus, Query, Redirect } from "@nestjs/common";
import { createUpdateMembershipStatus } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";
import { identityConfig } from "../core/identityConfig";
import { APP_URL } from "../envs";

const logger = getLogger({ service: "api", filePath: __filename });

@Controller("api/identity")
export class IdentityInviteController {
  @Get("accept-invite")
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
