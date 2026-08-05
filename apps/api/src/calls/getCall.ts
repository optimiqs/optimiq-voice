import {
	findTenantAccessKeyInCall,
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	InfluxDBClient,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { CallDetailRecord } from "@optimiq-voice/types";
import { notFoundError } from "../core/notFoundError";
import { createFetchSingleCall } from "./createFetchSingleCall";
import { GetCallRequest } from "./types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function getCall(influx: InfluxDBClient) {
	const fetchSingleCall = createFetchSingleCall(influx);

	const fn = async (
		call: {
			request: GetCallRequest;
		},
		callback: (error?: GrpcErrorMessage, response?: CallDetailRecord) => void,
	) => {
		const { ref } = call.request;

		const organizationId = getOrganizationIdFromCall(call);

		const legacyAccessKeyId = findTenantAccessKeyInCall(call);

		logger.verbose("call to getCall", { organizationId, ref });

		const response = await fetchSingleCall([organizationId, legacyAccessKeyId], ref);

		if (!response) {
			throw notFoundError(`Call not found: ${ref}`);
		}

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.getCallRequestSchema);
}

export { getCall };
