import { Role, WorkspaceMemberStatus } from "@optimiq-voice/types";
import { Database } from "../db";

function createIsAdminMember(db: Database) {
	return async function isAdminMember(workspaceRef: string, adminRef: string) {
		if (!workspaceRef || !adminRef) {
			return false;
		}

		const workspace = await db.workspace.findUnique({
			where: {
				ref: workspaceRef,
			},
			include: {
				members: true,
			},
		});

		if (workspace?.ownerRef === adminRef) {
			return true;
		}

		const role = workspace?.members.find(
			(member) => member.userRef === adminRef && member.status === WorkspaceMemberStatus.ACTIVE,
		)?.role;

		return role === Role.WORKSPACE_ADMIN || role === Role.WORKSPACE_OWNER;
	};
}

export { createIsAdminMember };
