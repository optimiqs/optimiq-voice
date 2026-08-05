import * as grpc from "@grpc/grpc-js";
import {
  exchangeCredentialsRequestSchema,
  GrpcErrorMessage
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Database } from "../db";
import { createGetUserByEmail } from "../utils/createGetUserByEmail";
import { createIsValidVerificationCode } from "../utils/createIsValidVerificationCode";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { ContactType } from "../verification";
import { exchangeTokens } from "./exchangeTokens";
import {
  ExchangeCredentialsRequest,
  ExchangeResponse,
  IdentityConfig
} from "./types";

const logger = getLogger({ service: "identity", filePath: __filename });

function createExchangeCredentials(
  db: Database,
  identityConfig: IdentityConfig
) {
  const isValidVerificationCode = createIsValidVerificationCode(db);

  const exchangeCredentials = async (
    call: { request: ExchangeCredentialsRequest },
    callback: (error?: GrpcErrorMessage, response?: ExchangeResponse) => void
  ) => {
    const { request } = call;
    const { username: email, password, twoFactorCode } = request;

    logger.verbose("call to exchangeCredentials", { username: email });

    const user = await createGetUserByEmail(db)(email);

    if (!user || user.password !== password?.trim()) {
      return callback({
        code: grpc.status.PERMISSION_DENIED,
        message: "Invalid credentials"
      });
    }

    // TODO: Rename verifcation methods to be more generic
    // At the moment name would suggest that 2FA and verification are the same thing
    if (identityConfig.twoFactorAuthenticationRequired) {
      const isValid = await isValidVerificationCode({
        type: ContactType.EMAIL,
        value: email,
        code: twoFactorCode
      });

      if (!isValid) {
        return callback({
          code: grpc.status.PERMISSION_DENIED,
          message: "Invalid 2FA code"
        });
      }
    }

    callback(null, await exchangeTokens(db, identityConfig)(user.accessKeyId));
  };

  return withErrorHandlingAndValidation(
    exchangeCredentials,
    exchangeCredentialsRequestSchema
  );
}

export { createExchangeCredentials };
