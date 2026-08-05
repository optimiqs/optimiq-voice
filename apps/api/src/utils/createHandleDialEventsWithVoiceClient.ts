import { VoiceClient } from "../voice/types";
import { mapDialStatus } from "./mapDialStatus";

function createHandleDialEventsWithVoiceClient(voiceClient: VoiceClient) {
	return async function handleDialEventsWithVoiceClient(event: { dialstatus: string }) {
		const mappedStatus = mapDialStatus(event.dialstatus);
		if (!mappedStatus) return; // Ignore the event if status is not mapped

		voiceClient.sendResponse({
			dialResponse: {
				status: mappedStatus,
			},
		});
	};
}

export { createHandleDialEventsWithVoiceClient };
