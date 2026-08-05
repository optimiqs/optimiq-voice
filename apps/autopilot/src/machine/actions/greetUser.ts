import { getLogger } from "@optimiq-voice/logger";
import { AutopilotContext } from "../types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const greetUser = async ({ context }: { context: AutopilotContext }): Promise<void> => {
	logger.verbose("called the greetUser action", {
		firstMessage: context.firstMessage,
	});

	await context.voice.answer();

	if (context.initialDtmf) {
		await context.voice.playDtmf(context.initialDtmf);
	}

	if (context.firstMessage) {
		await context.voice.say(context.firstMessage);
	}
};
