import { IdToken, TokenUseEnum } from "@optimiq-voice/common";
import { Database } from "../../../db";
import { IdentityConfig } from "../../types";

function createGetIdTokenPayload(db: Database, identityConfig: IdentityConfig) {
	return async function getIdTokenPayload(accessKeyId: string): Promise<IdToken> {
		const user = await db.user.findFirst({
			where: {
				accessKeyId,
			},
		});

		if (!user) {
			return null;
		}

		const { issuer, audience } = identityConfig;
		const { ref, email, phoneNumber, emailVerified, phoneNumberVerified } = user;

		return {
			iss: issuer,
			sub: ref,
			aud: audience,
			tokenUse: TokenUseEnum.ID,
			accessKeyId,
			email,
			emailVerified,
			phoneNumber,
			phoneNumberVerified,
		} as IdToken;
	};
}

export { createGetIdTokenPayload };
