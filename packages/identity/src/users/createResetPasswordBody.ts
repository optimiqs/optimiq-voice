import path from "path";
import { compileTemplate } from "@optimiq-voice/common";
import { TemplatesEnum } from "../templates/TemplatesEnum";
import { SendResetPasswordEmailRequest } from "./types";

function createResetPasswordBody(
  params: Omit<SendResetPasswordEmailRequest, "recipient">
) {
  const { templateDir: emailTemplateDir, resetPasswordUrl } = params;

  const template = TemplatesEnum.RESET_PASSWORD;

  const templateDir =
    emailTemplateDir || path.join(__dirname, "..", "templates");

  const templatePath = `${templateDir}/${template}.hbs`;

  return compileTemplate({
    filePath: templatePath,
    data: {
      resetPasswordUrl
    }
  });
}

export { createResetPasswordBody };
