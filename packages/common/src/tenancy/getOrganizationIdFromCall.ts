import { Metadata, ServerInterceptingCall } from "@grpc/grpc-js";

/**
 * The tenant on the gRPC wire — identity-removal **Step 3 item 2**, the replacement for
 * `getAccessKeyIdFromCall`.
 *
 * ## Why this is a different file rather than an edit to the old one
 *
 * `getAccessKeyIdFromCall` read the `accesskeyid` metadata key: a **client-supplied header**, and
 * the only tenant scoping the identity-era gRPC surface had. Anyone who could reach the port
 * could name any tenant, and the only thing stopping them was `tokenHasAccessKeyId` on the 50-odd
 * paths in `workspaceResourceAccess` — a list, i.e. a thing that can be forgotten.
 *
 * {@link ORGANIZATION_METADATA_KEY} is **server-written**. An interceptor derives it from the
 * verified token and `metadata.set`s it, overwriting whatever the caller sent, exactly as
 * `packages/voice`'s `createJwksAuthInterceptor` has done since Step 4 item 2. Reading it can
 * therefore never be a trust decision, which is why this helper has no validation to do.
 *
 * This module lives in `src/tenancy/`, **not** `src/identity/`: the latter is deleted wholesale in
 * Step 9 (sequencing rule 4) and this has to outlive it.
 */

/**
 * gRPC lower-cases metadata keys on the wire; spelling it lower-case here keeps `metadata.set`
 * and `getMap()` agreeing. Same literal `packages/voice` stamps.
 */
export const ORGANIZATION_METADATA_KEY = "organizationid";

/** Raised when a tenant-scoped handler runs on a call the interceptor never scoped. */
export class MissingTenantScopeError extends Error {
	readonly _tag = "MissingTenantScopeError" as const;

	constructor(detail?: string) {
		super(
			`This call carries no ${ORGANIZATION_METADATA_KEY} metadata, so it has no tenant. ` +
				"A server interceptor must stamp it from a verified token before the handler runs" +
				(detail ? ` (${detail})` : "") +
				".",
		);
		this.name = "MissingTenantScopeError";
	}
}

/** The organization id an interceptor stamped on this call, or `undefined` if none did. */
export function findOrganizationIdInCall(call: unknown): string | undefined {
	const metadata = (call as { metadata?: Metadata }).metadata;
	const value = metadata?.getMap()[ORGANIZATION_METADATA_KEY]?.toString().trim();
	return value && value.length > 0 ? value : undefined;
}

/**
 * The organization id for this call.
 *
 * Throws rather than returning `undefined`: a tenant-scoped query built from a missing tenant is
 * how "list everything" bugs happen, and `withErrorHandling` turns the throw into an
 * `UNAUTHENTICATED`/`INTERNAL` status rather than an empty page that looks like success.
 */
export function getOrganizationIdFromCall(call: unknown): string {
	const organizationId = findOrganizationIdInCall(call);
	if (!organizationId) {
		throw new MissingTenantScopeError();
	}
	return organizationId;
}

/** Stamps the server-resolved tenant, replacing anything the caller supplied. */
export function stampOrganizationIdOnCall(metadata: Metadata, organizationId: string): void {
	metadata.set(ORGANIZATION_METADATA_KEY, organizationId);
}

export type { ServerInterceptingCall };

/**
 * The legacy `WO…` workspace key, when the tenant has one.
 *
 * This is the **same metadata key** `getAccessKeyIdFromCall` read, but its meaning is inverted:
 * the tenancy interceptor overwrites it with the key it resolved from the token, so it is now
 * server-written like {@link ORGANIZATION_METADATA_KEY} rather than caller-supplied. It exists
 * because two consumers still speak the legacy vocabulary and neither is `apps/api`'s database:
 *
 * - **Routr** verifies the SIP/WebRTC connect token `createCreateTestToken` signs, and matches it
 *   against `extended.accessKeyId` on rows in its own database. Step 6 recommendation (b) — adopted
 *   — keeps the SIP edge out of this migration entirely; Routr's rows are rewritten when
 *   `apps/sipd` replaces it in Phase 6.
 * - **`packages/sipnet`** reads and writes those same Routr rows.
 *
 * For a tenant created after the cutover there is no `WO…` key and this returns the organization
 * id, so both vocabularies converge on one value and the sipnet/Routr path keeps working without
 * a second code path.
 */
export const TENANT_ACCESS_KEY_METADATA_KEY = "accesskeyid";

/** The server-resolved legacy key, or `undefined` when the call was never scoped. */
export function findTenantAccessKeyInCall(call: unknown): string | undefined {
	const metadata = (call as { metadata?: Metadata }).metadata;
	const value = metadata?.getMap()[TENANT_ACCESS_KEY_METADATA_KEY]?.toString().trim();
	return value && value.length > 0 ? value : undefined;
}

export function getTenantAccessKeyFromCall(call: unknown): string {
	const metadata = (call as { metadata?: Metadata }).metadata;
	const value = metadata?.getMap()[TENANT_ACCESS_KEY_METADATA_KEY]?.toString().trim();
	if (!value) {
		throw new MissingTenantScopeError("no server-resolved tenant access key");
	}
	return value;
}

export function stampTenantAccessKeyOnCall(metadata: Metadata, accessKeyId: string): void {
	metadata.set(TENANT_ACCESS_KEY_METADATA_KEY, accessKeyId);
}
