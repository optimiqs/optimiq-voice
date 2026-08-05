import { z } from "zod";
import { withErrorHandlingAndValidation } from "@optimiq-voice/common";
import { withAccess } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function updateResource<T, R, U>(api: U, resource: string, schema: z.ZodSchema) {
	const fn = async (call: { request: R }): Promise<T> => {
		const { request } = call;

		logger.verbose(`call to update${resource}`, { ...request });

		return await api[`update${resource}`](request);
	};

	return withErrorHandlingAndValidation(
		withAccess(fn, (ref: string) => api[`get${resource}`](ref)),
		schema,
	);
}

export { updateResource };
