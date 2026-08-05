import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
  ContactType,
  SendResetPasswordCodeRequest
} from "@optimiq-voice/types";
import { Database } from "../db";
import { IdentityConfig } from "../exchanges/types";
import { createSendEmail } from "../utils";
import { createGenerateVerificationCode } from "../utils/createGenerateVerificationCode";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { sendResetPasswordEmail } from "./sendResetPasswordEmail";
const logger = getLogger({ service: "identity", filePath: __filename });

function createSendResetPasswordCode(
  db: Database,
  identityConfig: IdentityConfig
) {
  const generateVerificationCode = createGenerateVerificationCode(db);

  const sendResetPasswordCode = async (
    call: { request: SendResetPasswordCodeRequest },
    callback: (error?: GrpcErrorMessage) => void
  ) => {
    const { request } = call;
    const { username } = request;

    logger.verbose("call to sendResetPasswordCode", { username });

    const user = await db.user.findUnique({
      where: { email: username }
    });

    if (!user) {
      // The WebUI or any other client should display something like:
      // "If a user with this email exists, a password reset code has been sent"
      return callback(null);
    }

    const code = await generateVerificationCode({
      type: ContactType.EMAIL,
      value: username
    });

    const payload = { username, code };

    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64"
    );

    await sendResetPasswordEmail(createSendEmail(identityConfig), {
      recipient: username,
      resetPasswordUrl: `${request.resetPasswordUrl}?token=${encodedPayload}`
    });

    callback(null);
  };

  return withErrorHandlingAndValidation(
    sendResetPasswordCode,
    V.sendResetPasswordCodeRequestSchema
  );
}

export { createSendResetPasswordCode };
