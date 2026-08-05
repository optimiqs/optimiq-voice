import path from "path";
import { compileTemplate } from "@optimiq-voice/common";
import { TemplatesEnum } from "../templates/TemplatesEnum";
import { VerificationParams } from "./types";

function createBodyForVerificationEmail(
  params: Omit<VerificationParams, "recipient">
) {
  const { verificationCode, templateDir: emailTemplateDir } = params;

  const template = TemplatesEnum.VERIFY_EMAIL;

  const templateDir =
    emailTemplateDir || path.join(__dirname, "..", "templates");

  const templatePath = `${templateDir}/${template}.hbs`;

  return compileTemplate({
    filePath: templatePath,
    data: {
      verificationCode
    }
  });
}

export { createBodyForVerificationEmail };
