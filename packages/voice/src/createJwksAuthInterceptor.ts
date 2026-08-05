import { Metadata, ServerInterceptingCall, status } from "@grpc/grpc-js";
import { getLogger } from "@optimiq-voice/logger";
import {
	CALL_TOKEN_METADATA_KEY,
	CallTokenVerifier,
	ORGANIZATION_METADATA_KEY,
} from "./callTokenVerifier";

const logger = getLogger({ service: "voice", filePath: __filename });

/**
 * The gRPC server interceptor that replaces `createAuthInterceptor` on the voice server
 * (identity-removal Step 4, item 2).
 *
 * Two things changed and both matter:
 *
 * 1. **Verification is asynchronous.** The identity-era interceptor called `jwt.verify` with a
 *    PEM it had already fetched, so it could decide synchronously. JWKS verification is a
 *    promise, so the decision is deferred inside `onReceiveMetadata` — the call does not proceed
 *    to the handler until `next(metadata)` runs, and a rejection ends it with `UNAUTHENTICATED`
 *    before any application code sees it.
 * 2. **The tenant is no longer client-supplied.** `getAccessKeyIdFromCall` read the `accesskeyid`
 *    metadata key straight off the wire. The organization id is now taken from a signed claim and
 *    stamped onto {@link ORGANIZATION_METADATA_KEY}, overwriting anything the caller sent.
 *
 * There is no RBAC check here. The identity-era `hasAccess(decoded, path)` matched a role against
 * `packages/common/src/identity/roles.ts`; the voice server exposes exactly one method, and a
 * token is minted for a single call with `aud: "optimiq-voice/voice"`, so a valid audience IS the
 * authorization decision. Permission-level authorization lives in `apps/api` behind
 * `@RequirePermissions`.
 */
function createJwksAuthInterceptor(verify: CallTokenVerifier, publicPaths: readonly string[]) {
	return (methodDefinition: { path: string }, call: ServerInterceptingCall) => {
		const { path } = methodDefinition;

		if (publicPaths.includes(path)) {
			logger.verbose("passing auth control to edge function", { path });
			return call;
		}

		return new ServerInterceptingCall(call, {
			start: (next) => {
				next({
					onReceiveMetadata: (metadata: Metadata, proceed: (metadata: Metadata) => void) => {
						const token = metadata.get(CALL_TOKEN_METADATA_KEY)[0]?.toString();

						verify(token)
							.then((claims) => {
								// Server-verified, so it replaces whatever the caller claimed.
								metadata.set(ORGANIZATION_METADATA_KEY, claims.organizationId);
								logger.verbose("per-call token verified", {
									path,
									organizationId: claims.organizationId,
									appRef: claims.appRef,
									callRef: claims.callRef,
								});
								proceed(metadata);
							})
							.catch((error: unknown) => {
								logger.verbose("rejecting call with an invalid per-call token", { path, error });
								call.sendStatus({
									code: status.UNAUTHENTICATED,
									details: "Invalid or expired token",
								});
							});
					},
				});
			},
		});
	};
}

export { createJwksAuthInterceptor };
