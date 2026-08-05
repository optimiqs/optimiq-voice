import { RefreshToken, TokenUseEnum } from "@optimiq-voice/common";
import { Database } from "../../../db";
import { IdentityConfig } from "../../types";

function createGetRefreshTokenPayload(db: Database, identityConfig: IdentityConfig) {
	return async function getRefreshTokenPayload(accessKeyId: string): Promise<RefreshToken> {
		const user = await db.user.findFirst({
			where: {
				accessKeyId,
			},
		});

		if (!user) {
			return null;
		}

		const { issuer, audience } = identityConfig;
		const { ref } = user;

		return {
			iss: issuer,
			sub: ref,
			aud: audience,
			tokenUse: TokenUseEnum.REFRESH,
			accessKeyId,
		} as RefreshToken;
	};
}

export { createGetRefreshTokenPayload };
