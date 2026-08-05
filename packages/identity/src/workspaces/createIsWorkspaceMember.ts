import { WorkspaceMemberStatus } from "@optimiq-voice/types";
import { Database } from "../db";

function createIsWorkspaceMember(db: Database) {
	return async function isWorkspaceMember(workspaceRef: string, userRef: string) {
		const workspace = await db.workspace.findUnique({
			where: {
				ref: workspaceRef,
			},
		});

		const isMember = await db.workspaceMember.findFirst({
			where: {
				// Force userId to be an empty string to ensure that the query is not
				// filter by workspaceRef only
				userRef: userRef || "",
				workspaceRef,
				status: WorkspaceMemberStatus.ACTIVE,
			},
		});

		const isOwner = workspace?.ownerRef === userRef;

		return !!(isMember || isOwner);
	};
}

export { createIsWorkspaceMember };
