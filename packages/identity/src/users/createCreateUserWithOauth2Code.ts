import * as grpc from "@grpc/grpc-js";
import { customAlphabet } from "nanoid";
import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CreateUserWithOauth2CodeRequest } from "@optimiq-voice/types";
import { Database } from "../db";
import { exchangeTokens } from "../exchanges/exchangeTokens";
import { ExchangeResponse, IdentityConfig } from "../exchanges/types";
import { createGetUserByEmail } from "../utils/createGetUserByEmail";
import { AccessKeyIdType, generateAccessKeyId } from "../utils/generateAccessKeyId";
import { getGitHubUserWithOauth2Code } from "../utils/getGitHubUserWithOauth2Code";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createCreateUserWithOauth2Code(db: Database, identityConfig: IdentityConfig) {
	const createUserWithOauth2Code = async (
		call: { request: CreateUserWithOauth2CodeRequest },
		callback: (error?: GrpcErrorMessage, response?: ExchangeResponse) => void,
	) => {
		const { request } = call;
		const { code } = request;

		logger.verbose("call to createCreateUserWithOauth2Code");

		const userData = await getGitHubUserWithOauth2Code({
			clientId: identityConfig.githubOauth2Config.clientId,
			clientSecret: identityConfig.githubOauth2Config.clientSecret,
			code,
		});

		if (!userData.email) {
			return callback({
				code: grpc.status.PERMISSION_DENIED,
				message:
					"Failed to get user data from GitHub. This typically happens when your GitHub account doesn't have a public email address",
			});
		}

		const userFromDB = await createGetUserByEmail(db)(userData.email);

		if (userFromDB) {
			return callback({
				code: grpc.status.ALREADY_EXISTS,
				message: "User already exists",
			});
		}

		const user = await db.user.create({
			data: {
				name: userData.name,
				email: userData.email,
				accessKeyId: generateAccessKeyId(AccessKeyIdType.USER),
				emailVerified: true,
				password: customAlphabet("1234567890abcdef", 10)(),
				avatar: userData.avatar_url,
			},
		});

		callback(null, await exchangeTokens(db, identityConfig)(user.accessKeyId));
	};

	return withErrorHandlingAndValidation(
		createUserWithOauth2Code,
		V.createUserWithOauth2CodeRequestSchema,
	);
}

export { createCreateUserWithOauth2Code };
