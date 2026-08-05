// `resolution-mode: import` is required for a type-only reference to an ESM-only package from a
// CommonJS-emitting file (TS1541). It affects types only — nothing is emitted for this line.
import type { JWTPayload, JWTVerifyGetKey } from "jose" with { "resolution-mode": "import" };

/**
 * Verification of the per-call access token (identity-removal Step 4, item 2).
 *
 * This replaces `getPublicKey(config.identityAddress)` — a gRPC round trip to the identity
 * service at start-up, whose RS256 PEM was then handed to `createAuthInterceptor`. The token is
 * now minted by `apps/api/src/auth/call-token.service.ts` through better-auth's jwt plugin and
 * signed with the key in the `jwks` table, so the only thing a verifier needs is HTTP access to
 * `GET <AUTH_URL>/api/auth/jwks`. No shared secret, no key file, no service-to-service call.
 *
 * `apps/api/scripts/verify-call-token.ts` proves a token minted by the live slice validates
 * through exactly this module.
 *
 * ## Why jose is imported dynamically
 *
 * `jose@6` is ESM-only and `packages/voice` still emits CommonJS. The tsconfig is on
 * `module: node16`, which resolves the package's `exports` map for types AND leaves `import()`
 * untouched in the emitted CommonJS — so this is a real ESM load at runtime, not a downlevelled
 * `require`. A static import would be TS1479. The import is awaited once and cached by the module
 * system; `createRemoteJWKSet` then caches and rate-limits the JWKS fetch itself.
 */

/** Audience every per-call token is minted for. Mirrors `CALL_TOKEN_AUDIENCE` in `apps/api`. */
const CALL_TOKEN_AUDIENCE = "optimiq-voice/voice";

/** Where better-auth's jwt plugin publishes the signing keys, relative to `AUTH_URL`. */
const JWKS_PATH = "/api/auth/jwks";

/** The gRPC metadata key the caller puts the token on. Unchanged from the identity era. */
const CALL_TOKEN_METADATA_KEY = "token";

/**
 * Metadata key the interceptor stamps the VERIFIED tenant onto.
 *
 * Deliberately not `accesskeyid`: that one was client-supplied and was the only tenant scoping on
 * the wire (see §2.3 of the cutover plan). This one is written by the server from a signed claim
 * and can never be spoofed by the caller.
 */
const ORGANIZATION_METADATA_KEY = "organizationid";

/** The claims a verified per-call token carries. */
interface CallTokenClaims {
	/** The canonical tenant claim. */
	readonly organizationId: string;
	/** The application handling the call. */
	readonly appRef: string;
	/** The call the token was scoped to; `null` for tokens minted before the claim existed. */
	readonly callRef: string | null;
	readonly payload: JWTPayload;
}

/** Raised for every rejection reason, so the interceptor never leaks jose internals to a caller. */
class CallTokenVerificationError extends Error {
	readonly _tag = "CallTokenVerificationError" as const;
	/** Held explicitly: the package targets a lib without `Error.cause`. */
	readonly reason: unknown;

	constructor(message: string, reason?: unknown) {
		super(message);
		this.name = "CallTokenVerificationError";
		this.reason = reason;
	}
}

interface CallTokenVerifierOptions {
	/** Origin of the API serving `/api/auth/jwks` — `AUTH_URL`. */
	readonly authUrl: string;
	/** @default CALL_TOKEN_AUDIENCE */
	readonly audience?: string;
	/** Pin the issuer when the deployment has exactly one. Optional; `aud` already narrows. */
	readonly issuer?: string;
	/** Test seam: supply a key set instead of fetching one over HTTP. */
	readonly keySet?: JWTVerifyGetKey;
}

type CallTokenVerifier = (token: string | undefined) => Promise<CallTokenClaims>;

function readString(payload: JWTPayload, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Narrows a verified payload to the claims this service acts on.
 *
 * Pure, so the claim contract is unit-testable without a key pair. `accessKeyId` and `access[]`
 * are accepted as fallbacks for `organizationId` only because the minted payload is a superset
 * during coexistence; both die with `packages/common/src/identity/` in Step 9.
 */
function toCallTokenClaims(payload: JWTPayload): CallTokenClaims {
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
 * Builds the verifier the gRPC interceptor calls once per inbound call.
 *
 * The JWKS URL is resolved eagerly so a malformed `AUTH_URL` fails at server start rather than on
 * the first call. The key set itself is created lazily and reused, because `createRemoteJWKSet`
 * owns the cache, the cooldown and the rotation refetch.
 */
function createCallTokenVerifier(options: CallTokenVerifierOptions): CallTokenVerifier {
	const authUrl = options.authUrl?.trim();
	if (!authUrl) {
		throw new CallTokenVerificationError(
			"AUTH_URL must be set for the voice server to verify per-call tokens",
		);
	}
	const jwksUrl = new URL(JWKS_PATH, authUrl);
	const audience = options.audience ?? CALL_TOKEN_AUDIENCE;

	let keySet: Promise<JWTVerifyGetKey> | undefined;
	const resolveKeySet = async (): Promise<JWTVerifyGetKey> => {
		if (options.keySet) {
			return options.keySet;
		}
		keySet ??= import("jose").then(({ createRemoteJWKSet }) => createRemoteJWKSet(jwksUrl));
		return await keySet;
	};

	return async (token) => {
		if (!token || token.trim().length === 0) {
			throw new CallTokenVerificationError("no token was presented");
		}

		const [{ jwtVerify }, keys] = await Promise.all([import("jose"), resolveKeySet()]);

		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, keys, {
				audience,
				...(options.issuer === undefined ? {} : { issuer: options.issuer }),
			}));
		} catch (error) {
			throw new CallTokenVerificationError("the token could not be verified", error);
		}

		return toCallTokenClaims(payload);
	};
}

export {
	CALL_TOKEN_AUDIENCE,
	CALL_TOKEN_METADATA_KEY,
	type CallTokenClaims,
	type CallTokenVerifier,
	type CallTokenVerifierOptions,
	CallTokenVerificationError,
	createCallTokenVerifier,
	JWKS_PATH,
	ORGANIZATION_METADATA_KEY,
	toCallTokenClaims,
};
