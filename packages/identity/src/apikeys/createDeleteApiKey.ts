import { GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../db";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createDeleteApiKey(db: Database) {
	const deleteApiKey = async (
		call: { request: BaseApiObject },
		callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { ref } = request;

		logger.info("deleting ApiKey", { ref });

		await db.apiKey.delete({
			where: {
				ref,
			},
		});

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(deleteApiKey, V.emptySchema);
}

export { createDeleteApiKey };
