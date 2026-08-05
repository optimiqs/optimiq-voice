import { getOrganizationIdFromCall, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, Secret } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { withErrorHandlingAndValidationAndAccess } from "../utils/withErrorHandlingAndValidationAndAccess";
import { createGetFnUtil } from "./createGetFnUtil";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function getSecret(db: Database) {
	const getFn = createGetFnUtil(db);

	const fn = async (call: { request: BaseApiObject }): Promise<Secret> => {
		const { ref } = call.request;
		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to getSecret", { organizationId, ref });

		return await getFn(organizationId, ref);
	};

	return withErrorHandlingAndValidationAndAccess(fn, V.emptySchema);
}

export { getSecret };
