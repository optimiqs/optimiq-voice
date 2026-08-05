import { ServerInterceptingCall, status } from "@grpc/grpc-js";
import { createInterceptingCall, findOrganizationIdInCall } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AuthzClient } from "./client/AuthzClient";
import { CheckMethodAuthorizedRequest } from "./types";

const logger = getLogger({ service: "authz", filePath: __filename });

/**
 * This function is a gRPC interceptor that checks if the request a method is authorized
 * to be called by the user.
 *
 * @param {string} authzServer - The public key to validate the token
 * @return {Function} - The gRPC interceptor
 */
function createCheckMethodAuthorized(authzServer: string, methods: string[]) {
	logger.verbose("creating check method authorized interceptor", {
		authzServer,
		methods,
	});
	const authz = new AuthzClient(authzServer);

	/**
	 * Inner function that will be called by the gRPC server.
	 *
	 * @param {object} methodDefinition - The method definition
	 * @param {string} methodDefinition.path - The path of the gRPC method
	 * @param {ServerInterceptingCall} call - The call object
	 * @return {ServerInterceptingCall} - The modified call object
	 */
	return function checkMethodAuthorized(
		methodDefinition: { path: string },
		call: ServerInterceptingCall,
	) {
		const { path: method } = methodDefinition;

		if (!methods.includes(method)) {
			// Ignore the check if the method is not in the list
			logger.silly("method is not in the list", { method });
			return call;
		}

		return new ServerInterceptingCall(call, {
			start: async (next) => {
				// Read lazily, not in the interceptor body: the tenancy interceptor resolves the
				// organization asynchronously and stamps it on the shared `Metadata` instance, so a
				// read taken while the interceptor chain is still being built would see nothing.
				// `runServices` therefore installs this one AFTER the tenancy interceptor.
				const organizationId = findOrganizationIdInCall(call);

				logger.verbose("checking if method is authorized", { method, organizationId });

				if (!organizationId) {
					logger.verbose("refusing an unscoped call", { method });
					createInterceptingCall({
						call,
						code: status.PERMISSION_DENIED,
						details: `Method unauthorized`,
					});
					return;
				}

				try {
					const authorized = await authz.checkMethodAuthorized({
						// The wire field keeps its name during coexistence; the VALUE is the
						// organization id now, matching every other tenant claim since Step 4.
						accessKeyId: organizationId,
						method,
					} as CheckMethodAuthorizedRequest);

					logger.verbose("the status of the method authorization", {
						method,
						organizationId,
						authorized,
					});

					if (!authorized) {
						logger.verbose("method unauthorized by external service", {
							method,
							organizationId,
						});
						createInterceptingCall({
							call,
							code: status.PERMISSION_DENIED,
							details: `Method unauthorized`,
						});
						return;
					}

					next();
				} catch (error) {
					logger.error("error checking if method is authorized", {
						method,
						organizationId,
						error,
					});

					createInterceptingCall({
						call,
						code: status.INTERNAL,
						details: "Internal server error",
					});
				}
			},
		});
	};
}

export { createCheckMethodAuthorized };
