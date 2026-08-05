import jwt from "jsonwebtoken";
import { TokenUseEnum, VOICE_SERVICE_ROLE } from "@optimiq-voice/common";
import { SIGN_ALGORITHM } from "../constants";
import { IdentityConfig } from "../exchanges/types";

function createGenerateCallAccessToken(identityConfig: IdentityConfig) {
	return async function generateCallAccessToken(params: {
		accessKeyId: string;
		appRef: string;
	}): Promise<string> {
		const { privateKey } = identityConfig;

		const accessTokenSignOptions = {
			algorithm: SIGN_ALGORITHM,
			// Just enough time to validate a request
			expiresIn: "30s",
		} as jwt.SignOptions;

		const { issuer, audience } = identityConfig;
		const { accessKeyId, appRef } = params;

		const access = [
			{
				accessKeyId,
				role: VOICE_SERVICE_ROLE,
			},
		];

		const unsignedToken = {
			iss: issuer,
			sub: appRef,
			aud: audience,
			tokenUse: TokenUseEnum.ACCESS,
			accessKeyId,
			access,
		};

		return jwt.sign(unsignedToken, privateKey, accessTokenSignOptions);
	};
}

export { createGenerateCallAccessToken };
