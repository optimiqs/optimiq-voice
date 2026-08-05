import { EmailParams } from "@optimiq-voice/common";
import { createInviteBody } from "./createInviteBody";
import { InviteParams } from "./types";

async function sendInvite(
  sendEmail: (params: EmailParams) => Promise<void>,
  request: InviteParams
) {
  const {
    recipient,
    inviteUrl,
    oneTimePassword,
    isExistingUser,
    workspaceName,
    templateDir
  } = request;

  await sendEmail({
    to: recipient,
    subject: "Invitation to join a Optimiq Voice workspace",
    html: createInviteBody({
      templateDir,
      isExistingUser,
      workspaceName,
      oneTimePassword: isExistingUser ? undefined : oneTimePassword,
      inviteUrl
    })
  });
}

export { sendInvite };
