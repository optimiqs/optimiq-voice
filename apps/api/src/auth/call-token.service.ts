import { Inject, Injectable } from "@nestjs/common";
import { type AuthPlatform } from "./auth.platform";
import { AUTH_PLATFORM } from "./auth.tokens";
import {
	buildCallAccessTokenClaims,
	CALL_TOKEN_EXPIRES_IN,
	type CallAccessTokenRequest,
} from "./call-token.claims";

/**
 * Per-call access tokens minted by better-auth's jwt plugin (identity-removal Step 4, additive).
 *
 * The claim contract lives in `call-token.claims.ts`; this file is only the signing adapter.
 *
 * NOTHING CALLS THIS ON THE LIVE CALL PATH YET. `src/voice/createCreateVoiceClient.ts` still uses
 * the identity signer; swapping it over is gated on `packages/voice/src/VoiceServer.ts` verifying
 * through JWKS instead of `getPublicKey`. See `plans/identity-removal.md` Step 4.
 */

/**
 * Mints a signed per-call token.
 *
 * `auth.api.signJWT` is a `serverOnly` endpoint of the jwt plugin: it takes an arbitrary payload
 * and signs it with the active JWKS key, with no session and no HTTP round trip. The plugin's
 * `definePayload` hook is deliberately not used — it derives its claims from a session, and a
 * call has none.
 */
export function createCallAccessTokenMinter(platform: AuthPlatform) {
	return async function mintCallAccessToken(request: CallAccessTokenRequest): Promise<string> {
		const { token } = await platform.auth.api.signJWT({
			body: {
				payload: {
					...buildCallAccessTokenClaims(request),
					// `jsonwebtoken` stamped `iat` for the identity-era token; the jwt plugin only
					// sets `exp`, so it is supplied here to keep the payload shape identical.
					iat: Math.floor(Date.now() / 1000),
				},
				overrideOptions: { jwt: { expirationTime: CALL_TOKEN_EXPIRES_IN } },
			},
		});
		return token;
	};
}

@Injectable()
export class CallTokenService {
	private readonly mint: ReturnType<typeof createCallAccessTokenMinter>;

	constructor(@Inject(AUTH_PLATFORM) platform: AuthPlatform) {
		this.mint = createCallAccessTokenMinter(platform);
	}

	/** @see createCallAccessTokenMinter */
	async createCallAccessToken(request: CallAccessTokenRequest): Promise<string> {
		return await this.mint(request);
	}
}
