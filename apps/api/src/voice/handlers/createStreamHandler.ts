import { z } from "zod";
import {
	StartStreamRequest,
	StreamAudioFormat,
	StreamDirection,
	StreamMessageType,
} from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { withErrorHandling } from "./utils/withErrorHandling";

const streamRequestSchema = z.object({
	direction: z.nativeEnum(StreamDirection, { message: "Invalid stream direction" }).optional(),
	format: z.nativeEnum(StreamAudioFormat, { message: "Invalid stream audio format" }).optional(),
});

function createStreamHandler(voiceClient: VoiceClient) {
	return withErrorHandling(async (request: StartStreamRequest) => {
		const { mediaSessionRef, direction, format } = request;

		streamRequestSchema.parse(request);

		const effectiveDirection = direction || StreamDirection.BOTH;
		const effectiveFormat = format || StreamAudioFormat.WAV;

		// FIXME: Implement stream IN and correct streamRef
		if (
			effectiveDirection.includes(StreamDirection.OUT) ||
			effectiveDirection === StreamDirection.BOTH
		) {
			voiceClient.getTranscriptionsStream().on("data", (data) => {
				voiceClient.sendResponse({
					streamPayload: {
						mediaSessionRef,
						type: StreamMessageType.AUDIO_OUT,
						data,
						streamRef: "fixme",
						format: effectiveFormat,
					},
				});
			});
		}

		voiceClient.sendResponse({
			startStreamResponse: {
				mediaSessionRef,
				streamRef: "fixme",
			},
		});
	});
}

export { createStreamHandler };
