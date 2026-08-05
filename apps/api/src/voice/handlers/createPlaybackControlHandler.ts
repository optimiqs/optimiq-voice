import { Client } from "ari-client";
import { z } from "zod";
import { PlaybackControlAction, PlaybackControlRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

const requestSchema = z.object({
	mediaSessionRef: z.string(),
	playbackRef: z.string().optional(),
	action: z.nativeEnum(PlaybackControlAction, {
		message: "Invalid playback control action.",
	}),
});

function createPlaybackControlHandler(ari: Client, voiceClient: VoiceClient) {
	return withErrorHandling(async (playbackControlReq: PlaybackControlRequest) => {
		requestSchema.parse(playbackControlReq);

		const { mediaSessionRef, playbackRef: playbackId, action } = playbackControlReq;

		try {
			if (action === PlaybackControlAction.STOP) {
				await ari.playbacks.stop({ playbackId });
			} else {
				await ari.playbacks.control({ playbackId, operation: action });
			}
		} catch (err) {
			// Ignore error
		}

		voiceClient.sendResponse({
			playbackControlResponse: {
				mediaSessionRef,
			},
		});
	});
}

export { createPlaybackControlHandler };
