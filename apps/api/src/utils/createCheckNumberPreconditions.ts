import { status } from "@grpc/grpc-js";
import { GrpcError } from "@optimiq-voice/common";
import { Database } from "../core/db";

function createCheckNumberPreconditions(db: Database) {
  return async function checkNumberPreconditions({ appRef, accessKeyId }) {
    // You can have a Number without an Application but it must exist
    if (!appRef) {
      return;
    }

    const app = await db.application.findUnique({
      where: { ref: appRef, accessKeyId }
    });

    if (!app) {
      throw new GrpcError(
        status.INVALID_ARGUMENT,
        "Application not found for ref: " + appRef
      );
    }
  };
}

export { createCheckNumberPreconditions };
