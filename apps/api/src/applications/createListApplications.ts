import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ListApplicationsRequest, ListApplicationsResponse } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { applicationWithEncodedStruct } from "./utils/applicationWithEncodedStruct";

const logger = getLogger({ service: "api", filePath: __filename });

function createListApplications(db: Database) {
	const listApplications = async (
		call: {
			request: ListApplicationsRequest;
		},
		callback: (error: GrpcErrorMessage, response?: ListApplicationsResponse) => void,
	) => {
		const { pageSize, pageToken } = call.request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to getApplication", {
			accessKeyId,
			pageSize,
			pageToken,
		});

		const result = await db.application.findMany({
			where: { accessKeyId },
			include: {
				textToSpeech: true,
				speechToText: true,
				intelligence: true,
			},
			take: pageSize,
			skip: pageToken ? 1 : 0,
			cursor: pageToken ? { ref: pageToken } : undefined,
		});

		const items = result.map(applicationWithEncodedStruct);

		callback(null, {
			items,
			nextPageToken: items.length < pageSize ? "" : result[result.length - 1]?.ref,
		});
	};

	return withErrorHandlingAndValidation(listApplications, V.listRequestSchema);
}

export { createListApplications };
