import { EmailParams } from "@optimiq-voice/common";

type InviteParams = {
  recipient: string;
  templateDir?: string;
  inviteUrl: string;
  isExistingUser: boolean;
  oneTimePassword?: string;
  workspaceName: string;
};

type SendInvite = (
  sendEmail: (params: EmailParams) => Promise<void>,
  request: InviteParams
) => Promise<void>;

export { InviteParams, SendInvite };
