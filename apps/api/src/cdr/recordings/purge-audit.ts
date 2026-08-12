/**
 * The audit trail for purged recordings, as the CDR area is allowed to reach it.
 *
 * The ledger is `audit_log` in `pbx-db` — the same cross-database wall `retention-policy.ts`
 * describes, crossed the same way: the CDR area owns this narrow port and imports nothing from
 * the PBX area; the PBX side implements it over its ledger machinery
 * (`pbx/shared/recording-purge-audit.service.ts`) and provides it from the `@Global()` ports
 * module. The sweeper injects it `@Optional()` and no-ops when it is absent, because a deployment
 * without the PBX area has no ledger to write and must keep purging on schedule regardless — a
 * retention window that stops being enforced because an audit table is unreachable would be the
 * tail wagging the dog.
 *
 * The implementation writes ONE ledger row per purged recording rather than one per sweep batch.
 * That choice is made on the ledger's own terms: `audit_log.resource_ref` is a uuid column that
 * names ONE resource, and "when was recording X destroyed, and under what policy?" — the question
 * a retention audit exists to answer — is a lookup by that column. A batch row naming two hundred
 * ids in a jsonb blob would make every such question a full-text scan, to save at most a few
 * hundred inserts per hour on a table built to be appended to.
 */
export interface PurgedRecordingAuditEntry {
	/** `recordings.id` in the CDR database — the row the purge tombstoned. */
	readonly recordingId: string;
	/** The object the sweep deleted, tenant-prefixed (`<orgId>/<callId>/<recordingId>.<format>`). */
	readonly objectKey: string;
}

export interface RecordingPurgeAudit {
	recordAudit(organizationId: string, entries: readonly PurgedRecordingAuditEntry[]): Promise<void>;
}

/** Nest injection token for {@link RecordingPurgeAudit}. */
export const RECORDING_PURGE_AUDIT = Symbol("RECORDING_PURGE_AUDIT");
