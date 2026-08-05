import { assign } from "xstate";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export const appendSpeech = assign(({ context, event }) => {
	const speech = (event as unknown as { speech: string }).speech;

	logger.verbose("called the appendSpeech action", { speech });

	if (!speech) {
		return context;
	}

	context.speechBuffer = ((context.speechBuffer ?? "") + " " + speech).trimStart();

	return context;
});
