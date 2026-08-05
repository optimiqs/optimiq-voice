import { ServerInterceptingCall } from "@grpc/grpc-js";
import { getTokenFromCall, GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, UpdateUserRequest } from "@optimiq-voice/types";
import { Database } from "../db";
import { getAccessKeyIdFromToken } from "../utils";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { UserUpdateInput } from "./types";

const logger = getLogger({ service: "identity", filePath: __filename });

function createUpdateUser(db: Database) {
	const updateUser = async (
		call: { request: UpdateUserRequest },
		callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { ref, name, avatar, password, phone } = request;

		const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
		const accessKeyId = getAccessKeyIdFromToken(token);

		logger.verbose("call to updateUser", { ref, password });

		const updateData = {
			name,
			avatar,
			password: password || undefined,
			updatedAt: new Date(),
		} as UserUpdateInput;

		if (phone && phone !== "") {
			updateData.phoneNumber = phone;
			updateData.phoneNumberVerified = false;
		}

		await db.user.update({
			where: {
				ref,
				accessKeyId,
			},
			data: updateData,
		});

		const response: BaseApiObject = {
			ref,
		};

		callback(null, response);
	};

	return withErrorHandlingAndValidation(updateUser, V.updateUserRequestSchema);
}

export { createUpdateUser };
