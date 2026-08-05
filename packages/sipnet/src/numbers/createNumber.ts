import {
	getOrganizationIdFromCall,
	getTenantAccessKeyFromCall,
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

		const organizationId = getOrganizationIdFromCall(call);

		// Validates that the appRef or agentAor exists in the system, within this tenant
		await checkNumberPreconditions(request, organizationId);

		// Routr owns these rows and this migration does not rewrite them (Step 6 recommendation
		// (b) — the SIP edge dies with Routr in Phase 6), so `extended.accessKeyId` keeps the
		// server-resolved legacy key. It falls back to the organization id for a post-cutover
		// tenant, so old and new rows stay comparable.
		const accessKeyId = getTenantAccessKeyFromCall(call);

		logger.verbose("call to createNumber", { ...request, organizationId });

		const response = await api.createNumber(convertToRoutrNumber(request, accessKeyId));

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.createNumberRequestSchema);
}

export { createNumber };
