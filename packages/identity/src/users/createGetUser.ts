import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";
import {
  datesMapper,
  getTokenFromCall,
  GrpcErrorMessage,
  Validators as V
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, User } from "@optimiq-voice/types";
import { Database } from "../db";
import { getAccessKeyIdFromToken } from "../utils";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createGetUser(db: Database) {
  const getUser = async (
    call: { request: BaseApiObject },
    callback: (error: GrpcErrorMessage, response?: User) => void
  ) => {
    const { request } = call;
    const { ref } = request;

    const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
    const accessKeyId = getAccessKeyIdFromToken(token);

    logger.verbose("getting user with ref and accessKeyId", {
      ref,
      accessKeyId
    });

    const user = await db.user.findUnique({
      where: {
        ref,
        accessKeyId
      }
    });

    if (!user) {
      callback({
        code: GRPCStatus.NOT_FOUND,
        message: `User not found: ${ref}`
      });
      return;
    }

    callback(null, datesMapper(user));
  };

  return withErrorHandlingAndValidation(getUser, V.emptySchema);
}

export { createGetUser };
