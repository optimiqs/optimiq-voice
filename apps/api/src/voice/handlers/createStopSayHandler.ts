import { z } from "zod";
import { StopSayRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

const requestSchema = z.object({
	mediaSessionRef: z.string(),
});

function createStopSayHandler(voiceClient: VoiceClient) {
	return withErrorHandling(async (stopSayReq: StopSayRequest) => {
		requestSchema.parse(stopSayReq);

		const { mediaSessionRef } = stopSayReq;

		try {
			voiceClient.stopSynthesis();
		} catch (err) {
			// We can only try
		}

		voiceClient.sendResponse({
			stopSayResponse: {
				mediaSessionRef,
			},
		});
	});
}

export { createStopSayHandler };
