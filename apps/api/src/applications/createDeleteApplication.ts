import { getOrganizationIdFromCall, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { withErrorHandlingAndValidationAndAccess } from "../utils/withErrorHandlingAndValidationAndAccess";
import { createGetFnUtil } from "./createGetFnUtil";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createDeleteApplication(db: Database) {
	const getFn = createGetFnUtil(db);

	const deleteApplication = async (call: { request: BaseApiObject }): Promise<BaseApiObject> => {
		const { ref } = call.request;
		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to deleteApplication", { organizationId, ref });

		// Ownership check: outside this tenant's scope the row does not exist.
		await getFn(organizationId, ref);
		await db.forOrganization(organizationId).application.delete({ where: { ref } });

		return { ref };
	};

	return withErrorHandlingAndValidationAndAccess(deleteApplication, V.emptySchema);
}

export { createDeleteApplication };
