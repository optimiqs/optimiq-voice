import { DialRequest } from "@optimiq-voice/common";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handleStasisEnd(request: DialRequest) {
	return async () => {
		// Fixme: Should upload the recording to the storage service
		// no-op
	};
}

export { handleStasisEnd };
