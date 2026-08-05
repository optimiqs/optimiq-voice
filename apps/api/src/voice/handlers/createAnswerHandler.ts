import { Client } from "ari-client";
import { VerbRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

function createAnswerHandler(ari: Client, voiceClient: VoiceClient) {
	return withErrorHandling(async (request: VerbRequest) => {
		const { mediaSessionRef } = request;

		await ari.channels.answer({ channelId: mediaSessionRef });

		voiceClient.sendResponse({
			answerResponse: {
				mediaSessionRef,
			},
		});
	});
}

export { createAnswerHandler };
