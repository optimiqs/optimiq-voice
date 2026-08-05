import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import {
	INumber,
	INumberExtended,
	ListNumbersRequest,
	ListNumbersResponse,
	NumbersApi,
} from "@optimiq-voice/types";
import { filterByAccessKeyId, paginateWithFiltering } from "../resources/paginationUtils";
import { convertToOptimiqVoiceNumber } from "./convertToOptimiqVoiceNumber";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function listNumbers(api: NumbersApi) {
	const fn = async (
		call: { request: ListNumbersRequest },
		callback: (error?: GrpcErrorMessage, response?: ListNumbersResponse) => void,
	) => {
		const { request } = call;

		logger.verbose("call to listNumbers", { ...request });

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		const requestWithPageToken = request as {
			pageToken?: string;
			pageSize?: number;
		};
		const pageSize = requestWithPageToken.pageSize || 20;

		const response = await paginateWithFiltering<INumberExtended, INumber>({
			pageSize,
			pageToken: requestWithPageToken.pageToken,
			fetchPage: async (pageToken, fetchPageSize) => {
				const normalizedRequest = {
					...request,
					pageToken,
					pageSize: fetchPageSize,
				};
				return await api.listNumbers(normalizedRequest);
			},
			filterItems: (items: INumberExtended[]): INumber[] => {
				// Filter by accessKeyId and convert to Optimiq Voice number format
				return filterByAccessKeyId(items, accessKeyId).map(convertToOptimiqVoiceNumber);
			},
		});

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.listRequestSchema);
}

export { listNumbers };
