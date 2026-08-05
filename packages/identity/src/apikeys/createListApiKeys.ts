import { ServerInterceptingCall } from "@grpc/grpc-js";
import { getAccessKeyIdFromCall, GrpcErrorMessage, Validators as V } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ListApiKeysRequest, ListApiKeysResponse, Role } from "@optimiq-voice/types";
import { Database } from "../db";
import { withErrorHandlingAndValidation } from "../utils/withDatabaseErrorHandlingAndValidation";

const logger = getLogger({ service: "identity", filePath: __filename });

function createListApiKeys(db: Database) {
	const listApiKeys = async (
		call: { request: ListApiKeysRequest },
		callback: (error: GrpcErrorMessage, response?: ListApiKeysResponse) => void,
	) => {
		const { pageSize, pageToken } = call.request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("list keys for workspace", { accessKeyId });

		const workspace = await db.workspace.findUnique({
			where: {
				accessKeyId,
			},
		});

		const keys = await db.apiKey.findMany({
			where: {
				workspaceRef: workspace.ref,
			},
			take: pageSize,
			skip: pageToken ? 1 : 0,
			cursor: pageToken ? { ref: pageToken } : undefined,
		});

		const items = keys.map((key) => ({
			...key,
			role: key.role as Role,
		}));

		const response: ListApiKeysResponse = {
			items,
			nextPageToken: items.length < pageSize ? "" : items[items.length - 1]?.ref,
		};

		callback(null, response);
	};

	return withErrorHandlingAndValidation(listApiKeys, V.listRequestSchema);
}

export { createListApiKeys };
