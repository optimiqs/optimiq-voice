import { EmailParams } from "@optimiq-voice/common";
import { createBodyForVerificationEmail } from "./createBodyForVerificationEmail";
import { VerificationParams } from "./types";

async function sendVerificationEmail(
  sendEmail: (params: EmailParams) => Promise<void>,
  request: VerificationParams
) {
  const { recipient, verificationCode, templateDir } = request;

  await sendEmail({
    to: recipient,
    subject: "Your verification code",
    html: createBodyForVerificationEmail({
      templateDir,
      verificationCode
    })
  });
}

export { sendVerificationEmail };
