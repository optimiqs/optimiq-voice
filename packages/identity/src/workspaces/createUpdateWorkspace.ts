import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";
import { getTokenFromCall, GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, UpdateWorkspaceRequest } from "@optimiq-voice/types";
import { Database } from "../db";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { createIsWorkspaceMember } from "./createIsWorkspaceMember";

const logger = getLogger({ service: "identity", filePath: __filename });

function createUpdateWorkspace(db: Database) {
	const updateWorkspace = async (
		call: { request: UpdateWorkspaceRequest },
		callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
		const userRef = getUserRefFromToken(token);

		const { request } = call;
		const { ref, name } = request;

		logger.verbose("call to updateWorkspace", { ref, userRef });

		const isMember = await createIsWorkspaceMember(db)(ref, userRef);

		if (!isMember) {
			callback({
				code: GRPCStatus.PERMISSION_DENIED,
				message: "User is not a member of the workspace",
			});
		}

		await db.workspace.update({
			where: {
				ref,
			},
			data: {
				name,
			},
		});

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(updateWorkspace, V.updateWorkspaceRequestSchema);
}

export { createUpdateWorkspace };
