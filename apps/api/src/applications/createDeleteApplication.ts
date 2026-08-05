import {
  Validators as V,
  withErrorHandlingAndValidation
} from "@optimiq-voice/common";
import { withAccess } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { createGetFnUtil } from "./createGetFnUtil";

const logger = getLogger({ service: "api", filePath: __filename });

function createDeleteApplication(db: Database) {
  const getFn = createGetFnUtil(db);

  const deleteApplication = async (call: {
    request: BaseApiObject;
  }): Promise<BaseApiObject> => {
    const { ref } = call.request;

    logger.verbose("call to deleteApplication", { ref });

    await db.application.delete({ where: { ref } });

    return { ref };
  };

  return withErrorHandlingAndValidation(
    withAccess(deleteApplication, (ref: string) => getFn(ref)),
    V.emptySchema
  );
}

export { createDeleteApplication };
