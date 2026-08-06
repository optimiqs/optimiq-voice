import { Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logger";
import { diffOf, insertAuditLog } from "./audit-log";
import type { AuditAction, AuditActor } from "./audit-log";
import type { PbxChildResource, PbxResource } from "./pbx-resource";
import type { PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/** What the repository hands the ledger for one committed-or-not-at-all mutation. */
export interface AuditMutationInput {
	readonly organizationId: string;
	readonly resource: PbxResource | PbxChildResource;
	readonly action: AuditAction;
	readonly resourceRef: string | null;
	readonly before?: Record<string, unknown> | undefined;
	readonly after?: Record<string, unknown> | undefined;
	readonly actor: AuditActor | undefined;
}

/**
 * The `audit_log` writer — the thing the schema was built for and did not have.
 *
 * ## In the mutation's transaction, not after it
 *
 * Every write in the PBX area is one `withTenantScope` callback (see `pbx.repository.ts`: "the
 * write methods are therefore *one* `Effect.tryPromise` each"), and the ledger row is appended
 * inside it. Two reasons, in this order:
 *
 * 1. **A rolled-back write must leave no trace.** Compile-on-write turns an unsound configuration
 *    into a 422 and rolls the mutation back. An after-commit writer cannot see that — it would
 *    have to be told, by the same code path that already failed — so the first bug in the telling
 *    puts a row in the ledger for a change that never happened. An in-transaction insert is
 *    rolled back by the same `ROLLBACK`, with no code to get wrong.
 * 2. **A committed write must leave a trace.** The mirror case is worse: after-commit means a
 *    process that dies between `COMMIT` and the append silently loses the record of the change,
 *    and the ledger is exactly the artifact whose value depends on having no such gaps.
 *
 * The cost is stated plainly: an insert that fails fails the user's write. That is the same
 * trade `projection-outbox.ts` already makes for the same reason ("a caller told 'saved' about a
 * change whose projection can be silently lost is worse off than a caller told to retry"), and it
 * is why every value that reaches a typed column goes through `asUuid` / `asInetAddress` first —
 * the realistic failure is a malformed id, and it is turned into a NULL rather than a 500.
 *
 * ## RLS is the filter here too
 *
 * The transaction is already inside `set local role pbx_tenant_tls` with the tenant published, and
 * `audit_log_tenant_insert`'s `WITH CHECK` refuses any `organization_id` but that one. So a bug
 * that passed the wrong organization id would be refused by the database rather than recorded.
 *
 * ## No read surface, deliberately
 *
 * `packages/auth`'s permission registry has no `audit.read` (nor any `audit.*`), and the least
 * bad thing to do about that is nothing: an endpoint guarded by `settings.read` would put the
 * change history of every resource behind whichever role happens to hold that, and inventing a
 * permission means editing `packages/auth`, which this change is not allowed to do. The rows are
 * readable with `SELECT` on the table today; the endpoint lands with the permission.
 */
@Injectable()
export class AuditLogService {
	private recorded = 0;
	private skipped = 0;

	get stats(): { readonly recorded: number; readonly skipped: number } {
		return { recorded: this.recorded, skipped: this.skipped };
	}

	/**
	 * Appends one row for a resource mutation.
	 *
	 * A mutation with no actor is NOT recorded, and that is a guard rather than an omission: every
	 * caller of the repository's write methods is a `PbxResourceService` that has a session, so an
	 * absent actor means a new write path that has not been threaded through — and an unattributed
	 * row in a ledger whose whole purpose is attribution is worse than a gap somebody can grep for
	 * (the count is on {@link stats}, and the miss is logged once).
	 */
	async recordMutation(
		transaction: PbxDatabaseTransaction,
		input: AuditMutationInput,
	): Promise<void> {
		if (input.actor === undefined) {
			this.skipped += 1;
			logger.warn("a PBX mutation reached the ledger with no actor and was not recorded", {
				organizationId: input.organizationId,
				resource: input.resource.tableName,
				action: input.action,
			});
			return;
		}

		const diff = diffOf(input.before, input.after, input.resource.secretColumns);
		await insertAuditLog(transaction, {
			organizationId: input.organizationId,
			actor: input.actor,
			action: `${input.resource.kind}.${input.action}`,
			resourceType: input.resource.tableName,
			resourceRef: input.resourceRef,
			before: diff.before,
			after: diff.after,
		});
		this.recorded += 1;
	}
}
