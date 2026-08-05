/**
 * The claim contract of the per-call access token (identity-removal Step 4).
 *
 * Deliberately free of `@nestjs/common` and of decorators: `src/auth/call-token.service.ts` is
 * the Nest adapter, this is the logic. Keeping them apart lets `test/auth/callTokenClaims.test.ts`
 * pin the contract without pulling a decorated class into a program that may not have
 * `experimentalDecorators` (the repository-root mocha invocation resolves the root tsconfig,
 * which does not).
 *
 * This is the replacement for `createGenerateCallAccessToken` in `packages/identity`, which signs
 * with `.keys/private.pem` (RS256) and can only be verified by a party that fetched the identity
 * service's public key over gRPC. Tokens built from these claims are signed with the key
 * better-auth manages in the `jwks` table and are verifiable by anyone who can reach
 * `GET /api/auth/jwks`.
 *
 * ## Claim mapping
 *
 * The payload is a strict SUPERSET of the legacy one, so a verifier can be migrated to JWKS
 * without simultaneously being migrated off the `access[]` shape:
 *
 * | legacy (`createGenerateCallAccessToken`)         | here                                          |
 * | ------------------------------------------------ | --------------------------------------------- |
 * | `iss` — `API_IDENTITY_ISSUER`                    | `iss` — the jwt plugin's issuer (`AUTH_URL`)  |
 * | `sub` — the application ref                      | `sub` — the application ref (unchanged)       |
 * | `aud` — `API_IDENTITY_AUDIENCE`                  | `aud` — {@link CALL_TOKEN_AUDIENCE}           |
 * | `tokenUse: "access"`                             | `tokenUse: "access"` (unchanged)              |
 * | `accessKeyId` — the workspace access key         | `accessKeyId` — now the organization id       |
 * | `access: [{ accessKeyId, role: VOICE_SERVICE }]` | same, with the organization id inside         |
 * | —                                                | `organizationId` — the canonical tenant claim |
 * | —                                                | `appRef` — explicit, no longer only in `sub`  |
 * | —                                                | `callRef` — new; scopes the token to one call |
 * | RS256, `.keys/private.pem`                       | the jwks key, published at `/api/auth/jwks`   |
 * | `expiresIn: "30s"`                               | {@link CALL_TOKEN_EXPIRES_IN} (`"30s"`)       |
 *
 * `accessKeyId` and `access[]` carry the ORGANIZATION ID during coexistence: every consumer that
 * reads them (`hasAccess`, `tokenHasAccessKeyId` in `packages/common/src/identity/`) only ever
 * compares them for equality against the tenant identifier on the wire, so the value changes but
 * the shape does not. They are deleted with `packages/common/src/identity/` in Step 9.
 */

/** Just enough time to validate one `Voice/CreateSession`, matching the legacy signer. */
export const CALL_TOKEN_EXPIRES_IN = "30s";

/** Audience every per-call token is minted for. */
export const CALL_TOKEN_AUDIENCE = "optimiq-voice/voice";

/** The role the voice service is granted for the lifetime of a single call. */
export const CALL_TOKEN_ROLE = "VOICE_SERVICE";

export interface CallAccessTokenRequest {
	/** The tenant. Replaces the workspace `accessKeyId` of the identity-era token. */
	readonly organizationId: string;
	/** The application handling the call — `sub` in both the legacy and the new payload. */
	readonly appRef: string;
	/** The call this token is scoped to. New; the identity-era token had no call binding. */
	readonly callRef: string;
}

export interface CallAccessTokenClaims {
	readonly sub: string;
	readonly aud: string;
	readonly tokenUse: "access";
	readonly organizationId: string;
	readonly appRef: string;
	readonly callRef: string;
	/** Legacy alias of `organizationId`; read by `packages/common/src/identity/`. */
	readonly accessKeyId: string;
	/** Legacy shape, kept until the gRPC interceptor is deleted in Step 9. */
	readonly access: readonly { readonly accessKeyId: string; readonly role: string }[];
}

/** Raised when a caller asks for a token without the identifiers it must be scoped by. */
export class CallAccessTokenScopeError extends Error {
	readonly _tag = "CallAccessTokenScopeError" as const;
	readonly missing: readonly string[];

	constructor(missing: readonly string[]) {
		super(`A per-call access token requires ${missing.join(", ")}.`);
		this.name = "CallAccessTokenScopeError";
		this.missing = missing;
	}
}

/**
 * Builds the payload. Pure and side-effect free so the claim contract can be asserted without a
 * database, a key pair or a running server.
 */
export function buildCallAccessTokenClaims(request: CallAccessTokenRequest): CallAccessTokenClaims {
	const missing: string[] = [];
	if (!request.organizationId?.trim()) missing.push("organizationId");
	if (!request.appRef?.trim()) missing.push("appRef");
	if (!request.callRef?.trim()) missing.push("callRef");
	if (missing.length > 0) {
		throw new CallAccessTokenScopeError(missing);
	}

	const organizationId = request.organizationId.trim();

	return {
		sub: request.appRef.trim(),
		aud: CALL_TOKEN_AUDIENCE,
		tokenUse: "access",
		organizationId,
		appRef: request.appRef.trim(),
		callRef: request.callRef.trim(),
		accessKeyId: organizationId,
		access: [{ accessKeyId: organizationId, role: CALL_TOKEN_ROLE }],
	};
}
