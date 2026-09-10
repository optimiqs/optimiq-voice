/**
 * The audit trail for destroyed call records, as the CDR area is allowed to reach it.
 *
 * Same wall and same crossing as `recordings/purge-audit.ts`: the ledger is `audit_log` in
 * `pbx-db`, the CDR area declares this port and imports nothing from the PBX area, the PBX side
 * implements it, and the sweeper injects it `@Optional()` so a deployment without the PBX area
 * still enforces its retention window.
 *
 * ## One row per organization per partition, not one per leg
 *
 * `purge-audit.ts` argues for one ledger row per recording, and the opposite is right here for a
 * reason that is not laziness: a recording is destroyed individually and `audit_log.resource_ref`
 * can name it, whereas a retention pass destroys a MONTH of every tenant's call records in one
 * `DROP TABLE`. There is no per-leg event to record — the legs are gone in a single DDL statement
 * — and writing three million ledger rows to say so would take longer than the deletion and would
 * make the table it is written into the next retention problem.
 *
 * So the record is the fact that actually happened: this organization had this many call legs in
 * this partition, and that partition was destroyed on this date under this window. That is what a
 * regulator's question ("what happened to our 2025 call records?") is a lookup for.
 *
 * The counts are gathered BEFORE the drop, because afterwards there is nothing to count.
 */
export interface DroppedPartitionAuditEntry {
	/** The physical partition destroyed, e.g. `call_legs_2025_07`. */
	readonly partition: string;
	/** The parent ledger: `call_legs` or `call_events`. */
	readonly table: string;
	/** Rows this organization held in that partition, counted immediately before the drop. */
	readonly rows: number;
	/** The retention window in force, in months, as the reason the drop was permitted. */
	readonly retentionMonths: number;
	/** First month kept, `YYYY-MM-DD`. Everything strictly below it was droppable. */
	readonly cutoffDate: string;
}

export interface CdrLegRetentionAudit {
	recordDroppedPartitions(
		organizationId: string,
		entries: readonly DroppedPartitionAuditEntry[],
	): Promise<void>;
}

/** Nest injection token for {@link CdrLegRetentionAudit}. */
export const CDR_LEG_RETENTION_AUDIT = Symbol("CDR_LEG_RETENTION_AUDIT");
