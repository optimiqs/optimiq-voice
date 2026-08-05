import { jwtDecode } from "jwt-decode";
import { isValidToken } from "@optimiq-voice/common";
import { WorkspaceMemberStatus } from "@optimiq-voice/types";
import { createDatabaseClient } from "../db";
import { IdentityConfig } from "../exchanges";

function createUpdateMembershipStatus(identityConfig: IdentityConfig) {
	return async function pdateMembershipStatus(token: string): Promise<void> {
		if (!isValidToken(token, identityConfig.privateKey)) {
			throw new Error("Invalid token");
		}

		const { memberRef } = jwtDecode(token) as { memberRef: string };

		const db = createDatabaseClient(identityConfig.dbUrl, identityConfig.encryptionKey);

		try {
			await db.workspaceMember.update({
				where: {
					ref: memberRef,
				},
				data: {
					status: WorkspaceMemberStatus.ACTIVE,
					updatedAt: new Date(),
				},
			});
		} finally {
			await db.close();
		}
	};
}

export { createUpdateMembershipStatus };
