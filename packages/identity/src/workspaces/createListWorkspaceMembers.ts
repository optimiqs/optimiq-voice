import {
	getTenantAccessKeyFromCall,
	GrpcErrorMessage,
	Validators as V,
} from "@optimiq-voice/common";
import { datesMapper } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
	ListWorkspaceMembersRequest,
	ListWorkspaceMembersResponse,
	Role,
	WorkspaceMemberStatus,
} from "@optimiq-voice/types";
import { Database } from "../db";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createListWorkspaceMembers(db: Database) {
	const listWorkspaceMembers = async (
		call: { request: ListWorkspaceMembersRequest },
		callback: (error?: GrpcErrorMessage, response?: ListWorkspaceMembersResponse) => void,
	) => {
		const { pageSize, pageToken } = call.request;
		const accessKeyId = getTenantAccessKeyFromCall(call);

		logger.verbose("list workspace members", { accessKeyId });

		const workspace = await db.workspace.findUnique({
			where: {
				accessKeyId,
			},
		});

		const items = await db.workspaceMember.findMany({
			where: {
				workspaceRef: workspace.ref,
			},
			include: {
				user: true,
			},
			take: pageSize,
			skip: pageToken ? 1 : 0,
			cursor: pageToken ? { ref: pageToken } : undefined,
		});

		callback(null, {
			items: items
				.map((item) => ({
					...item,
					name: item.user.name,
					email: item.user.email,
					role: item.role as Role,
					status: item.status as WorkspaceMemberStatus,
				}))
				.map(datesMapper),
			nextPageToken: items.length < pageSize ? "" : items[items.length - 1]?.ref,
		});
	};

	return withErrorHandlingAndValidation(listWorkspaceMembers, V.listRequestSchema);
}

export { createListWorkspaceMembers };
