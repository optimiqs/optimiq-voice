import * as grpc from "@grpc/grpc-js";
import { getTenantAccessKeyFromCall, GrpcErrorMessage } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "sipnet", filePath: __filename });

/**
 * Ownership for the Routr-backed resources — identity-removal **Step 3 item 4**, the replacement
 * for `withAccess` / `hasAccessToResource` from `@optimiq-voice/identity`.
 *
 * ## Why this is not row-level security
 *
 * `apps/api`'s own telephony tables moved to a real `organization_id` column with PostgreSQL
 * policies behind it (Step 5). These resources did not, and could not: agents, domains, trunks,
 * credentials and ACLs live in **Routr's** database, reached over its SDK, and their tenant is a
 * string in an `extended` JSONB blob this system does not own. Step 6 recommendation (b) — adopted
 * — keeps the SIP edge out of this migration; Routr's rows are rewritten when `apps/sipd`
 * replaces it in Phase 6. Until then the check has to stay in application code.
 *
 * ## What actually changed, then
 *
 * Two defects, both closed:
 *
 * 1. **A missing resource used to grant access.** `hasAccessToResource` opened with
 *    `if (!extended) return true` (`packages/identity/src/utils/hasAccessToResource.ts:26`), so a
 *    probe for a ref that did not exist — or one whose owner was never recorded — sailed past the
 *    gate and left the handler's own error as the only defence. Here a resource with no recorded
 *    owner is **refused**, and so is one that cannot be read.
 * 2. **The tenant came from an unverified decode of the caller's token.** It compared
 *    `extended.accessKeyId` against `jwtDecode(token).access[]` — `jwtDecode`, not `jwt.verify`.
 *    It now compares against the key the tenancy interceptor resolved from the *verified* token
 *    and stamped on the call, which the caller cannot influence.
 *
 * `NOT_FOUND` rather than `PERMISSION_DENIED` is deliberate: telling a caller that a ref exists
 * but belongs to someone else turns this endpoint into an enumeration oracle. It is also what the
 * `apps/api` resources now do, because RLS makes another tenant's row genuinely absent.
 */
export function withTenantResourceAccess<T, A>(
	handler: (call: T) => Promise<A>,
	getFn: (ref: string) => Promise<{ extended?: Record<string, unknown> } | null | undefined>,
	resource: string,
) {
	return async (call: T, callback: (error?: GrpcErrorMessage, response?: A) => void) => {
		const { request } = call as unknown as { request: { ref: string } };
		const accessKeyId = getTenantAccessKeyFromCall(call);

		let owner: unknown;
		try {
			owner = (await getFn(request.ref))?.extended?.accessKeyId;
		} catch (error) {
			// A read that fails is not an authorisation, however it failed.
			logger.verbose(`could not read ${resource} to check ownership`, { ref: request.ref, error });
			owner = undefined;
		}

		if (owner !== accessKeyId) {
			logger.verbose(`refusing ${resource} outside the caller's tenant`, {
				ref: request.ref,
				accessKeyId,
			});
			callback({
				code: grpc.status.NOT_FOUND,
				message: `${resource} not found: ${request.ref}`,
			});
			return;
		}

		callback(null, await handler(call));
	};
}
