import { ServerInterceptingCall } from "@grpc/grpc-js";
import { struct } from "pb-util";
import { v4 as uuidv4 } from "uuid";
import {
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	Validators as V,
	withErrorHandlingAndValidation,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { BaseApiObject, CreateCallRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { notFoundError } from "../core/notFoundError";
import { CallPublisher } from "./types";

const logger = getLogger({ service: "api", filePath: __filename });

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

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		const app = await db.application.findUnique({
			where: { ref: appRef, accessKeyId },
		});

		if (!app) {
			throw notFoundError(`Application with ref ${appRef} not found`);
		}

		publisher.publishCall({
			ref,
			from,
			to,
			appRef,
			accessKeyId,
			timeout: timeout || 30,
			metadata: effectiveMetadata,
		});

		callback(null, { ref });
	};

	return withErrorHandlingAndValidation(fn, V.createCallRequestSchema);
}

export { createCall };
