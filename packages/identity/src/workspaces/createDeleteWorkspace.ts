import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
  getTokenFromCall,
  GrpcErrorMessage,
  Validators as V
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../db";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createDeleteWorkspace(db: Database) {
  const deleteWorkspace = async (
    call: { request: BaseApiObject },
    callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void
  ) => {
    const { request } = call;
    const { ref } = request;

    const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
    const ownerRef = getUserRefFromToken(token);

    logger.verbose("deleting workspace from the system", { ref, ownerRef });

    await db.workspace.delete({
      where: {
        ref,
        ownerRef
      }
    });

    callback(null, { ref });
  };

  return withErrorHandlingAndValidation(deleteWorkspace, V.emptySchema);
}

export { createDeleteWorkspace };
