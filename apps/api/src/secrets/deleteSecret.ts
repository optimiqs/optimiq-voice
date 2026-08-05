import { Validators as V } from "@optimiq-voice/common";
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

		logger.verbose("call to deleteSecret", { ref });

		await db.secret.delete({ where: { ref } });

		return { ref };
	};

	return withErrorHandlingAndValidationAndAccess(fn, (ref: string) => getFn(ref), V.emptySchema);
}

export { deleteSecret };
