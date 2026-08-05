import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, RegenerateApiKeyResponse } from "@optimiq-voice/types";
import { Database } from "../db";
import { generateAccessKeySecret } from "../utils/generateAccessKeySecret";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createRegenerateApiKey(db: Database) {
	const regenerateApiKey = async (
		call: { request: BaseApiObject },
		callback: (error: GrpcErrorMessage, response?: RegenerateApiKeyResponse) => void,
	) => {
		const { request } = call;
		const { ref } = request;

		logger.info("regenerating ApiKey", { ref });

		const response = await db.apiKey.update({
			where: {
				ref,
			},
			data: {
				accessKeySecret: generateAccessKeySecret(),
			},
		});

		callback(null, {
			ref: response.ref,
			accessKeyId: response.accessKeyId,
			accessKeySecret: response.accessKeySecret,
		});
	};

	return withErrorHandlingAndValidation(regenerateApiKey, V.emptySchema);
}

export { createRegenerateApiKey };
