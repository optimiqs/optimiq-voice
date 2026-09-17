import { getLogger } from "@optimiq-voice/logging";
import { asInetAddress, asUuid, insertAuditLog } from "./audit-log";
import type {
	RecordingAccessAudit,
	RecordingAccessAuditEntry,
} from "../../cdr/recordings/access-audit";
import type { AuditActor } from "./audit-log";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The PBX side of {@link RecordingAccessAudit}: recording reads, written into `audit_log`.
 *
 * Built exactly like `recording-purge-audit.service.ts` and for its reasons — `insertAuditLog`
 * inside `withTenantScope` rather than `AuditLogService.recordMutation`, because there is no
 * `PbxResource` for a `cdr-db` table and no before/after pair to diff; RLS
 * (`audit_log_tenant_insert`) is still the filter that refuses any other organization's id.
 *
 * ## The action vocabulary is extended here rather than in `AuditAction`
 *
 * `AuditAction` — `create | update | delete | reorder` — is the closed enum the REPOSITORY's seam
 * uses, and it is closed because a row mutation really only has those four shapes. `audit_log.action`
 * itself is a free `text` column holding a dotted `kind.verb`, and the purge writers already put
 * `recording.purge` and `cdr.retention.drop` in it without touching that enum. `recording.download-url`
 * and `recording.play` join them on the same terms: a read is not one of the four mutation shapes
 * and pretending it is (`recording.read`, mapped onto `update`) would put a lie in the ledger's
 * most-queried column.
 *
 * ## `system`, not a fabricated user
 *
 * A signed-token open has no session — the scheme exists precisely so an `<audio src>` can fetch
 * without one — so the row is written with `actor_type = system` and the TOKEN'S subject in
 * `actor_ref`. `serviceActor` would have been the nearer-looking helper and is wrong: that spells
 * "this platform's own scheduler did it", and this is a request from outside carrying a bearer
 * credential. The address and user-agent are the only identifying facts that exist at that moment,
 * and they are recorded because a leaked link is visible as one address minting and four others
 * fetching.
 */
export class RecordingAccessAuditService implements RecordingAccessAudit {
	constructor(private readonly database: PbxDatabaseClient) {}

	async recordAccess(organizationId: string, entry: RecordingAccessAuditEntry): Promise<void> {
		const actor: AuditActor = {
			type: entry.actor.kind === "user" ? "user" : "system",
			userId: asUuid(entry.actor.userId),
			ref: entry.actor.ref,
			ipAddress: asInetAddress(entry.actor.ipAddress),
			userAgent: entry.actor.userAgent,
			requestId: null,
		};
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId,
				actor,
				action: `recording.${entry.event}`,
				resourceType: "recordings",
				resourceRef: asUuid(entry.recordingId),
				// A read changes nothing, so `before` is null and the circumstances go in `after`.
				// The alternative — both null — would make the row unanswerable without joining a
				// table in another database that the retention sweep is allowed to destroy.
				before: null,
				after: entry.detail,
			});
		});
		logger.debug(
			{ organizationId, recordingId: entry.recordingId, event: entry.event },
			"recorded a recording access in the audit ledger",
		);
	}
}
