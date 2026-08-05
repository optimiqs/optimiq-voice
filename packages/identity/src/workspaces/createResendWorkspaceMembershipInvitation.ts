import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";
import {
  getAccessKeyIdFromCall,
  getTokenFromCall,
  GrpcErrorMessage,
  Validators as V
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
  ResendWorkspaceMembershipInvitationRequest,
  ResendWorkspaceMembershipInvitationResponse
} from "@optimiq-voice/types";
import { Database } from "../db";
import { IdentityConfig } from "../exchanges/types";
import { SendInvite } from "../invites";
import { createSendEmail } from "../utils";
import { createGenerateWorkspaceInviteToken } from "../utils/createGenerateWorkspaceInviteToken";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { createIsAdminMember } from "./createIsAdminMember";

const logger = getLogger({ service: "identity", filePath: __filename });

function createResendWorkspaceMembershipInvitation(
  db: Database,
  identityConfig: IdentityConfig,
  sendInvite: SendInvite
) {
  const resendWorkspaceMembershipInvitation = async (
    call: { request: ResendWorkspaceMembershipInvitationRequest },
    callback: (
      error: GrpcErrorMessage,
      response?: ResendWorkspaceMembershipInvitationResponse
    ) => void
  ) => {
    const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
    const adminRef = getUserRefFromToken(token);
    const accessKeyId = getAccessKeyIdFromCall(
      call as unknown as ServerInterceptingCall
    );

    const workspace = await db.workspace.findUnique({
      where: {
        accessKeyId
      }
    });

    const { ref: workspaceRef } = workspace;
    const { request } = call;
    const { userRef: inviteeRef } = request;

    logger.verbose("resending workspace membership invitation", {
      workspaceRef,
      inviteeRef,
      adminRef
    });

    const isAdmin = await createIsAdminMember(db)(workspace.ref, adminRef);

    if (!isAdmin) {
      return callback({
        code: GRPCStatus.PERMISSION_DENIED,
        message: "Only admins and owners can resend workspace invitations"
      });
    }

    const member = await db.workspaceMember.findFirst({
      where: {
        workspaceRef,
        userRef: inviteeRef
      },
      include: {
        user: true,
        workspace: true
      }
    });

    if (!member) {
      return callback({
        code: GRPCStatus.NOT_FOUND,
        message: `Original invitation not found for userRef: ${inviteeRef}`
      });
    }

    const inviteeToken = await createGenerateWorkspaceInviteToken(
      identityConfig
    )({
      userRef: member.user.ref,
      memberRef: member.ref,
      accessKeyId: member.user.accessKeyId,
      expiresIn: identityConfig.workspaceInviteExpiration
    });

    await sendInvite(createSendEmail(identityConfig), {
      recipient: member.user.email,
      oneTimePassword: member.user.password,
      workspaceName: member.workspace.name,
      isExistingUser: true,
      inviteUrl: `${identityConfig.workspaceInviteUrl}?token=${inviteeToken}`
    });

    callback(null, {
      userRef: inviteeRef
    });
  };

  return withErrorHandlingAndValidation(
    resendWorkspaceMembershipInvitation,
    V.resendWorkspaceMembershipInvitationRequestSchema
  );
}

export { createResendWorkspaceMembershipInvitation };
