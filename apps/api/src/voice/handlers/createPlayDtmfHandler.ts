import { Client } from "ari-client";
import { PlayDtmfRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

function createPlayDtmfHandler(ari: Client, voiceClient: VoiceClient) {
	return withErrorHandling(async (request: PlayDtmfRequest) => {
		const { mediaSessionRef, digits } = request;

		await ari.channels.sendDTMF({
			channelId: mediaSessionRef,
			dtmf: digits,
		});

		voiceClient.sendResponse({
			playDtmfResponse: {
				mediaSessionRef,
			},
		});
	});
}

export { createPlayDtmfHandler };
