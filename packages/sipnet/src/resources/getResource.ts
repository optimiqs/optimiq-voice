import {
  Validators as V,
  withErrorHandlingAndValidation
} from "@optimiq-voice/common";
import { withAccess } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function getResource<T, R, U>(api: U, resource: string) {
  const fn = async (call: { request: R }): Promise<T> => {
    const { request } = call as { request: { ref: string } };

    logger.verbose(`call to get${resource}`, { request, resource });

    return await api[`get${resource}`](request.ref);
  };

  return withErrorHandlingAndValidation(
    withAccess(fn, (ref: string) => api[`get${resource}`](ref)),
    V.emptySchema
  );
}

export { getResource };
