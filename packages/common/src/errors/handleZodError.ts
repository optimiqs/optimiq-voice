import { status } from "@grpc/grpc-js";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { getLogger } from "@optimiq-voice/logger";
import { GrpcErrorMessage } from "../errors";

const logger = getLogger({ service: "api", filePath: __filename });

function handleZodError(error: z.ZodError, callback: (error: GrpcErrorMessage) => void) {
	if (error?.issues[0].code === "custom") {
		const message = error?.issues[0].message;
		logger.error("custom validation error", { message });
		callback({ code: status.INVALID_ARGUMENT, message });
	} else {
		const validationError = fromError(error, {
			prefix: null,
		});
		logger.error("Error:", { message: validationError.toString() });
		callback({
			code: status.INVALID_ARGUMENT,
			message: validationError.toString(),
		});
	}
}

export { handleZodError };
