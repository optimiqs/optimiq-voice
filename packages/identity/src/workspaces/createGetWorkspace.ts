import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";
import {
  datesMapper,
  getTokenFromCall,
  GrpcErrorMessage,
  Validators as V
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, Workspace } from "@optimiq-voice/types";
import { Database } from "../db";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createGetWorkspace(db: Database) {
  const getWorkspace = async (
    call: { request: BaseApiObject },
    callback: (error: GrpcErrorMessage, response?: Workspace) => void
  ) => {
    const { request } = call;
    const { ref } = request;

    const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
    const ownerRef = getUserRefFromToken(token);

    logger.verbose("getting workspace by id", { ref, ownerRef });

    const workspace = await db.workspace.findUnique({
      where: {
        ref,
        ownerRef
      }
    });

    if (!workspace) {
      callback({
        code: GRPCStatus.NOT_FOUND,
        message: "Workspace not found"
      });
      return;
    }

    const response = datesMapper(workspace);

    callback(null, response);
  };

  return withErrorHandlingAndValidation(getWorkspace, V.emptySchema);
}

export { createGetWorkspace };
