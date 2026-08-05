import { datesMapper } from "@optimiq-voice/common";
import { Database } from "../core/db";
import { notFoundError } from "../core/notFoundError";

/**
 * Reads one secret **inside the caller's tenant scope**.
 *
 * `db.forOrganization(...)` runs the query as `api_tenant_tls` with the organization published as
 * a transaction-local setting, so a ref belonging to another tenant simply is not there and this
 * raises `NOT_FOUND`. That is the whole of the ownership check now: the `extended.accessKeyId`
 * shape this used to synthesise existed only to feed `withAccess`, which is deleted
 * (identity-removal Step 3 item 4).
 */
function createGetFnUtil(db: Database) {
	return async function getFnUtil(organizationId: string, ref: string) {
		const response = await db.forOrganization(organizationId).secret.findUnique({
			where: { ref },
		});

		if (!response) {
			throw notFoundError(`Resource not found: ${ref}`);
		}

		return datesMapper(response);
	};
}

export { createGetFnUtil };
