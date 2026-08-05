import { z } from "zod";
import {
	getOrganizationIdFromCall,
	getTenantAccessKeyFromCall,
	GrpcErrorMessage,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function createResource<T, R, U>(api: U, resource: string, schema: z.ZodSchema) {
	const fn = async (
		call: { request: R },
		callback: (error?: GrpcErrorMessage, response?: T) => void,
	) => {
		const { request } = call;

		const organizationId = getOrganizationIdFromCall(call);

		// Routr owns this row; see the note in `numbers/createNumber.ts`.
		const accessKeyId = getTenantAccessKeyFromCall(call);

		logger.verbose(`call to create${resource}`, { ...request, organizationId });

		const response = await api[`create${resource}`]({
			...request,
			extended: {
				accessKeyId,
			},
		});

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, schema);
}

export { createResource };
