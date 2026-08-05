import { Metadata, ServerInterceptingCall, status } from "@grpc/grpc-js";
import {
	decodeToken,
	getTokenFromCall,
	stampOrganizationIdOnCall,
	stampTenantAccessKeyOnCall,
	TokenUseEnum,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * Turns the verified token on a gRPC call into a **server-written** tenant — identity-removal
 * **Step 3 items 2 and 5**.
 *
 * ## What this replaces
 *
 * `getAccessKeyIdFromCall(call)` read the `accesskeyid` metadata key: a client-supplied header.
 * Seventeen handlers filtered their queries by it, and the only thing that stopped a caller from
 * naming someone else's tenant was `tokenHasAccessKeyId` on the ~50 paths listed in
 * `workspaceResourceAccess` — enforcement by enumeration, so a new path defaulted to unprotected.
 *
 * Here the tenant comes from the token and nothing else. It is stamped onto
 * `ORGANIZATION_METADATA_KEY`, overwriting whatever arrived on the wire, which is the same posture
 * `packages/voice`'s `createJwksAuthInterceptor` has had since Step 4 item 2. Handlers then call
 * `getOrganizationIdFromCall`, which cannot be a trust decision because the value is not the
 * caller's to set.
 *
 * ## Three token shapes, one answer
 *
 * | token                                  | tenant claim                          | resolution     |
 * | -------------------------------------- | ------------------------------------- | -------------- |
 * | better-auth per-call token (Step 4)    | `organizationId`                      | used directly  |
 * | better-auth token, legacy claim slot   | `accessKeyId` = an `organization.id`  | used directly  |
 * | legacy identity token (SDK, CLI, dash) | `access[].accessKeyId` = a `WO…` key  | Step 2 ledger  |
 *
 * The third row is why this interceptor is asynchronous: translating a `WO…` key needs the
 * `legacy_workspace_organization` ledger. `LegacyAccessKeyRepository` memoises both directions, so
 * the lookup is a map hit after the first call for a tenant. The decision is deferred inside
 * `onReceiveMetadata` — the call does not reach a handler until `proceed(metadata)` runs, and a
 * rejection ends it first.
 *
 * ## The cross-tenant gate
 *
 * A caller may still send `accesskeyid` (every released SDK does). It is no longer trusted, but it
 * is not ignored either: if it resolves to a different organization than the token does, the call
 * is refused with `PERMISSION_DENIED` rather than quietly served against the token's tenant. That
 * keeps the failure legible — a client asking for the wrong tenant learns it did — and it is the
 * same posture `AuthService.resolveRoleIn` takes on the HTTP surface for an `x-api-key` principal.
 *
 * ## Fail closed
 *
 * A token with no resolvable tenant, or a `WO…` key that was never migrated, ends the call. There
 * is no "unscoped" fallback: an unscoped tenant query is a cross-tenant read, and the identity-era
 * behaviour (`accessKeyId === undefined`, which most handlers passed straight into a `where`) is
 * exactly the bug this removes.
 */

/** Resolves a legacy `WO…` workspace key to `organization.id`, or `null` if it never migrated. */
export type LegacyAccessKeyResolver = (accessKeyId: string) => Promise<string | null>;

/** The reverse direction: `organization.id` → the `WO…` key it was migrated from, if any. */
export type OrganizationAccessKeyResolver = (organizationId: string) => Promise<string | null>;

export interface TenancyInterceptorOptions {
	/** Paths that carry no tenant at all (health, invite acceptance, …). */
	readonly publicPaths: readonly string[];
	readonly resolveLegacyAccessKey: LegacyAccessKeyResolver;
	/**
	 * Used to stamp `TENANT_ACCESS_KEY_METADATA_KEY` for the Routr-facing consumers. Optional:
	 * when it is absent, or the organization has no legacy key, the organization id is stamped
	 * instead so both vocabularies converge on one value.
	 */
	readonly resolveOrganizationAccessKey?: OrganizationAccessKeyResolver;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface TenantClaims {
	readonly organizationId?: string;
	readonly accessKeyId?: string;
	readonly access?: readonly { accessKeyId?: string }[];
}

/** The tenant claims a token carries, most specific first. Pure — exported for the unit specs. */
export function readTenantClaims(token: string | undefined): TenantClaims | null {
	if (!token) {
		return null;
	}
	try {
		return decodeToken<TokenUseEnum.ACCESS>(token) as unknown as TenantClaims;
	} catch {
		return null;
	}
}

/**
 * The ordered list of tenant candidates in a token: the canonical `organizationId` claim first,
 * then the `accessKeyId` slot Step 4 kept for shape compatibility, then the legacy `access[]`
 * array the identity signer produced.
 */
export function tenantCandidates(claims: TenantClaims | null): readonly string[] {
	if (!claims) {
		return [];
	}
	const candidates = [
		claims.organizationId,
		claims.accessKeyId,
		...(claims.access ?? []).map((entry) => entry.accessKeyId),
	];
	const seen = new Set<string>();
	return candidates.filter((candidate): candidate is string => {
		const value = candidate?.trim();
		if (!value || seen.has(value)) {
			return false;
		}
		seen.add(value);
		return true;
	});
}

export function isOrganizationId(candidate: string): boolean {
	return UUID_PATTERN.test(candidate);
}

/** Raised when no candidate in the token resolves to an organization. */
export class UnresolvableTenantError extends Error {
	readonly _tag = "UnresolvableTenantError" as const;

	constructor(readonly candidates: readonly string[]) {
		super(
			candidates.length === 0
				? "The call carries no tenant claim."
				: `None of the token's tenant claims resolve to an organization: ${candidates.join(", ")}.`,
		);
		this.name = "UnresolvableTenantError";
	}
}

export async function resolveTenantFromClaims(
	claims: TenantClaims | null,
	options: Pick<TenancyInterceptorOptions, "resolveLegacyAccessKey">,
): Promise<string> {
	const candidates = tenantCandidates(claims);
	for (const candidate of candidates) {
		if (isOrganizationId(candidate)) {
			return candidate.toLowerCase();
		}
		const mapped = await options.resolveLegacyAccessKey(candidate);
		if (mapped) {
			return mapped.toLowerCase();
		}
	}
	throw new UnresolvableTenantError(candidates);
}

/**
 * Normalises whatever the caller put in `accesskeyid` so it can be compared with the token's
 * tenant. An unmappable value is a mismatch, not a pass — the caller named something this
 * deployment has never heard of.
 */
async function resolveRequestedTenant(
	requested: string,
	options: Pick<TenancyInterceptorOptions, "resolveLegacyAccessKey">,
): Promise<string | null> {
	if (isOrganizationId(requested)) {
		return requested.toLowerCase();
	}
	const mapped = await options.resolveLegacyAccessKey(requested);
	return mapped ? mapped.toLowerCase() : null;
}

export function createTenancyInterceptor(options: TenancyInterceptorOptions) {
	return (methodDefinition: { path: string }, call: ServerInterceptingCall) => {
		const { path } = methodDefinition;

		if (options.publicPaths.includes(path)) {
			return call;
		}

		return new ServerInterceptingCall(call, {
			start: (next) => {
				next({
					onReceiveMetadata: (metadata: Metadata, proceed: (metadata: Metadata) => void) => {
						const requested = metadata.getMap()["accesskeyid"]?.toString().trim();
						const claims = readTenantClaims(getTokenFromCall(call));

						resolveTenantFromClaims(claims, options)
							.then(async (organizationId) => {
								if (requested) {
									const requestedOrganizationId = await resolveRequestedTenant(requested, options);
									if (requestedOrganizationId !== organizationId) {
										logger.verbose("refusing a cross-tenant gRPC call", {
											path,
											requested,
											organizationId,
										});
										call.sendStatus({
											code: status.PERMISSION_DENIED,
											details: "Permission denied",
										});
										return;
									}
								}

								// Server-verified, so both replace whatever the caller claimed.
								stampOrganizationIdOnCall(metadata, organizationId);
								stampTenantAccessKeyOnCall(
									metadata,
									(await options.resolveOrganizationAccessKey?.(organizationId)) ?? organizationId,
								);
								logger.verbose("scoped gRPC call to an organization", { path, organizationId });
								proceed(metadata);
							})
							.catch((error: unknown) => {
								logger.verbose("rejecting a gRPC call with no resolvable tenant", { path, error });
								call.sendStatus({
									code: status.UNAUTHENTICATED,
									details: "The call carries no resolvable tenant",
								});
							});
					},
				});
			},
		});
	};
}
