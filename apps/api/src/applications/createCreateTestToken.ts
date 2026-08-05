import { ServerInterceptingCall } from "@grpc/grpc-js";
import { status } from "@grpc/grpc-js";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { getAccessKeyIdFromCall, GrpcErrorMessage, withErrorHandling } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CreateTestTokenResponse } from "@optimiq-voice/types";
import { IDENTITY_PRIVATE_KEY } from "../envs";
import { TestTokenConfiguration } from "./types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createCreateTestToken(config: TestTokenConfiguration) {
	const createApplication = async (
		call: unknown,
		callback: (error: GrpcErrorMessage, response?: CreateTestTokenResponse) => void,
	) => {
		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to createTestToken", {
			accessKeyId,
		});

		// Build payload
		const payload = {
			ref: uuidv4(),
			domain: config.domain,
			displayName: config.displayName,
			signalingServer: config.signalingServer,
			targetAor: config.targetAor,
			username: config.username,
			accessKeyId,
			aorLink: config.targetAor,
			privacy: "NONE",
			allowedMethods: ["INVITE"],
		};

		// Sign JWT
		let token: string;

		try {
			token = jwt.sign(payload, IDENTITY_PRIVATE_KEY, {
				expiresIn: "1h",
				algorithm: "RS256",
			});
		} catch (err) {
			logger.error("failed to sign JWT", { error: err });
			callback({ code: status.INTERNAL, message: "Failed to sign JWT" });
			return;
		}

		const response = {
			token,
			...config,
		};

		callback(null, response);
	};

	return withErrorHandling(createApplication);
}

export { createCreateTestToken };
