import { Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Application, BaseApiObject } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { withErrorHandlingAndValidationAndAccess } from "../utils/withErrorHandlingAndValidationAndAccess";
import { createGetFnUtil } from "./createGetFnUtil";
import { applicationWithEncodedStruct } from "./utils/applicationWithEncodedStruct";

const logger = getLogger({ service: "api", filePath: __filename });

function createGetApplication(db: Database) {
	const getFn = createGetFnUtil(db);

	const getApplication = async (call: { request: BaseApiObject }): Promise<Application> => {
		const { ref } = call.request;

		logger.verbose("call to getApplication", { ref });

		const result = await getFn(ref);

		return result ? applicationWithEncodedStruct(result) : null;
	};

	return withErrorHandlingAndValidationAndAccess(
		getApplication,
		(ref: string) => getFn(ref),
		V.emptySchema,
	);
}

export { createGetApplication };
