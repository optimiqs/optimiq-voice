import { AccessToken, TokenUseEnum } from "@optimiq-voice/common";
import { Role, WorkspaceMemberStatus } from "@optimiq-voice/types";
import { Database } from "../../../db";
import { IdentityConfig } from "../../types";

function createGetAccessTokenPayload(db: Database, identityConfig: IdentityConfig) {
	return async function createGetAccessTokenPayload(accessKeyId: string): Promise<AccessToken> {
		const user = await db.user.findFirst({
			where: {
				accessKeyId,
			},
			include: {
				ownedWorkspaces: true,
				memberships: {
					include: {
						workspace: true,
					},
				},
			},
		});

		if (!user) {
			return null;
		}

		const { issuer, audience } = identityConfig;
		const { ref, ownedWorkspaces, memberships } = user;

		const access = ownedWorkspaces.map((workspace) => ({
			accessKeyId: workspace.accessKeyId,
			role: Role.WORKSPACE_OWNER,
		}));

		memberships.forEach((membership) => {
			if (membership.status === WorkspaceMemberStatus.ACTIVE) {
				access.push({
					accessKeyId: membership.workspace.accessKeyId,
					role: membership.role as Role,
				});
			}
		});

		return {
			iss: issuer,
			sub: ref,
			aud: audience,
			tokenUse: TokenUseEnum.ACCESS,
			accessKeyId,
			access,
		} as AccessToken;
	};
}

export { createGetAccessTokenPayload };
