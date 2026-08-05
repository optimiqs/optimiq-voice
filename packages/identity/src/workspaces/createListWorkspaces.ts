import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
  datesMapper,
  decodeToken,
  getTokenFromCall,
  GrpcErrorMessage,
  TokenUseEnum,
  Validators as V
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
  ListWorkspacesResponse,
  WorkspaceMemberStatus
} from "@optimiq-voice/types";
import { Database } from "../db";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createListWorkspaces(db: Database) {
  const listWorkspaces = async (
    call: { request: unknown },
    callback: (
      error?: GrpcErrorMessage,
      response?: ListWorkspacesResponse
    ) => void
  ) => {
    const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
    const userRef = getUserRefFromToken(token);
    const access = decodeToken<TokenUseEnum.ACCESS>(token);
    const workspacesAccessKeyIds = access.access?.map((a) => a.accessKeyId);

    logger.verbose("list workspaces for user or apikey", {
      userRef,
      workspacesAccessKeyIds
    });

    const items = await db.workspace.findMany({
      where: {
        OR: [
          {
            accessKeyId: {
              in: workspacesAccessKeyIds
            }
          },
          {
            members: {
              some: {
                userRef,
                status: WorkspaceMemberStatus.ACTIVE
              }
            }
          },
          {
            ownerRef: userRef
          }
        ]
      },
      include: {
        owner: {
          select: {
            ref: true,
            name: true,
            email: true
          }
        }
      }
    });

    callback(null, {
      items: items.map(datesMapper),
      nextPageToken: ""
    });
  };

  return withErrorHandlingAndValidation(listWorkspaces, V.listRequestSchema);
}

export { createListWorkspaces };
