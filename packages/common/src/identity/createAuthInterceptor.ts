import { Metadata, ServerInterceptingCall } from "@grpc/grpc-js";
import { getLogger } from "@optimiq-voice/logger";
import { decodeToken } from "./decodeToken";
import { permissionDeniedError, unauthenticatedError } from "./errors";
import { getTokenFromCall } from "./getTokenFromCall";
import { hasAccess } from "./hasAccess";
import { isValidToken } from "./isValidToken";
import { workspaceResourceAccess, workspaceResourceOwnerOrAdminAccess } from "./roles";
import { tokenHasAccessKeyId } from "./tokenHasAccessKeyId";
import { Access, TokenUseEnum } from "./types";

const logger = getLogger({ service: "common", filePath: __filename });

/**
 * The **client-supplied** `accesskeyid` header.
 *
 * This used to be the exported `getAccessKeyIdFromCall`, which 18 handlers across five packages
 * called to scope their queries. Identity-removal Step 3 item 2 deleted that export: the tenant is
 * now derived from the verified token and stamped by `createTenancyInterceptor`, and handlers read
 * it through `getOrganizationIdFromCall` / `getTenantAccessKeyFromCall` in `src/tenancy/`.
 *
 * It survives here, private and unexported, only because this interceptor's `tokenHasAccessKeyId`
 * cross-check runs BEFORE the tenancy interceptor overwrites the header, so at this point it is
 * still what the caller sent — which is exactly what that check is meant to compare against. This
 * whole module is deleted in Step 9 (sequencing rule 4).
 */
function readRequestedAccessKeyId(call: ServerInterceptingCall): string | undefined {
	return (call as unknown as { metadata: Metadata }).metadata.getMap()["accesskeyid"]?.toString();
}

/**
 * This function is a gRPC interceptor that checks if the request is valid
 * and if the user has the right permissions to access the resource. When
 * validating the request, the function will check if the request is in the
 * skip list, if the token is valid and if the role is allowed by the RBAC.
 *
 * @param {string} identityPublicKey - The public key to validate the token
 * @param {string[]} publicPath - The list of public paths
 * @return {Function} - The gRPC interceptor
 */
function createAuthInterceptor(identityPublicKey: string, publicPath: string[]) {
	/**
	 * Inner function that will be called by the gRPC server.
	 *
	 * @param {object} methodDefinition - The method definition
	 * @param {string} methodDefinition.path - The path of the gRPC method
	 * @param {ServerInterceptingCall} call - The call object
	 * @return {ServerInterceptingCall} - The modified call object
	 */
	return (methodDefinition: { path: string }, call: ServerInterceptingCall) => {
		const { path } = methodDefinition;

		const accessKeyId = readRequestedAccessKeyId(call);

		logger.verbose("intercepting api call to path", { accessKeyId, path });

		if (publicPath.includes(methodDefinition.path)) {
			logger.verbose("passing auth control to edge function", { path });
			return call;
		}

		const token = getTokenFromCall(call);

		logger.verbose("validating token", { accessKeyId, path });

		if (!isValidToken(token, identityPublicKey)) {
			return unauthenticatedError(call);
		}

		const decodedToken = decodeToken<TokenUseEnum.ACCESS>(token) as {
			access: Access[];
			accessKeyId: string;
		};

		logger.verbose("checking access for accessKeyId", {
			accessKeyId,
			path,
			hasAccess: hasAccess(decodedToken, path),
			pathIsWorkspacePath: workspaceResourceAccess.includes(path),
			tokenHasAccessKeyId: tokenHasAccessKeyId(token, accessKeyId),
		});

		if (
			!hasAccess(decodedToken, path) ||
			(workspaceResourceAccess.includes(path) && !tokenHasAccessKeyId(token, accessKeyId)) ||
			(workspaceResourceOwnerOrAdminAccess.includes(path) &&
				!tokenHasAccessKeyId(token, accessKeyId))
		) {
			return permissionDeniedError(call);
		}

		return call;
	};
}

export { createAuthInterceptor };
