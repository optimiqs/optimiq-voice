import VoiceServer, { ServerConfig } from "@optimiq-voice/voice";
import { handleVoiceRequest } from "./handleVoiceRequest";

/**
 * The autopilot voice server.
 *
 * `sessionToken` is still what `apps/api` puts on the outbound `Voice/CreateSession` call and
 * still what `loadAssistantFromAPI` replays back into `Applications/GetApplication`; only the way
 * the token is VERIFIED changed — from an RS256 public key fetched over gRPC from the identity
 * service to the JWKS better-auth publishes at `${authUrl}/api/auth/jwks`.
 */
function startVoiceServer(config: Pick<ServerConfig, "authUrl" | "skipTokenVerification">) {
	new VoiceServer(config).listen(handleVoiceRequest);
}

export { startVoiceServer };
