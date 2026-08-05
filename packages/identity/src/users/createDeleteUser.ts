import { ServerInterceptingCall } from "@grpc/grpc-js";
import { getTokenFromCall, GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../db";
import { getAccessKeyIdFromToken } from "../utils";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createDeleteUser(db: Database) {
	const deleteUser = async (
		call: { request: BaseApiObject },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { ref } = request;

		const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
		const accessKeyId = getAccessKeyIdFromToken(token);

		logger.verbose("deleting user from the system", { ref, accessKeyId });

		await db.user.delete({
			where: {
				ref,
				accessKeyId,
			},
		});

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(deleteUser, V.emptySchema);
}

export { createDeleteUser };
