import { getOrganizationIdFromCall, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { UpdateSecretRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { withErrorHandlingAndValidationAndAccess } from "../utils/withErrorHandlingAndValidationAndAccess";
import { createGetFnUtil } from "./createGetFnUtil";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function updateSecret(db: Database) {
	const getFn = createGetFnUtil(db);

	const fn = async (call: { request: UpdateSecretRequest }) => {
		const { name, secret } = call.request;

		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to updateSecret", {
			organizationId,
		});

		// Ownership check: outside this tenant's scope the row does not exist.
		await getFn(organizationId, call.request.ref);
		await db.forOrganization(organizationId).secret.update({
			where: { ref: call.request.ref },
			data: {
				name,
				secret,
			},
		});

		return { ref: call.request.ref };
	};

	return withErrorHandlingAndValidationAndAccess(fn, V.listRequestSchema);
}

export { updateSecret };
