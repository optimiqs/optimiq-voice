import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	NumberPreconditionsCheck,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateNumberRequest, NumbersApi } from "@optimiq-voice/types";
import { convertToRoutrNumber } from "./convertToRoutrNumber";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function createNumber(api: NumbersApi, checkNumberPreconditions: NumberPreconditionsCheck) {
	const fn = async (
		call: { request: CreateNumberRequest },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;

		// Validates that the appRef or agentAor exists in the system
		await checkNumberPreconditions(request);

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to createNumber", { ...request, accessKeyId });

		const response = await api.createNumber(convertToRoutrNumber(request, accessKeyId));

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.createNumberRequestSchema);
}

export { createNumber };
