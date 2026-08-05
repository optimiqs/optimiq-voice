import jwt from "jsonwebtoken";
import { exchangeRefreshTokenRequestSchema, GrpcErrorMessage } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { SIGN_ALGORITHM } from "../constants";
import { Database } from "../db";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";
import { exchangeTokens } from "./exchangeTokens";
import { ExchangeRefreshTokenRequest, ExchangeResponse, IdentityConfig } from "./types";

const logger = getLogger({ service: "identity", filePath: __filename });

function createExchangeRefreshToken(db: Database, identityConfig: IdentityConfig) {
	const exchangeRefreshToken = async (
		call: { request: ExchangeRefreshTokenRequest },
		callback: (error?: GrpcErrorMessage, response?: ExchangeResponse) => void,
	) => {
		const { privateKey } = identityConfig;
		const { request } = call;
		const { refreshToken: oldRefreshToken } = request;

		const oldRefreshTokenDecoded = jwt.verify(oldRefreshToken, privateKey, {
			algorithms: [SIGN_ALGORITHM],
		}) as { accessKeyId: string };

		const { accessKeyId } = oldRefreshTokenDecoded;

		logger.verbose("call to exchangeRefreshToken", { accessKeyId });

		callback(null, await exchangeTokens(db, identityConfig)(accessKeyId));
	};

	return withErrorHandlingAndValidation(exchangeRefreshToken, exchangeRefreshTokenRequestSchema);
}

export { createExchangeRefreshToken };
