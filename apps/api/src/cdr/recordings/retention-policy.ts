/**
 * The per-organization recording retention window, as the CDR area is allowed to know it.
 *
 * ## Why this is an interface here and an implementation somewhere else
 *
 * The window a tenant chooses lives in `org_setting` — `pbx-db`, a different database with a
 * different pool, deliberately never shared with this one. `cdr-env.ts` spent a paragraph on why
 * the CDR module must not read it directly: a cross-database round trip on the recording write
 * path, and a `PbxDatabaseClient` inside a module that is self-contained on purpose. That
 * objection is respected by inverting the dependency: the CDR area OWNS this port and imports
 * nothing from the PBX area, and the PBX side implements it
 * (`pbx/org-settings/recording-retention-policy.service.ts`) behind a `@Global()` module — so the
 * two sibling modules never import each other and `CdrModule` still boots when the PBX area is
 * not mounted at all, with `@Optional()` injection turning an absent provider into "the platform
 * decides".
 *
 * ## The contract, precisely
 *
 * `undefined` means "this organization has never set a window" and the caller falls back to the
 * platform's `CDR_RECORDING_RETENTION_DAYS`. A NUMBER — including an explicit `0`, which means
 * keep for ever on exactly the env variable's terms — is the tenant's answer and wins. The
 * implementation is expected to cache: this is called on the recording write path, and the port
 * would be rejected on the same grounds as the direct read if every recording cost a foreign
 * database query.
 */
export interface RecordingRetentionPolicy {
	retentionDaysFor(organizationId: string): Promise<number | undefined>;
}

/** Nest injection token for {@link RecordingRetentionPolicy}. A symbol, so nothing collides. */
export const RECORDING_RETENTION_POLICY = Symbol("RECORDING_RETENTION_POLICY");
