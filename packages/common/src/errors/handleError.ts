import * as grpc from "@grpc/grpc-js";
import { status } from "@grpc/grpc-js";
import { z } from "zod";
import { getLogger } from "@optimiq-voice/logger";
import { DatabaseErrorCode } from "./DatabaseErrorCode";
import { handleZodError } from "./handleZodError";
import { GrpcErrorMessage } from "./types";

const logger = getLogger({ service: "api", filePath: __filename });

function handleError(
  error: Error | { code: string; message: string },
  callback: (error: GrpcErrorMessage) => void
) {
  if (error instanceof z.ZodError) {
    handleZodError(error, callback);
    return;
  }

  const { code, message } = error as { code: string | number; message: string };

  const logAndCallback = (
    errorCode: number,
    errorMessage: string,
    logMessage: string
  ) => {
    logger.error(logMessage, { message: errorMessage });

    const messageParts = errorMessage.split(":");
    let effectiveErrorMessage = errorMessage;

    if (errorCode === status.NOT_FOUND && messageParts.length > 1) {
      effectiveErrorMessage = `Resource not found: ${messageParts[messageParts.length - 1].trim()}`;
    }

    callback({ code: errorCode, message: effectiveErrorMessage });
  };

  switch (code) {
    case DatabaseErrorCode.RECORD_ALREADY_EXISTS:
    case grpc.status.ALREADY_EXISTS:
      logAndCallback(
        status.ALREADY_EXISTS,
        "The resource already exists",
        "duplicated entity error"
      );
      break;
    case DatabaseErrorCode.RECORD_NOT_FOUND:
    case grpc.status.NOT_FOUND:
      logAndCallback(
        status.NOT_FOUND,
        "The requested resource was not found",
        "not found error"
      );
      break;
    case grpc.status.PERMISSION_DENIED:
      logAndCallback(
        status.PERMISSION_DENIED,
        "You don't have permission to perform this action",
        "permission denied error"
      );
      break;
    case grpc.status.UNAUTHENTICATED:
      logAndCallback(
        status.UNAUTHENTICATED,
        "You need to be authenticated to perform this action",
        "unauthenticated error"
      );
      break;
    case grpc.status.INVALID_ARGUMENT:
      logAndCallback(
        status.INVALID_ARGUMENT,
        message ?? "Your request has one or more invalid arguments",
        "invalid argument error"
      );
      break;
    default:
      logger.error("internal server error:", error);
      callback({ code: status.INTERNAL, message: "Internal server error" });
  }
}

export { handleError };
