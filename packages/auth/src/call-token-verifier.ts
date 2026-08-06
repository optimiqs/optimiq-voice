import { createRemoteJWKSet, type JWTPayload, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verification of the per-call access token.
 *
 * The token is minted by `apps/api/src/auth/call-token.service.ts` through better-auth's jwt
 * plugin and signed with the key in the `jwks` table, so the only thing a verifier needs is HTTP
 * access to `GET <AUTH_URL>/api/auth/jwks`. **No shared secret, no key file, no service-to-service
 * call** — which is why this module belongs beside the rest of the better-auth composition rather
 * than inside whichever process happens to consume a call token today.
 *
 * It lived in `packages/voice` while that package still terminated the gRPC call path. That
 * package is gone; this is the same logic, minus the CommonJS/ESM contortions its build required
 * (`jose@6` is ESM-only and `packages/voice` emitted CommonJS, so every `jose` symbol had to be
 * reached through a dynamic `import()`). This package is ESM, so the imports are static and
 * `createRemoteJWKSet` still owns the JWKS cache, the cooldown and the rotation refetch.
 *
 * `apps/api/scripts/verify-call-token.ts` proves a token minted by the live slice validates
 * through exactly this module, against a real `/api/auth/jwks` over HTTP.
 */

/** Audience every per-call token is minted for. Mirrors `CALL_TOKEN_AUDIENCE` in `apps/api`. */
export const CALL_TOKEN_AUDIENCE = "optimiq-voice/voice";

/** Where better-auth's jwt plugin publishes the signing keys, relative to `AUTH_URL`. */
export const JWKS_PATH = "/api/auth/jwks";

/** The metadata / header key a caller puts the token on. */
export const CALL_TOKEN_METADATA_KEY = "token";

/**
 * Metadata key a transport stamps the VERIFIED tenant onto.
 *
 * Deliberately not `accesskeyid`: that one was client-supplied and was the only tenant scoping on
 * the wire. This one is written by the server from a signed claim and can never be spoofed by the
 * caller.
 */
export const ORGANIZATION_METADATA_KEY = "organizationid";

/** The claims a verified per-call token carries. */
export interface CallTokenClaims {
	/** The canonical tenant claim. */
	readonly organizationId: string;
	/** The application handling the call. */
	readonly appRef: string;
	/** The call the token was scoped to; `null` for tokens minted before the claim existed. */
	readonly callRef: string | null;
	readonly payload: JWTPayload;
}

/** Raised for every rejection reason, so a consumer never leaks jose internals to a caller. */
export class CallTokenVerificationError extends Error {
	readonly _tag = "CallTokenVerificationError" as const;
	readonly reason: unknown;

	constructor(message: string, reason?: unknown) {
		super(message);
		this.name = "CallTokenVerificationError";
		this.reason = reason;
	}
}

export interface CallTokenVerifierOptions {
	/** Origin of the API serving `/api/auth/jwks` — `AUTH_URL`. */
	readonly authUrl: string;
	/** @default CALL_TOKEN_AUDIENCE */
	readonly audience?: string;
	/** Pin the issuer when the deployment has exactly one. Optional; `aud` already narrows. */
	readonly issuer?: string;
	/** Test seam: supply a key set instead of fetching one over HTTP. */
	readonly keySet?: JWTVerifyGetKey;
}

export type CallTokenVerifier = (token: string | undefined) => Promise<CallTokenClaims>;

function readString(payload: JWTPayload, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Narrows a verified payload to the claims a consumer acts on.
 *
 * Pure, so the claim contract is testable without a key pair. `accessKeyId` and `access[]` are
 * still accepted as fallbacks for `organizationId` because the minted payload is a superset of
 * them; they carry the organization id, not a workspace key, and cost one property read each.
 */
export function toCallTokenClaims(payload: JWTPayload): CallTokenClaims {
	const legacyAccess = Array.isArray(payload.access)
		? (payload.access as { accessKeyId?: unknown }[])[0]
		: undefined;
	const legacyAccessKeyId =
		typeof legacyAccess?.accessKeyId === "string" ? legacyAccess.accessKeyId.trim() : undefined;

	const organizationId =
		readString(payload, "organizationId") ??
		readString(payload, "accessKeyId") ??
		legacyAccessKeyId;
	if (!organizationId) {
		throw new CallTokenVerificationError("the token carries no tenant claim");
	}

	const appRef = readString(payload, "appRef") ?? readString(payload, "sub");
	if (!appRef) {
		throw new CallTokenVerificationError("the token carries no application ref");
	}

	return {
		organizationId,
		appRef,
		callRef: readString(payload, "callRef") ?? null,
		payload,
	};
}

/**
 * Builds the verifier a transport calls once per inbound call.
 *
 * The JWKS URL is resolved eagerly so a malformed `AUTH_URL` fails at start-up rather than on the
 * first call. The key set itself is created lazily and reused.
 */
export function createCallTokenVerifier(options: CallTokenVerifierOptions): CallTokenVerifier {
	const authUrl = options.authUrl?.trim();
	if (!authUrl) {
		throw new CallTokenVerificationError("AUTH_URL must be set to verify per-call tokens");
	}
	const jwksUrl = new URL(JWKS_PATH, authUrl);
	const audience = options.audience ?? CALL_TOKEN_AUDIENCE;

	let keySet: JWTVerifyGetKey | undefined;
	const resolveKeySet = (): JWTVerifyGetKey => {
		if (options.keySet) {
			return options.keySet;
		}
		keySet ??= createRemoteJWKSet(jwksUrl);
		return keySet;
	};

	return async (token) => {
		if (!token || token.trim().length === 0) {
			throw new CallTokenVerificationError("no token was presented");
		}

		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, resolveKeySet(), {
				audience,
				...(options.issuer === undefined ? {} : { issuer: options.issuer }),
			}));
		} catch (error) {
			throw new CallTokenVerificationError("the token could not be verified", error);
		}

		return toCallTokenClaims(payload);
	};
}
