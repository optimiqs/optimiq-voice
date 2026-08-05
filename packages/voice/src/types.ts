import { VoiceRequest } from "@optimiq-voice/common";
import { VoiceResponse } from "./VoiceResponse";

type VoiceHandler = (req: VoiceRequest, res: VoiceResponse) => Promise<void>;

type ServerConfig = {
	bind?: string;
	port?: number;
	/**
	 * Origin of the API that publishes `/api/auth/jwks` — the standard `AUTH_URL`.
	 *
	 * Replaces `identityAddress`, which named the identity gRPC service the server fetched a
	 * public key from at start-up (identity-removal Step 4, item 2).
	 */
	authUrl?: string;
	/**
	 * Accept calls without verifying the per-call token. **Development only.** Replaces
	 * `skipIdentity` / `AUTOPILOT_SKIP_IDENTITY`; when it is unset and no `authUrl` is configured
	 * the server refuses to start rather than serving unauthenticated traffic.
	 */
	skipTokenVerification?: boolean;
};

export { ServerConfig, VoiceHandler, VoiceRequest };
