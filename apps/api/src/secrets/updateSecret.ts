import { ServerInterceptingCall } from "@grpc/grpc-js";
import { getAccessKeyIdFromCall, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { UpdateSecretRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { withErrorHandlingAndValidationAndAccess } from "../utils/withErrorHandlingAndValidationAndAccess";
import { createGetFnUtil } from "./createGetFnUtil";

const logger = getLogger({ service: "api", filePath: __filename });

function updateSecret(db: Database) {
	const getFn = createGetFnUtil(db);

	const fn = async (call: { request: UpdateSecretRequest }) => {
		const { name, secret } = call.request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to updateSecret", {
			accessKeyId,
		});

		await db.secret.update({
			where: { ref: call.request.ref },
			data: {
				name,
				secret,
			},
		});

		return { ref: call.request.ref };
	};

	return withErrorHandlingAndValidationAndAccess(
		fn,
		(ref: string) => getFn(ref),
		V.listRequestSchema,
	);
}

export { updateSecret };
