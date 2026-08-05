import {
  createSendEmail,
  createSendSmsTwilioImpl,
  GrpcErrorMessage,
  Validators as V
} from "@optimiq-voice/common";
import { Database } from "../db";
import { IdentityConfig } from "../exchanges";
import { createGenerateVerificationCode } from "../utils/createGenerateVerificationCode";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { sendVerificationEmail } from "./sendVerificationEmail";
import { sendVerificationMessage } from "./sendVerificationMessage";
import { ContactType, SendVerificationCodeRequest } from "./types";

function createSendVerificationCode(
  db: Database,
  identityConfig: IdentityConfig
) {
  const sendSms = createSendSmsTwilioImpl(identityConfig.twilioSmsConfig);
  const sendEmail = createSendEmail(identityConfig.smtpConfig);
  const generateVerificationCode = createGenerateVerificationCode(db);

  const fn = async (
    call: { request: SendVerificationCodeRequest },
    callback: (error: GrpcErrorMessage) => void
  ) => {
    const { request } = call;
    const actualContactType = request.contactType ?? ContactType.EMAIL;

    const verificationCode = await generateVerificationCode({
      type: actualContactType,
      value: request.value
    });

    if (actualContactType === ContactType.EMAIL) {
      sendVerificationEmail(sendEmail, {
        recipient: request.value,
        verificationCode
      });
    } else {
      await sendVerificationMessage(sendSms, {
        recipient: request.value,
        verificationCode
      });
    }

    callback(null);
  };

  return withErrorHandlingAndValidation(
    fn,
    V.sendVerificationCodeRequestSchema
  );
}

export { createSendVerificationCode };
