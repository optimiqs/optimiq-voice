import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateUserRequest } from "@optimiq-voice/types";
import { Database } from "../db";
import { AccessKeyIdType, generateAccessKeyId } from "../utils/generateAccessKeyId";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createCreateUser(db: Database) {
	const createUser = async (
		call: { request: CreateUserRequest },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { name, email, password, avatar, phone } = request;

		logger.verbose("call to createUser", { email });

		const user = await db.user.create({
			data: {
				name,
				email,
				accessKeyId: generateAccessKeyId(AccessKeyIdType.USER),
				password,
				avatar,
				phoneNumber: phone || undefined,
			},
		});

		const { ref } = user;

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(createUser, V.createUserRequestSchema);
}

export { createCreateUser };
