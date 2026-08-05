import {
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ListApplicationsRequest, ListApplicationsResponse } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { applicationWithEncodedStruct } from "./utils/applicationWithEncodedStruct";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createListApplications(db: Database) {
	const listApplications = async (
		call: {
			request: ListApplicationsRequest;
		},
		callback: (error: GrpcErrorMessage, response?: ListApplicationsResponse) => void,
	) => {
		const { pageSize, pageToken } = call.request;

		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to listApplications", {
			organizationId,
			pageSize,
			pageToken,
		});

		const result = await db.forOrganization(organizationId).application.findMany({
			where: { organizationId },
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
