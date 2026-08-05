import { status } from "@grpc/grpc-js";
import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ContactType, ResetPasswordRequest } from "@optimiq-voice/types";
import { Database } from "../db";
import { createIsValidVerificationCode } from "../utils/createIsValidVerificationCode";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createResetPassword(db: Database) {
  const isValidVerificationCode = createIsValidVerificationCode(db);

  const resetPassword = async (
    call: { request: ResetPasswordRequest },
    callback: (error?: GrpcErrorMessage) => void
  ) => {
    const { request } = call;
    const { username, password, verificationCode } = request;

    logger.verbose("call to resetPassword", {
      username,
      password,
      verificationCode
    });

    const isValid = await isValidVerificationCode({
      type: ContactType.EMAIL,
      value: username,
      code: verificationCode
    });

    if (!isValid) {
      return callback({
        code: status.PERMISSION_DENIED,
        message: "Invalid verification code"
      });
    }

    await db.user.update({
      where: { email: username },
      data: { password }
    });

    callback(null);
  };

  return withErrorHandlingAndValidation(
    resetPassword,
    V.resetPasswordRequestSchema
  );
}

export { createResetPassword };
