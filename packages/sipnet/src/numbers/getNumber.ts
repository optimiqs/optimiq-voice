import {
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, NumbersApi } from "@optimiq-voice/types";
import { convertToOptimiqVoiceNumber } from "./convertToOptimiqVoiceNumber";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function getNumber(api: NumbersApi) {
	const fn = async (
		call: { request: BaseApiObject },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { ref } = request;

		logger.verbose("call to getNumber", { ref });

		const response = await api.getNumber(ref);

		callback(null, convertToOptimiqVoiceNumber(response));
	};

	return withErrorHandlingAndValidation(fn, V.emptySchema);
}

export { getNumber };
