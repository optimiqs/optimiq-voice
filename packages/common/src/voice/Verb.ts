import { VoiceClientConfig } from "./voice";

// Alias for VoiceClientConfig
type VoiceRequest = VoiceClientConfig;

type VerbRequest = {
	mediaSessionRef: string;
};

type VerbResponse = {
	mediaSessionRef: string;
};

export { VerbRequest, VerbResponse, VoiceRequest };
