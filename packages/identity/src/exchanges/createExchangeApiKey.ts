import * as grpc from "@grpc/grpc-js";
import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Database } from "../db";
import { createGetApiKeyByAccessKeyId } from "../utils/createGetApiKeyByAccessKeyId";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { exchangeTokens } from "./exchangeTokens";
import {
  ExchangeApiKeysRequest,
  ExchangeResponse,
  IdentityConfig
} from "./types";

const logger = getLogger({ service: "identity", filePath: __filename });

function createExchangeApiKey(db: Database, identityConfig: IdentityConfig) {
  const exchangeApiKey = async (
    call: { request: ExchangeApiKeysRequest },
    callback: (error: GrpcErrorMessage, response?: ExchangeResponse) => void
  ) => {
    const { request } = call;
    const { accessKeyId, accessKeySecret } = request;

    logger.verbose("call to exchangeApiKey", { accessKeyId });

    const key = await createGetApiKeyByAccessKeyId(db)(accessKeyId);

    if (key?.accessKeySecret !== accessKeySecret?.trim()) {
      return callback({
        code: grpc.status.PERMISSION_DENIED,
        message: "Invalid credentials"
      });
    }

    callback(null, await exchangeTokens(db, identityConfig)(accessKeyId));
  };

  return withErrorHandlingAndValidation(
    exchangeApiKey,
    V.exchangeApiKeysRequestSchema
  );
}

export { createExchangeApiKey };
