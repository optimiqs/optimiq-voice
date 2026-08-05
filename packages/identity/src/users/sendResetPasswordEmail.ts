import { EmailParams } from "@optimiq-voice/common";
import { createResetPasswordBody } from "./createResetPasswordBody";
import { SendResetPasswordEmailRequest } from "./types";

async function sendResetPasswordEmail(
  sendEmail: (params: EmailParams) => Promise<void>,
  request: SendResetPasswordEmailRequest
) {
  const { recipient, resetPasswordUrl, templateDir } = request;

  await sendEmail({
    to: recipient,
    subject: "Reset Password",
    html: createResetPasswordBody({
      templateDir,
      resetPasswordUrl
    })
  });
}

export { sendResetPasswordEmail };
