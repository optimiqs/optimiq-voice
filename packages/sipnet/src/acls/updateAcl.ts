import {
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AclsApi, BaseApiObject, UpdateAclRequest } from "@optimiq-voice/types";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function updateAcl(api: AclsApi) {
	const fn = async (
		call: { request: UpdateAclRequest },
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;

		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to updateAcl", { ...request, organizationId });

		const response = await api.updateAcl({ ...request, deny: ["0.0.0.0/0"] });

		callback(null, response);
	};

	return withErrorHandlingAndValidation(fn, V.updateAclRequestSchema);
}

export { updateAcl };
