import {
	datesMapper,
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ListSecretsRequest, ListSecretsResponse } from "@optimiq-voice/types";
import { Database } from "../core/db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function listSecrets(db: Database) {
	const fn = async (
		call: {
			request: ListSecretsRequest;
		},
		callback: (error: GrpcErrorMessage, response?: ListSecretsResponse) => void,
	) => {
		const { pageSize, pageToken } = call.request;

		const organizationId = getOrganizationIdFromCall(call);

		logger.verbose("call to listSecrets", {
			organizationId,
			pageSize,
			pageToken,
		});

		const result = (
			await db.forOrganization(organizationId).secret.findMany({
				where: { organizationId },
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
