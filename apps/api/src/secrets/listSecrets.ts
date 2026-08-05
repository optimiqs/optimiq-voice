import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	datesMapper,
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import {} from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";
import { ListSecretsRequest, ListSecretsResponse } from "@optimiq-voice/types";
import { Database } from "../core/db";

const logger = getLogger({ service: "api", filePath: __filename });

function listSecrets(db: Database) {
	const fn = async (
		call: {
			request: ListSecretsRequest;
		},
		callback: (error: GrpcErrorMessage, response?: ListSecretsResponse) => void,
	) => {
		const { pageSize, pageToken } = call.request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to getSecret", {
			accessKeyId,
			pageSize,
			pageToken,
		});

		const result = (
			await db.secret.findMany({
				where: { accessKeyId },
				take: pageSize,
				skip: pageToken ? 1 : 0,
				cursor: pageToken ? { ref: pageToken } : undefined,
			})
		).map(datesMapper);

		callback(null, {
			items: result,
			nextPageToken: result.length < pageSize ? "" : result[result.length - 1]?.ref,
		});
	};

	return withErrorHandlingAndValidation(fn, V.listRequestSchema);
}

export { listSecrets };
