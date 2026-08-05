import path from "path";
import { compileTemplate } from "@optimiq-voice/common";
import { TemplatesEnum } from "../templates/TemplatesEnum";
import { InviteParams } from "./types";

function createInviteBody(params: Omit<InviteParams, "recipient">) {
  const {
    templateDir: emailTemplateDir,
    isExistingUser,
    workspaceName,
    oneTimePassword,
    inviteUrl
  } = params;

  const template = isExistingUser
    ? TemplatesEnum.INVITE_EXISTING_USER
    : TemplatesEnum.INVITE_NEW_USER;

  const templateDir =
    emailTemplateDir || path.join(__dirname, "..", "templates");

  const templatePath = `${templateDir}/${template}.hbs`;

  return compileTemplate({
    filePath: templatePath,
    data: {
      workspaceName,
      oneTimePassword,
      inviteUrl
    }
  });
}

export { createInviteBody };
