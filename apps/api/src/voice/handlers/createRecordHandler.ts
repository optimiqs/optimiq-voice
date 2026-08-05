import { Client } from "ari-client";
import { nanoid } from "nanoid";
import { RecordFormat, RecordRequest } from "@optimiq-voice/common";
import { VoiceClient } from "../types";
import { awaitForRecordingFinished } from "./utils/awaitForRecordingFinished";
import { withErrorHandling } from "./utils/withErrorHandling";

function createRecordHandler(ari: Client, voiceClient: VoiceClient) {
	return withErrorHandling(async (request: RecordRequest) => {
		const { mediaSessionRef, maxDuration, maxSilence, beep, finishOnKey } = request;
		const name = nanoid(10);

		await ari.channels.record({
			channelId: mediaSessionRef,
			format: RecordFormat.WAV,
			name,
			beep,
			maxDurationSeconds: maxDuration,
			maxSilenceSeconds: maxSilence,
			terminateOn: finishOnKey,
		});

		const { duration } = await awaitForRecordingFinished(ari, name);

		voiceClient.sendResponse({
			recordResponse: {
				mediaSessionRef,
				name,
				format: RecordFormat.WAV,
				duration,
			},
		});
	});
}

export { createRecordHandler };
