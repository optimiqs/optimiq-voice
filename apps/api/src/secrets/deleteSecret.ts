import { getOrganizationIdFromCall, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { withErrorHandlingAndValidationAndAccess } from "../utils/withErrorHandlingAndValidationAndAccess";
import { createGetFnUtil } from "./createGetFnUtil";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function deleteSecret(db: Database) {
	const getFn = createGetFnUtil(db);

	const fn = async (call: { request: BaseApiObject }): Promise<BaseApiObject> => {
		const { ref } = call.request;
		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to deleteSecret", { organizationId, ref });

		// The read is what enforces ownership: outside the tenant's scope the row does not exist,
		// so this raises NOT_FOUND before the delete rather than deleting someone else's secret.
		await getFn(organizationId, ref);
		await db.forOrganization(organizationId).secret.delete({ where: { ref } });

		return { ref };
	};

	return withErrorHandlingAndValidationAndAccess(fn, V.emptySchema);
}

export { deleteSecret };
