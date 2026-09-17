import { getLogger } from "@optimiq-voice/logging";
import { asUuid, insertAuditLog, serviceActor } from "./audit-log";
import type {
	PurgedRecordingAuditEntry,
	RecordingPurgeAudit,
} from "../../cdr/recordings/purge-audit";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The PBX side of {@link RecordingPurgeAudit}: purged recordings, written into `audit_log`.
 *
 * ## Over `insertAuditLog`, not `AuditLogService.recordMutation`
 *
 * `recordMutation` is the REPOSITORY's seam: it takes a `PbxResource`, diffs a before/after pair,
 * and shares the mutation's transaction because a rolled-back write must leave no trace. None of
 * that fits here — the "mutation" is a deletion in ANOTHER database that has already happened and
 * cannot roll back, there is no resource declaration for a `cdr-db` table and inventing a fake one
 * would put a lie in the type system. So this goes one layer down to the same pure machinery the
 * service uses: `insertAuditLog` inside `withTenantScope`, which keeps RLS as the filter
 * (`audit_log_tenant_insert` refuses any other organization) and keeps the ledger's shaping rules
 * in one file.
 *
 * ## The actor is the system, and the vocabulary already exists for that
 *
 * `serviceActor` is the ledger's own spelling for "no person did this" — `actor_type = service`,
 * the service name in `actor_ref`, everything person-shaped NULL. The action is `recording.purge`
 * (the ledger's dotted `kind.verb` convention), `resource_type` is the physical CDR table name
 * `recordings`, and `resource_ref` is the recording's id through `asUuid` for the reason that
 * helper exists: a malformed id must degrade to NULL, not to a 22P02 that aborts the whole batch's
 * transaction. `before` carries the object key and `after` is null — the shape of a delete, which
 * is what a purge is.
 *
 * One ledger row per recording; the argument lives on the port (`purge-audit.ts`), where both
 * sides can see it.
 */
export class RecordingPurgeAuditService implements RecordingPurgeAudit {
	constructor(private readonly database: PbxDatabaseClient) {}

	async recordAudit(
		organizationId: string,
		entries: readonly PurgedRecordingAuditEntry[],
	): Promise<void> {
		if (entries.length === 0) {
			return;
		}
		await this.database.withTenantScope(organizationId, async (transaction) => {
			for (const entry of entries) {
				await insertAuditLog(transaction, {
					organizationId,
					actor: serviceActor("cdr-recording-retention-sweeper"),
					action: "recording.purge",
					resourceType: "recordings",
					resourceRef: asUuid(entry.recordingId),
					before: { objectKey: entry.objectKey },
					after: null,
				});
			}
		});
		logger.debug(
			{ organizationId, purged: entries.length },
			"recorded purged recordings in the audit ledger",
		);
	}
}
