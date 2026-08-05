import { status as GRPCStatus, ServerInterceptingCall } from "@grpc/grpc-js";
import {
	getTenantAccessKeyFromCall,
	getTokenFromCall,
	GrpcErrorMessage,
	Validators as V,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
	RemoveUserFromWorkspaceRequest,
	RemoveUserFromWorkspaceResponse,
} from "@optimiq-voice/types";
import { Database } from "../db";
import { getUserRefFromToken } from "../utils/getUserRefFromToken";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { createIsAdminMember } from "./createIsAdminMember";

const logger = getLogger({ service: "identity", filePath: __filename });

function createRemoveUserFromWorkspace(db: Database) {
	const removeUserFromWorkspace = async (
		call: { request: RemoveUserFromWorkspaceRequest },
		callback: (error?: GrpcErrorMessage, response?: RemoveUserFromWorkspaceResponse) => void,
	) => {
		const { request } = call;
		const { userRef } = request;

		const token = getTokenFromCall(call as unknown as ServerInterceptingCall);
		const accessKeyId = getTenantAccessKeyFromCall(call);
		const adminRef = getUserRefFromToken(token);
		const workspace = await db.workspace.findUnique({
			where: {
				accessKeyId,
			},
		});

		const { ref: workspaceRef } = workspace;

		logger.verbose("removing user from workspace", { workspaceRef, userRef });

		const isAdmin = await createIsAdminMember(db)(workspaceRef, adminRef);

		if (!isAdmin && adminRef !== userRef) {
			return callback({
				code: GRPCStatus.PERMISSION_DENIED,
				message: "Only admins or owners can remove users from a workspace",
			});
		}

		const memberRef = await db.workspaceMember.findFirst({
			where: {
				workspaceRef,
				userRef,
			},
		});

		if (!memberRef) {
			return callback({
				code: GRPCStatus.NOT_FOUND,
				message: "User not found in workspace",
			});
		}

		const response = await db.workspaceMember.delete({
			where: {
				ref: memberRef?.ref,
			},
		});

		callback(null, response);
	};

	return withErrorHandlingAndValidation(
		removeUserFromWorkspace,
		V.removeUserFromWorkspaceRequestSchema,
	);
}

export { createRemoveUserFromWorkspace };
