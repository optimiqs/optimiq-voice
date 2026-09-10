import { getLogger } from "@optimiq-voice/logging";
import { insertAuditLog, serviceActor } from "./audit-log";
import type {
	CdrLegRetentionAudit,
	DroppedPartitionAuditEntry,
} from "../../cdr/retention/leg-retention-audit";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The PBX side of {@link CdrLegRetentionAudit}: destroyed call-record partitions, in `audit_log`.
 *
 * Built the same way as `recording-purge-audit.service.ts` and for its reasons — `insertAuditLog`
 * inside `withTenantScope` rather than `AuditLogService.recordMutation`, because the "mutation" is
 * a deletion in another database that has already happened and cannot roll back; `serviceActor`
 * because no person did it.
 *
 * The one departure is `resourceRef`, which is NULL here rather than a uuid. The resource destroyed
 * is a physical partition — `call_legs_2025_07` — and `audit_log.resource_ref` is a uuid column, so
 * coercing a table name into it is not possible and inventing an id for a table would put a lie in
 * the ledger. The partition's name lives in `before` alongside the row count and the window that
 * permitted the drop, which is the whole answer to the question this row exists for.
 */
export class CdrLegRetentionAuditService implements CdrLegRetentionAudit {
	constructor(private readonly database: PbxDatabaseClient) {}

	async recordDroppedPartitions(
		organizationId: string,
		entries: readonly DroppedPartitionAuditEntry[],
	): Promise<void> {
		if (entries.length === 0) {
			return;
		}
		await this.database.withTenantScope(organizationId, async (transaction) => {
			for (const entry of entries) {
				await insertAuditLog(transaction, {
					organizationId,
					actor: serviceActor("cdr-leg-retention-sweeper"),
					action: "cdr.retention.drop",
					resourceType: entry.table,
					resourceRef: null,
					before: {
						partition: entry.partition,
						rows: entry.rows,
						retentionMonths: entry.retentionMonths,
						cutoffDate: entry.cutoffDate,
					},
					after: null,
				});
			}
		});
		logger.info(
			{ organizationId, partitions: entries.length },
			"recorded destroyed CDR partitions in the audit ledger",
		);
	}
}
