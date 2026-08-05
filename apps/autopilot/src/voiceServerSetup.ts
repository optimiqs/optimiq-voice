import VoiceServer from "@optimiq-voice/voice";
import { handleVoiceRequest } from "./handleVoiceRequest";

function startVoiceServer(skipIdentity: boolean) {
  new VoiceServer({ skipIdentity }).listen(handleVoiceRequest);
}

export { startVoiceServer };
