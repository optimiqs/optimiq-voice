import * as grpc from "@grpc/grpc-js";
import { ServerInterceptingCall } from "@grpc/grpc-js";
import { GrpcErrorMessage } from "@optimiq-voice/common";
import { JsonObject } from "../db/schema";
import { hasAccessToResource } from "./hasAccessToResource";

function withAccess<T, A>(
	handler: (call: T) => Promise<A>,
	getFn: (ref: string) => Promise<{ extended?: JsonObject }>,
) {
	return async (call: T, callback: (error?: GrpcErrorMessage, response?: A) => void) => {
		const typedCall = call as unknown as ServerInterceptingCall;
		const hasAccess = await hasAccessToResource(typedCall, getFn);

		if (!hasAccess) {
			callback({
				code: grpc.status.PERMISSION_DENIED,
				message: "You don't have permission to access this resource",
			});
			return;
		}

		const response = await handler(call);

		callback(null, response);
	};
}

export { withAccess };
