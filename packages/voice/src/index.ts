import {
	AzureVoice,
	AzureVoiceDetails,
	GatherSource,
	GoogleVoice,
	GoogleVoiceDetails,
	StreamGatherSource,
} from "@optimiq-voice/common";
import VoiceServer from "./VoiceServer";

export default VoiceServer;
export * from "./callTokenVerifier";
export { createJwksAuthInterceptor } from "./createJwksAuthInterceptor";
export * from "./VoiceResponse";
export * from "./types";
export {
	AzureVoice,
	AzureVoiceDetails,
	GatherSource,
	GoogleVoice,
	GoogleVoiceDetails,
	StreamGatherSource,
};
