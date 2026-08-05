import { z } from "zod";
import { fromError } from "zod-validation-error";
import { VerbRequest } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

type VerbHandler = (request: VerbRequest) => Promise<void>;

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function withErrorHandling(fn: VerbHandler) {
	return async (request: VerbRequest) => {
		try {
			return await fn(request);
		} catch (err) {
			if (err instanceof z.ZodError) {
				const validationError = fromError(err, {
					prefix: null,
				});
				logger.error("Error:", {
					message: validationError.toString(),
				});
			} else if (
				err.message !== "Channel not found" &&
				!err.message?.includes("Channel not found")
			) {
				throw err;
			}
		}
	};
}

export { withErrorHandling };
