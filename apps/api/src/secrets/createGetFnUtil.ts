import { datesMapper } from "@optimiq-voice/common";
import { Database } from "../core/db";
import { notFoundError } from "../core/notFoundError";

function createGetFnUtil(db: Database) {
  return async function getFnUtil(ref: string) {
    const response = await db.secret.findUnique({
      where: { ref }
    });

    if (!response) {
      throw notFoundError(`Resource not found: ${ref}`);
    }

    return datesMapper({
      // NOTE: Adding extended to match the signature of withAccess
      ...response,
      extended: {
        accessKeyId: response.accessKeyId
      }
    });
  };
}

export { createGetFnUtil };
