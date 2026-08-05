import { badRequestError } from "../core/badRequestError";
import { Database } from "../core/db";
import { notFoundError } from "../core/notFoundError";

function createGetFnUtil(db: Database) {
	return async (ref: string) => {
		if (!ref) {
			throw badRequestError("The reference to the resource is required");
		}

		const response = await db.application.findUnique({
			where: { ref },
			include: {
				textToSpeech: true,
				speechToText: true,
				intelligence: true,
			},
		});

		if (!response) {
			throw notFoundError("Application not found");
		}

		return {
			// NOTE: Adding extended to match the signature of withAccess
			...response,
			extended: {
				accessKeyId: response.accessKeyId,
			},
		};
	};
}

export { createGetFnUtil };
