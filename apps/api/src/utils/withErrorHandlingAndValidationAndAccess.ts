import { z } from "zod";
import { GrpcErrorMessage, withErrorHandling, withValidation } from "@optimiq-voice/common";

/**
 * Error handling + request validation for a tenant-scoped unary handler.
 *
 * ## What was removed here (identity-removal **Step 3 item 4**)
 *
 * This used to compose `withAccess(handler, getFn)` from `@optimiq-voice/identity`, which called
 * `hasAccessToResource`: fetch the row by ref, read `extended.accessKeyId`, and compare it to the
 * `access[]` list decoded from the caller's token. Two things were wrong with it.
 *
 * 1. **`if (!extended) return true`** — `packages/identity/src/utils/hasAccessToResource.ts:26`.
 *    A resource that does not exist granted access, so a probe for someone else's ref reached the
 *    handler and the handler's own `notFound` was the only thing left. That defect is recorded in
 *    `plans/identity-removal.md` §2.3 and dies with this file.
 * 2. It decided authorization from an **unverified decode** of the token (`jwtDecode`, not
 *    `jwt.verify`) and from a claim list the caller controlled the shape of.
 *
 * The replacement is not another wrapper: every read now goes through
 * `db.forOrganization(organizationId)`, which runs the statement as `api_tenant_tls` with the
 * organization published as a transaction-local setting. PostgreSQL row-level security decides
 * visibility, so another tenant's row is not "found but refused" — it does not exist for this
 * transaction, and `getFn` raises the ordinary `NOT_FOUND`. Enumeration is closed as a side
 * effect: `PERMISSION_DENIED` and `NOT_FOUND` are no longer distinguishable to a prober.
 */
function withErrorHandlingAndValidationAndAccess<T, A>(
	handler: (call: T) => Promise<A>,
	schema: z.ZodSchema,
) {
	// `withAccess` used to supply the callback adaptation as a side effect of wrapping. It is
	// spelled out here so the handlers keep their `(call) => Promise<A>` shape.
	const invoke = async (
		call: T,
		callback: (error?: GrpcErrorMessage, response?: A) => void,
	): Promise<void> => {
		callback(null, await handler(call));
	};

	return withErrorHandling(withValidation(invoke, schema));
}

export { withErrorHandlingAndValidationAndAccess };
