import { ServerInterceptingCall } from "@grpc/grpc-js";
import { getTokenFromCall, GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateWorkspaceRequest } from "@optimiq-voice/types";
import { Database } from "../db";
import { AccessKeyIdType, generateAccessKeyId } from "../utils/generateAccessKeyId";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createCreateWorkspace(db: Database) {
	const createWorkspace = async (
		call: { request: CreateWorkspaceRequest },
		callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { name } = request;

		const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
		const ownerRef = getUserRefFromToken(token);
		const accessKeyId = generateAccessKeyId(AccessKeyIdType.WORKSPACE);

		logger.verbose("call to createWorkspace", { name, ownerRef });

		const workspace = await db.workspace.create({
			data: {
				name,
				accessKeyId,
				ownerRef,
			},
		});

		const { ref } = workspace;

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(createWorkspace, V.createWorkspaceRequestSchema);
}

export { createCreateWorkspace };
