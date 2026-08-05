import {
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateSecretRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createSecret(db: Database) {
	const fn = async (
		call: { request: CreateSecretRequest },
		callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { name, secret } = call.request;
		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to createSecret", {
			organizationId,
		});

		const result = await db.forOrganization(organizationId).secret.create({
			data: {
				name,
				secret,
				organizationId,
			},
		});

		callback(null, { ref: result.ref });
	};

	return withErrorHandlingAndValidation(fn, V.createSecretRequestSchema);
}

export { createSecret };
