import { badRequestError } from "../core/badRequestError";
import { Database } from "../core/db";
import { notFoundError } from "../core/notFoundError";

/**
 * Reads one application **inside the caller's tenant scope** (identity-removal Step 3 item 4).
 *
 * `db.forOrganization(...)` runs as `api_tenant_tls` with the organization published as a
 * transaction-local setting, so another tenant's ref is invisible and this raises `NOT_FOUND`.
 * The synthesised `extended.accessKeyId` that used to feed `withAccess` is gone with it.
 */
function createGetFnUtil(db: Database) {
	return async (organizationId: string, ref: string) => {
		if (!ref) {
			throw badRequestError("The reference to the resource is required");
		}

		const response = await db.forOrganization(organizationId).application.findUnique({
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

		return response;
	};
}

export { createGetFnUtil };
