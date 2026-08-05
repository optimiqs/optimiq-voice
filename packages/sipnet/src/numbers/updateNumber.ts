import {
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	NumberPreconditionsCheck,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, NumbersApi, UpdateNumberRequest } from "@optimiq-voice/types";
import { convertToRoutrNumberUpdate } from "./convertToRoutrNumber";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function updateNumber(api: NumbersApi, checkNumberPreconditions: NumberPreconditionsCheck) {
	const fn = async (
		call: { request: UpdateNumberRequest },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;

		// Validates that the appRef or agentAor exists in the system, within this tenant
		await checkNumberPreconditions(request, getOrganizationIdFromCall(call));

		logger.verbose("call to updateNumber", { ...request });

		const response = await api.updateNumber(convertToRoutrNumberUpdate(request));

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.updateNumberRequestSchema);
}

export { updateNumber };
