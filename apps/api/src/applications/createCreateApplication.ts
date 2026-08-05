import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
	getAccessKeyIdFromCall,
	GrpcErrorMessage,
	withErrorHandling,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ApplicationType, BaseApiObject, CreateApplicationRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { convertToApplicationData } from "./utils/convertToApplicationData";
import { validOrThrow } from "./validation/validOrThrow";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createCreateApplication(db: Database) {
	const createApplication = async (
		call: { request: CreateApplicationRequest },
		callback: (error: GrpcErrorMessage, response?: BaseApiObject) => void,
	) => {
		const { request } = call;
		const { type } = request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		logger.verbose("call to createApplication", {
			accessKeyId,
			type,
		});

		if (type === ApplicationType.AUTOPILOT && !request.endpoint) {
			logger.verbose("setting default endpoint for autopilot application", {
				autopilotEndpoint: AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
			});
			request.endpoint = AUTOPILOT_SPECIAL_LOCAL_ADDRESS;
		}

		validOrThrow(request);

		const result = await db.application.create({
			data: {
				...convertToApplicationData(request),
				accessKeyId,
			},
		});

		callback(null, { ref: result.ref });
	};

	return withErrorHandling(createApplication);
}

export { createCreateApplication };
