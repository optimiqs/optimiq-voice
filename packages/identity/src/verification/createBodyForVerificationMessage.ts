import path from "path";
import { compileTemplate } from "@optimiq-voice/common";
import { TemplatesEnum } from "../templates/TemplatesEnum";
import { VerificationParams } from "./types";

function createBodyForVerificationMessage(params: Omit<VerificationParams, "recipient">) {
	const { verificationCode, templateDir } = params;

	const template = TemplatesEnum.VERIFY_PHONE;

	const actualTemplateDir = templateDir || path.join(__dirname, "..", "templates");

	const templatePath = `${actualTemplateDir}/${template}.hbs`;

	return compileTemplate({
		filePath: templatePath,
		data: {
			verificationCode,
		},
	});
}

export { createBodyForVerificationMessage };
