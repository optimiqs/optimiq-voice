import { struct } from "pb-util";
import { v4 as uuidv4 } from "uuid";
import {
	getOrganizationIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateCallRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { notFoundError } from "../core/notFoundError";
import { CallPublisher } from "./types";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createCall(db: Database, publisher: CallPublisher) {
	const fn = async (
		call: {
			request: CreateCallRequest;
		},
		callback: (error?: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { from, to, appRef, timeout, metadata } = request;
		const ref = uuidv4();
		const effectiveMetadata = metadata ? struct.decode(metadata) : {};

		logger.verbose("call to createCall", { ...request, ref });

		const organizationId = getOrganizationIdFromCall(call);

		const app = await db.forOrganization(organizationId).application.findUnique({
			where: { ref: appRef },
		});

		if (!app) {
			throw notFoundError(`Application with ref ${appRef} not found`);
		}

		publisher.publishCall({
			ref,
			from,
			to,
			appRef,
			// The wire field keeps its name during coexistence; the VALUE is the organization id,
			// matching what the per-call token has carried since Step 4. Renamed in Step 9.
			accessKeyId: organizationId,
			timeout: timeout || 30,
			metadata: effectiveMetadata,
		});

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(fn, V.createCallRequestSchema);
}

export { createCall };
