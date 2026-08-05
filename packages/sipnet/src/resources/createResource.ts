import { ServerInterceptingCall } from "@grpc/grpc-js";
import { z } from "zod";
import {
  getAccessKeyIdFromCall,
  GrpcErrorMessage,
  withErrorHandlingAndValidation
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function createResource<T, R, U>(
  api: U,
  resource: string,
  schema: z.ZodSchema
) {
  const fn = async (
    call: { request: R },
    callback: (error?: GrpcErrorMessage, response?: T) => void
  ) => {
    const { request } = call;

    const accessKeyId = getAccessKeyIdFromCall(
      call as unknown as ServerInterceptingCall
    );

    logger.verbose(`call to create${resource}`, { ...request, accessKeyId });

    const response = await api[`create${resource}`]({
      ...request,
      extended: {
        accessKeyId
      }
    });

    callback(null, response);
  };

  return withErrorHandlingAndValidation(fn, schema);
}

export { createResource };
