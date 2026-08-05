import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
	AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
	getAccessKeyIdFromCall,
	withErrorHandling,
} from "@optimiq-voice/common";
import { withAccess } from "@optimiq-voice/identity";
import { getLogger } from "@optimiq-voice/logger";
import { ApplicationType, UpdateApplicationRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { createGetFnUtil } from "./createGetFnUtil";
import { convertToApplicationData } from "./utils/convertToApplicationData";
import { validOrThrow } from "./validation/validOrThrow";

const logger = getLogger({ service: "api", filePath: __filename });

function createUpdateApplication(db: Database) {
	const getFn = createGetFnUtil(db);

	const updateApplication = async (call: { request: UpdateApplicationRequest }) => {
		const { request } = call;
		const { type, ref: applicationRef } = request;

		const accessKeyId = getAccessKeyIdFromCall(call as unknown as ServerInterceptingCall);

		if (type === ApplicationType.AUTOPILOT && !request.endpoint) {
			logger.verbose("setting default endpoint for autopilot application", {
				autopilotEndpoint: AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
			});
			request.endpoint = AUTOPILOT_SPECIAL_LOCAL_ADDRESS;
		}

		validOrThrow(request);

		logger.verbose("call to updateApplication", {
			accessKeyId,
			type,
		});

		await db.transaction(async (transaction) => {
			await transaction.textToSpeech.deleteMany({
				where: {
					applicationRef,
				},
			});
			await transaction.speechToText.deleteMany({
				where: {
					applicationRef,
				},
			});
			await transaction.intelligence.deleteMany({
				where: {
					applicationRef,
				},
			});
			await transaction.application.update({
				where: {
					ref: applicationRef,
					accessKeyId,
				},
				data: convertToApplicationData(request),
			});
		});

		return { ref: applicationRef };
	};

	return withErrorHandling(withAccess(updateApplication, (ref: string) => getFn(ref)));
}

export { createUpdateApplication };
