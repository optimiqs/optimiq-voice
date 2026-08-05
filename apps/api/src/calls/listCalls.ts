import {
	findTenantAccessKeyInCall,
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	InfluxDBClient,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ListCallsRequest, ListCallsResponse } from "@optimiq-voice/types";
import { createFetchCalls } from "./createFetchCalls";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function listCalls(influx: InfluxDBClient) {
	const fetchCalls = createFetchCalls(influx);

	const fn = async (
		call: {
			request: ListCallsRequest;
		},
		callback: (error?: GrpcErrorMessage, response?: ListCallsResponse) => void,
	) => {
		const { request } = call;

		const organizationId = getOrganizationIdFromCall(call);

		const legacyAccessKeyId = findTenantAccessKeyInCall(call);

		logger.verbose("call to listCalls", { request, organizationId });

		const result = await fetchCalls([organizationId, legacyAccessKeyId], request);

		callback(null, result);
	};

	return withErrorHandlingAndValidation(fn, V.listCallsRequestSchema);
}

export { listCalls };
