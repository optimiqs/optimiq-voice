import { VoiceRequest } from "@optimiq-voice/common";
import { VoiceResponse } from "./VoiceResponse";

type VoiceHandler = (req: VoiceRequest, res: VoiceResponse) => Promise<void>;

type ServerConfig = {
	bind?: string;
	port?: number;
	identityAddress?: string;
	skipIdentity?: boolean;
};

export { ServerConfig, VoiceHandler, VoiceRequest };
