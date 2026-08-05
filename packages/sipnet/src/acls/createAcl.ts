import {
	getOrganizationIdFromCall,
	getTenantAccessKeyFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AclsApi, BaseApiObject, CreateAclRequest } from "@optimiq-voice/types";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function createAcl(api: AclsApi) {
	const fn = async (
		call: { request: CreateAclRequest },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;

		const organizationId = getOrganizationIdFromCall(call);

		// Routr owns this row; see the note in `numbers/createNumber.ts`.
		const accessKeyId = getTenantAccessKeyFromCall(call);

		logger.verbose("call to createAcl", { ...request, organizationId });

		const response = await api.createAcl({
			...request,
			deny: ["0.0.0.0/0"],
			extended: { accessKeyId },
		});

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.createAclRequestSchema);
}

export { createAcl };
