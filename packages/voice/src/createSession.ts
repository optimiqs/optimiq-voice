import { StreamEvent, VoiceSessionStreamServer } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { VoiceHandler } from "./types";
import { VoiceResponse } from "./VoiceResponse";

const logger = getLogger({ service: "voice", filePath: __filename });

function createSession(handler: VoiceHandler) {
	return (voice: VoiceSessionStreamServer): Promise<void> =>
		new Promise((resolve) => {
			let mediaSessionRef: string;
			voice.once(StreamEvent.DATA, async (params) => {
				const { request } = params;

				if (request) {
					mediaSessionRef = request.mediaSessionRef;
					const response = new VoiceResponse(request, voice);
					await handler(request, response);
					resolve();
				}
			});

			voice.once(StreamEvent.END, () => {
				logger.verbose("session ended", { mediaSessionRef });
				voice.end();
				resolve();
			});
		});
}

export { createSession };
