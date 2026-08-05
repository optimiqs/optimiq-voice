import {
	AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
	getOrganizationIdFromCall,
	withErrorHandling,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ApplicationType, UpdateApplicationRequest } from "@optimiq-voice/types";
import { Database } from "../core/db";
import { createGetFnUtil } from "./createGetFnUtil";
import { convertToApplicationData } from "./utils/convertToApplicationData";
import { validOrThrow } from "./validation/validOrThrow";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createUpdateApplication(db: Database) {
	const getFn = createGetFnUtil(db);

	const updateApplication = async (call: { request: UpdateApplicationRequest }) => {
		const { request } = call;
		const { type, ref: applicationRef } = request;

		const organizationId = getOrganizationIdFromCall(call);

		/**
		 * Ownership first, deliberately.
		 *
		 * Outside this tenant's scope the row does not exist, so this raises `NOT_FOUND` before
		 * anything else runs. It replaces `withAccess`, whose `hasAccessToResource` granted access
		 * when the resource was missing — and `withAccess` also happened to run before validation,
		 * so keeping that order preserves the property that matters: a caller probing for someone
		 * else's ref learns exactly one thing, `NOT_FOUND`, and never gets a validation message
		 * that would confirm the request reached the resource.
		 */
		await getFn(organizationId, applicationRef);

		if (type === ApplicationType.AUTOPILOT && !request.endpoint) {
			logger.verbose("setting default endpoint for autopilot application", {
				autopilotEndpoint: AUTOPILOT_SPECIAL_LOCAL_ADDRESS,
			});
			request.endpoint = AUTOPILOT_SPECIAL_LOCAL_ADDRESS;
		}

		validOrThrow(request);

		logger.verbose("call to updateApplication", {
			organizationId,
			type,
		});

		await db.forOrganization(organizationId).transaction(async (transaction) => {
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
					organizationId,
				},
				data: convertToApplicationData(request),
			});
		});

		return { ref: applicationRef };
	};

	return withErrorHandling(
		async (
			call: { request: UpdateApplicationRequest },
			callback: (error?: unknown, response?: unknown) => void,
		) => {
			callback(null, await updateApplication(call));
		},
	);
}

export { createUpdateApplication };
