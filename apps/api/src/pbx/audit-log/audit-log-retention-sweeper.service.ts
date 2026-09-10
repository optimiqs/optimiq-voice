import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { sql } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** Milliseconds in a day; the retention window is expressed in days of them. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Purges `audit_log` rows past the PLATFORM's retention window.
 *
 * ## The ledger was the one table with no retention at all
 *
 * Every mutation on this platform appends a row here, and nothing has ever removed one. That is a
 * table that grows monotonically with a tenant's activity for the life of the deployment, and —
 * more to the point — an indefinite store of who did what and from which IP address, which is the
 * same data-minimisation problem the recording and voicemail windows exist to solve, applied to
 * the table that records the solving.
 *
 * ## A platform env, never a tenant setting — and that is the whole design
 *
 * `AUDIT_LOG_RETENTION_DAYS` is read from the process environment and there is deliberately no
 * `org_setting` beside it. The change ledger is the record of what a tenant's OWN administrators
 * did, and the parties it protects are that tenant's users, their customers, and whoever
 * investigates afterwards. An organization able to set this could shorten the evidence of its own
 * actions on demand, which is not retention — it is a cover-up with a settings screen. The
 * database already says the same thing in privileges: `security-schema.ts` grants the tenant role
 * `SELECT, INSERT` and nothing else, under two policies rather than one `FOR ALL`, so neither a
 * bug nor a compromised runtime principal can rewrite history. This sweeper is the ONE writer
 * allowed to remove a row, it runs as the admin principal rather than the tenant role for exactly
 * that reason, and its window is the operator's.
 *
 * ## Untenanted delete, and why that is not a hole
 *
 * The predicate is `occurred_at < cutoff` with no organization in it, because the window is the
 * platform's and applies identically to every tenant. Running it under `withTenantScope` would be
 * theatre — it would need one pass per organization to express the same thing, and the tenant role
 * has no `DELETE` privilege to run it with anyway.
 *
 * ## Batched, and the ordering is the batch's whole point
 *
 * A first pass on an established deployment may face millions of rows. It deletes at most
 * `AUDIT_LOG_SWEEP_BATCH` per pass, chosen by `occurred_at` ascending, so the oldest go first and
 * a pass never holds a long transaction against a table that takes a write on every mutation the
 * API serves. The remainder is still expired and is picked up next pass; a backlog drains over
 * days rather than locking the platform for minutes.
 *
 * ## The purge is not itself audited
 *
 * Deliberately, and it is worth saying why rather than leaving it to look like an omission. A row
 * recording "the ledger was trimmed under a 400-day window" would be a row that itself expires
 * under the same window, and writing one per pass would put a daily entry in every tenant's change
 * history that no tenant caused and none can act on. What an operator needs is the log line below
 * and the env value, both of which are the operator's own artefacts — the same reasoning
 * `leg-retention-audit.ts` uses when it refuses to write one ledger row per destroyed leg.
 */
@Injectable()
export class AuditLogRetentionSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private purged = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {}

	get stats(): { readonly swept: number; readonly purged: number; readonly failed: number } {
		return { swept: this.swept, purged: this.purged, failed: this.failed };
	}

	onModuleInit(): void {
		if (this.env.AUDIT_LOG_RETENTION_DAYS === 0 || this.env.AUDIT_LOG_SWEEP_INTERVAL_MS === 0) {
			logger.info(
				{ retentionDays: this.env.AUDIT_LOG_RETENTION_DAYS },
				"the audit log purge is off; ledger rows are kept indefinitely",
			);
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished.
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.env.AUDIT_LOG_SWEEP_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.env.AUDIT_LOG_SWEEP_INTERVAL_MS,
				retentionDays: this.env.AUDIT_LOG_RETENTION_DAYS,
				batch: this.env.AUDIT_LOG_SWEEP_BATCH,
			},
			"audit log retention purge started",
		);
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass. Public so a harness can drive it deterministically rather than waiting out an
	 * interval, which is the only honest way to test a timer.
	 *
	 * Re-entrancy is refused rather than queued, and a pass that throws does not kill the interval:
	 * nothing was deleted that should not have been, so the next tick sees the same worklist.
	 */
	async sweep(): Promise<{ readonly purged: number }> {
		if (this.running || this.stopped || this.env.AUDIT_LOG_RETENTION_DAYS === 0) {
			return { purged: 0 };
		}
		this.running = true;
		try {
			const cutoff = new Date(Date.now() - this.env.AUDIT_LOG_RETENTION_DAYS * DAY_MS);
			// An ISO string with an explicit cast rather than the `Date` object: postgres.js does not
			// serialise a `Date` bound through drizzle's raw `sql` template, and the failure is a
			// runtime `ERR_INVALID_ARG_TYPE` inside the driver rather than anything the type system
			// catches — so the conversion happens here, where it is visible.
			this.swept += 1;
			const deleted = rowsOf(
				await this.database.adminDb.execute(sql`
					delete from audit_log
					where id in (
						select id from audit_log
						where occurred_at < ${cutoff.toISOString()}::timestamptz
						order by occurred_at
						limit ${this.env.AUDIT_LOG_SWEEP_BATCH}
					)
					returning id
				`),
			).length;
			this.purged += deleted;
			if (deleted > 0) {
				logger.info(
					{
						purged: deleted,
						cutoff: cutoff.toISOString(),
						retentionDays: this.env.AUDIT_LOG_RETENTION_DAYS,
					},
					"purged expired audit log rows",
				);
			}
			return { purged: deleted };
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "the audit log retention purge failed");
			return { purged: 0 };
		} finally {
			this.running = false;
		}
	}
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here so the purge works under either adapter, exactly as the CDR
 * recording sweeper does for its own worklist.
 */
function rowsOf<T>(result: unknown): readonly T[] {
	if (Array.isArray(result)) {
		return result as readonly T[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		return ((result as { readonly rows?: readonly T[] }).rows ?? []) as readonly T[];
	}
	return [];
}
