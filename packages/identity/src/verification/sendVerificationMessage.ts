import { SmsParams } from "@optimiq-voice/common";
import { createBodyForVerificationMessage } from "./createBodyForVerificationMessage";
import { VerificationParams } from "./types";

async function sendVerificationMessage(
	sendSms: (params: SmsParams) => Promise<void>,
	request: VerificationParams,
) {
	const { recipient, verificationCode, templateDir } = request;

	await sendSms({
		to: recipient,
		body: createBodyForVerificationMessage({
			templateDir,
			verificationCode,
		}),
	});
}

export { sendVerificationMessage };
