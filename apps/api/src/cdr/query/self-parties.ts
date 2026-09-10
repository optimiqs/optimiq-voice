import type { OwnedParties } from "./cdr-self-scope";

/**
 * The PBX → CDR port that makes `cdr.read.own` answerable.
 *
 * Declared HERE, in the CDR area, and implemented in the PBX area — the same shape and the same
 * reason as `recordings/retention-policy.ts` and `recordings/purge-audit.ts`: the two areas are
 * siblings composed conditionally in `main.ts`, each mounts on its own database URL, and an import
 * in either direction would couple their boot conditions. `PbxCdrPortsModule` binds the
 * implementation when both are present.
 *
 * Injected `@Optional()`, like both of its neighbours. Absent means the CDR area is running without
 * the PBX area, so no user → extension link exists on this deployment; a caller holding only
 * `cdr.read.own` is then refused by name rather than shown either everything or nothing.
 */
export const CDR_SELF_PARTIES = Symbol("api/cdr/SelfParties");

export interface CdrSelfParties {
	/** The extensions the acting user is assigned in this organization. Empty when they hold none. */
	forUser(organizationId: string, userId: string): Promise<OwnedParties>;
}
