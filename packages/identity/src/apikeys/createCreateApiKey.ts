import { ServerInterceptingCall } from "@grpc/grpc-js";
import { getAccessKeyIdFromCall, GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CreateApiKeyRequest, CreateApiKeyResponse } from "@optimiq-voice/types";
import { Database } from "../db";
import { AccessKeyIdType, generateAccessKeyId } from "../utils/generateAccessKeyId";
import { generateAccessKeySecret } from "../utils/generateAccessKeySecret";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createCreateApiKey(db: Database) {
	const createApiKey = async (
		call: { request: CreateApiKeyRequest },
		callback: (error: GrpcErrorMessage, response?: CreateApiKeyResponse) => void,
	) => {
		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		const { request } = call;
		const { role, expiresAt } = request;

		logger.info("creating new ApiKey", { accessKeyId, role, expiresAt });

		const workspace = await db.workspace.findUnique({
			where: { accessKeyId },
		});

		const { ref } = workspace;

		const response = await db.apiKey.create({
			data: {
				workspaceRef: ref,
				role,
				accessKeyId: generateAccessKeyId(AccessKeyIdType.API_KEY),
				accessKeySecret: generateAccessKeySecret(),
				expiresAt: expiresAt ? new Date(expiresAt) : null,
			},
		});

		callback(null, {
			ref: response.ref,
			accessKeyId: response.accessKeyId,
			accessKeySecret: response.accessKeySecret,
		});
	};

	return withErrorHandlingAndValidation(createApiKey, V.createApiKeyRequestSchema);
}

export { CreateApiKeyRequest, CreateApiKeyResponse, createCreateApiKey };
