import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
  getAccessKeyIdFromCall,
  GrpcErrorMessage,
  Validators as V,
  withErrorHandlingAndValidation
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateSecretRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";

const logger = getLogger({ service: "api", filePath: __filename });

function createSecret(db: Database) {
  const fn = async (
    call: { request: CreateSecretRequest },
    callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void
  ) => {
    const { name, secret } = call.request;
    const accessKeyId = getAccessKeyIdFromCall(
      call as unknown as ServerInterceptingCall
    );

    logger.verbose("call to createSecret", {
      accessKeyId
    });

    const result = await db.secret.create({
      data: {
        name,
        secret,
        accessKeyId
      }
    });

    callback(null, { ref: result.ref });
  };

  return withErrorHandlingAndValidation(fn, V.createSecretRequestSchema);
}

export { createSecret };
