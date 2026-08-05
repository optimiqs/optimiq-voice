import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";
import { customAlphabet } from "nanoid";
import {
  getAccessKeyIdFromCall,
  getTokenFromCall,
  GrpcErrorMessage,
  Validators as V
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
  InviteUserToWorkspaceRequest,
  InviteUserToWorkspaceResponse,
  WorkspaceMemberStatus
} from "@optimiq-voice/types";
import { Database } from "../db";
import { IdentityConfig } from "../exchanges/types";
import { SendInvite } from "../invites";
import {
  AccessKeyIdType,
  createSendEmail,
  generateAccessKeyId
} from "../utils";
import { createGenerateWorkspaceInviteToken } from "../utils/createGenerateWorkspaceInviteToken";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { createIsAdminMember } from "./createIsAdminMember";
import { createIsWorkspaceMember } from "./createIsWorkspaceMember";

const logger = getLogger({ service: "identity", filePath: __filename });

const userIsMemberError = {
  code: GRPCStatus.ALREADY_EXISTS,
  message: "User is already a member of this workspace"
};

const inviterIsNotAdminError = {
  code: GRPCStatus.PERMISSION_DENIED,
  message: "Only admins or owners can invite users to a workspace"
};

const findUserByEmail = async (db: Database, email: string) => {
  return await db.user.findUnique({
    where: {
      email
    }
  });
};

const createCreateUser = (db: Database) => {
  return async function createUser(request: InviteUserToWorkspaceRequest) {
    const { name, email, password } = request;

    return await db.user.create({
      data: {
        name,
        email,
        accessKeyId: generateAccessKeyId(AccessKeyIdType.USER),
        password
      }
    });
  };
};

function createInviteUserToWorkspace(
  db: Database,
  identityConfig: IdentityConfig,
  sendInvite: SendInvite
) {
  const inviteUserToWorkspace = async (
    call: { request: InviteUserToWorkspaceRequest },
    callback: (
      error: GrpcErrorMessage,
      response?: InviteUserToWorkspaceResponse
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
    const { email, name, role } = request;

    logger.verbose("inviting user to workspace", {
      workspaceRef,
      email,
      role
    });

    const isAdmin = await createIsAdminMember(db)(workspaceRef, adminRef);

    if (!isAdmin) {
      return callback(inviterIsNotAdminError);
    }

    let user = await findUserByEmail(db, email);

    const isMember = await createIsWorkspaceMember(db)(workspaceRef, user?.ref);

    if (isMember) {
      return callback(userIsMemberError);
    }

    const oneTimePassword = customAlphabet("1234567890abcdef", 10)();

    let isExistingUser = true;

    if (!user) {
      isExistingUser = false;

      user = await createCreateUser(db)({
        name,
        email,
        password: oneTimePassword,
        role
      });
    }

    const newMember = await db.workspaceMember.create({
      data: {
        userRef: user.ref,
        workspaceRef,
        role,
        status: WorkspaceMemberStatus.PENDING
      },
      include: {
        workspace: true
      }
    });

    const inviteeToken = await createGenerateWorkspaceInviteToken(
      identityConfig
    )({
      userRef: user.ref,
      memberRef: newMember.ref,
      accessKeyId: user.accessKeyId,
      expiresIn: identityConfig.workspaceInviteExpiration
    });

    await sendInvite(createSendEmail(identityConfig), {
      recipient: email,
      oneTimePassword,
      workspaceName: newMember.workspace.name,
      isExistingUser,
      inviteUrl: `${identityConfig.workspaceInviteUrl}?token=${inviteeToken}`
    });

    callback(null, {
      userRef: user?.ref,
      workspaceRef
    });
  };

  return withErrorHandlingAndValidation(
    inviteUserToWorkspace,
    V.inviteUserToWorkspaceRequestSchema
  );
}

export { createInviteUserToWorkspace };
