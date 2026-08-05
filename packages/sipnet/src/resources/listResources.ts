import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { filterByAccessKeyId, paginateWithFiltering } from "./paginationUtils";

const logger = getLogger({ service: "sipnet", filePath: __filename });

type ListResourcesResponse<T> = {
	nextPageToken?: string;
	items: T[];
};

function listResources<T, R, U>(api: U, resource: string) {
	const fn = async (
		call: { request: R },
		callback: (error?: GrpcErrorMessage, response?: ListResourcesResponse<T>) => void,
	) => {
		const { request } = call;

		const res = resource === "Credentials" ? "Credential" : resource;

		logger.verbose(`call to list${res}s`, { request });

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		const requestWithPageToken = request as {
			pageToken?: string;
			pageSize?: number;
		};
		const pageSize = requestWithPageToken.pageSize || 20;

		const response = await paginateWithFiltering<T>({
			pageSize,
			pageToken: requestWithPageToken.pageToken,
			fetchPage: async (pageToken, fetchPageSize) => {
				const normalizedRequest = {
					...request,
					pageToken,
					pageSize: fetchPageSize,
				};
				return await api[`list${res}s`](normalizedRequest);
			},
			filterItems: (items) => filterByAccessKeyId(items, accessKeyId),
		});

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.listRequestSchema);
}

export { listResources };
