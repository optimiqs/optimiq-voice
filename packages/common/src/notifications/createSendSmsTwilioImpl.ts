import twilio from "twilio";
import { getLogger } from "@optimiq-voice/logger";
import { SmsParams, TwilioSmsSenderConfig } from "./types";

const logger = getLogger({ service: "common", filePath: __filename });

function createSendSmsTwilioImpl(
	config: TwilioSmsSenderConfig | undefined,
): (params: SmsParams) => Promise<void> {
	if (!config) {
		return async function sendSms(_params: SmsParams): Promise<void> {
			logger.verbose("SMS sender not configured, skipping");
		};
	}

	const { sender: from, accountSid, authToken } = config;
	const client = twilio(accountSid, authToken);

	return async function sendSms(params: SmsParams): Promise<void> {
		const { to, body } = params;

		const result = await client.messages.create({
			body,
			from,
			to,
		});

		logger.verbose("message sent", {
			status: result.status,
			messageId: result.sid,
		});
	};
}

export { createSendSmsTwilioImpl };
