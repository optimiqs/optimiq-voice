import * as grpc from "@grpc/grpc-js";
import {
  exchangeOauth2RequestSchema,
  GrpcErrorMessage
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Database } from "../db";
import { createGetUserByEmail } from "../utils/createGetUserByEmail";
import { getGitHubUserWithOauth2Code } from "../utils/getGitHubUserWithOauth2Code";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { exchangeTokens } from "./exchangeTokens";
import {
  ExchangeOauth2CodeRequest,
  ExchangeResponse,
  IdentityConfig
} from "./types";

const logger = getLogger({ service: "identity", filePath: __filename });

function createExchangeOauth2Code(
  db: Database,
  identityConfig: IdentityConfig
) {
  const exchangeOauth2Code = async (
    call: { request: ExchangeOauth2CodeRequest },
    callback: (error?: GrpcErrorMessage, response?: ExchangeResponse) => void
  ) => {
    const { request } = call;
    const { provider, code } = request;

    logger.verbose("call to exchangeOauth2Code", { provider });

    const userData = await getGitHubUserWithOauth2Code({
      clientId: identityConfig.githubOauth2Config.clientId,
      clientSecret: identityConfig.githubOauth2Config.clientSecret,
      code
    });

    const user = await createGetUserByEmail(db)(userData.email);

    if (!user) {
      return callback({
        code: grpc.status.PERMISSION_DENIED,
        message: "Invalid credentials"
      });
    }

    callback(null, await exchangeTokens(db, identityConfig)(user.accessKeyId));
  };

  return withErrorHandlingAndValidation(
    exchangeOauth2Code,
    exchangeOauth2RequestSchema
  );
}

export { createExchangeOauth2Code };
