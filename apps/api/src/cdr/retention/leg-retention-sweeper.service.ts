import {
	Inject,
	Injectable,
	Optional,
	type OnApplicationShutdown,
	type OnModuleInit,
} from "@nestjs/common";
import {
	dropPartitionsBefore,
	droppablePartitionsQuery,
	planCdrRetention,
	sql,
	type CdrRetentionPlan,
	type PartitionedCdrTable,
} from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logging";
import { CDR_DATABASE, CDR_ENV } from "../shared/cdr.tokens";
import { CDR_LEG_RETENTION_AUDIT } from "./leg-retention-audit";
import type { CdrEnv } from "../shared/cdr-env";
import type { CdrLegRetentionAudit, DroppedPartitionAuditEntry } from "./leg-retention-audit";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/**
 * Enforces the platform's call-record retention window by dropping expired monthly partitions.
 *
 * ## What was missing
 *
 * `packages/cdr-db/src/retention.ts` has had `runCdrRetention` and ten spec cases since it was
 * written, and its own header says so plainly: "Deliberately NOT a cron… Phase 2 wires it to
 * whatever scheduler the platform ends up with." Nothing ever did. `scripts/retention.ts` is a
 * manual CLI, no CronJob or compose entry calls it, and the result is a ledger that grows for ever
 * — which is a compliance problem in both directions, since a window a customer was promised is
 * not being kept either.
 *
 * ## Why a partition drop and not a per-organization delete
 *
 * `call_legs` and `call_events` are partitioned by month precisely so that expiry is a `DROP
 * TABLE`: milliseconds, no dead tuples, no vacuum debt, no lock on the live months. The cost of
 * that design is the thing this service must be honest about — **a partition is shared by every
 * tenant, so the window it enforces is the PLATFORM's, not any one organization's.**
 *
 * A shorter per-organization window cannot be a partition drop; it would be a batched `DELETE …
 * WHERE organization_id = …` against a table that is append-only BY PRIVILEGE (`GRANT SELECT,
 * INSERT` only — see the CDR baseline migration), so it would need a new grant, and it would leave
 * exactly the bloat partitioning exists to avoid. A LONGER per-organization window cannot work at
 * all: the partition is already gone. So this service enforces one number, and a tenant-specific
 * window is a product decision that needs a different storage layout, not a flag here.
 *
 * Recordings are the opposite case and are handled elsewhere: they are individually addressable
 * objects with a per-row `retention_until` stamped from the tenant's own
 * `recordings.retentionDays` setting, and `recording-retention-sweeper.service.ts` purges them.
 *
 * ## Dry run is the default
 *
 * `CDR_RETENTION_DRY_RUN` defaults to true. A `DROP TABLE` against a billing ledger is not
 * reversible and a deployment must not start doing it because a version was upgraded. In dry-run
 * mode the sweep does everything except the drop — it computes the plan, lists the partitions and
 * their sizes, gathers the per-organization row counts, and logs all of it — so an operator can
 * read exactly what the first real pass would destroy before enabling it.
 */
@Injectable()
export class CdrLegRetentionSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private dropped = 0;
	private failed = 0;

	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
		/** The ledger, implemented on the PBX side and OPTIONAL for the reason its port states. */
		@Optional()
		@Inject(CDR_LEG_RETENTION_AUDIT)
		private readonly audit?: CdrLegRetentionAudit,
	) {}

	get stats(): {
		readonly swept: number;
		readonly dropped: number;
		readonly failed: number;
	} {
		return { swept: this.swept, dropped: this.dropped, failed: this.failed };
	}

	onModuleInit(): void {
		// Under the writer switch with the other singleton workloads: N replicas racing to drop the
		// same partition would have N-1 of them fail on a table that no longer exists.
		if (
			!this.env.CDR_WRITER_ENABLED ||
			this.env.CDR_LEG_RETENTION_MONTHS === 0 ||
			this.env.CDR_RETENTION_SWEEP_INTERVAL_MS === 0
		) {
			return;
		}
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.env.CDR_RETENTION_SWEEP_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.env.CDR_RETENTION_SWEEP_INTERVAL_MS,
				retentionMonths: this.env.CDR_LEG_RETENTION_MONTHS,
				dryRun: this.env.CDR_RETENTION_DRY_RUN,
			},
			this.env.CDR_RETENTION_DRY_RUN
				? "CDR partition retention started in DRY-RUN mode; nothing will be dropped"
				: "CDR partition retention started; expired monthly partitions WILL be dropped",
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
	 * One pass. Public so a harness can drive it deterministically rather than waiting out a
	 * twenty-four-hour interval, which is the only honest way to test a timer.
	 *
	 * Re-entrancy is refused rather than queued, for a harder reason than the recording sweep's: two
	 * passes running at once would race on the same `DROP TABLE` and one of them would report a
	 * failure that is really the other one's success.
	 */
	async sweep(): Promise<CdrRetentionSweepResult> {
		if (this.running || this.stopped) {
			return { plan: undefined, dropped: [], dryRun: this.env.CDR_RETENTION_DRY_RUN };
		}
		this.running = true;
		try {
			return await this.runOnce();
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "the CDR partition retention sweep failed");
			return { plan: undefined, dropped: [], dryRun: this.env.CDR_RETENTION_DRY_RUN };
		} finally {
			this.running = false;
		}
	}

	private async runOnce(): Promise<CdrRetentionSweepResult> {
		this.swept += 1;
		const plan = planCdrRetention({
			retentionMonths: this.env.CDR_LEG_RETENTION_MONTHS,
		});
		const dryRun = this.env.CDR_RETENTION_DRY_RUN;

		const candidates: PartitionCandidate[] = [];
		for (const table of plan.tables) {
			for (const row of rowsOf<DroppablePartitionRow>(
				await this.database.adminDb.execute(droppablePartitionsQuery(table, plan.cutoff)),
			)) {
				candidates.push({ table, partition: row.partition_name, bytes: Number(row.bytes ?? 0) });
			}
		}
		if (candidates.length === 0) {
			logger.debug(
				{ cutoff: plan.cutoffDate, retentionMonths: plan.retentionMonths },
				"CDR partition retention: nothing is past the window",
			);
			return { plan, dropped: [], dryRun };
		}

		// Counted before anything is dropped, because afterwards there is nothing to count. Only
		// `call_legs` is tallied: `call_events` is a child record of a leg and counting it would
		// double every number in a compliance report for no extra fact.
		const perOrganization = await this.countByOrganization(
			candidates.filter((candidate) => candidate.table === "call_legs"),
		);

		logger.info(
			{
				dryRun,
				cutoff: plan.cutoffDate,
				retentionMonths: plan.retentionMonths,
				partitions: candidates.map((candidate) => candidate.partition),
				bytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
				organizations: perOrganization.size,
			},
			dryRun
				? "CDR partition retention (DRY RUN): these partitions WOULD be dropped"
				: "CDR partition retention: dropping expired partitions",
		);
		if (dryRun) {
			return { plan, dropped: [], dryRun };
		}

		const dropped: string[] = [];
		for (const table of plan.tables) {
			if (this.stopped) {
				break;
			}
			dropped.push(...(await dropPartitionsBefore(this.database.adminDb, table, plan.cutoff)));
		}
		this.dropped += dropped.length;

		// The ledger last, after the deletion is irreversible, on the same reasoning the recording
		// sweep's audit records: the honest failure mode is a drop that happened and was not
		// recorded, never a record of a drop that did not.
		await this.recordAudit(plan, perOrganization, dropped);
		return { plan, dropped, dryRun };
	}

	/**
	 * `select organization_id, count(*) from <partition> group by 1` per candidate partition.
	 *
	 * Directly against the PARTITION rather than the parent with a `started_at` range, so the
	 * planner cannot choose to scan a live month; and one aggregate per partition per retention
	 * pass is a sequential scan of a table that is about to be deleted anyway.
	 *
	 * The partition name is interpolated, which is the one place in this area that happens. It is
	 * safe by construction and not by trust: it came from `droppablePartitionsQuery`, which reads
	 * `pg_class.relname` for children of an allow-listed parent — the string is PostgreSQL's own
	 * identifier for a table that exists, never anything a caller supplied. It is still quoted.
	 */
	private async countByOrganization(
		candidates: readonly PartitionCandidate[],
	): Promise<Map<string, PartitionTally[]>> {
		const byOrganization = new Map<string, PartitionTally[]>();
		if (this.audit === undefined) {
			return byOrganization;
		}
		for (const candidate of candidates) {
			const rows = rowsOf<{ readonly organization_id: string; readonly rows: string | number }>(
				await this.database.adminDb.execute(
					sql`select "organization_id", count(*) as "rows" from ${sql.identifier(candidate.partition)} group by 1`,
				),
			);
			for (const row of rows) {
				const entries = byOrganization.get(row.organization_id) ?? [];
				entries.push({
					partition: candidate.partition,
					table: candidate.table,
					rows: Number(row.rows),
				});
				byOrganization.set(row.organization_id, entries);
			}
		}
		return byOrganization;
	}

	private async recordAudit(
		plan: CdrRetentionPlan,
		perOrganization: ReadonlyMap<string, PartitionTally[]>,
		dropped: readonly string[],
	): Promise<void> {
		if (this.audit === undefined || dropped.length === 0) {
			return;
		}
		// Only partitions that were ACTUALLY dropped reach the ledger. A candidate the drop did not
		// return is one another replica took, or one that failed; recording it would be a ledger
		// entry for a deletion this process did not perform.
		const actuallyDropped = new Set(dropped);
		for (const [organizationId, entries] of perOrganization) {
			const kept: DroppedPartitionAuditEntry[] = entries
				.filter((entry) => actuallyDropped.has(entry.partition))
				.map((entry) => ({
					...entry,
					retentionMonths: plan.retentionMonths,
					cutoffDate: plan.cutoffDate,
				}));
			if (kept.length === 0) {
				continue;
			}
			try {
				await this.audit.recordDroppedPartitions(organizationId, kept);
			} catch (error) {
				logger.error(
					{ organizationId, partitions: kept.length, err: String(error) },
					"dropped CDR partitions could not be recorded in the audit ledger",
				);
			}
		}
	}
}

export interface CdrRetentionSweepResult {
	/** Undefined when the pass was refused (re-entrant, stopped) or threw. */
	readonly plan: CdrRetentionPlan | undefined;
	readonly dropped: readonly string[];
	readonly dryRun: boolean;
}

interface PartitionCandidate {
	readonly table: PartitionedCdrTable;
	readonly partition: string;
	readonly bytes: number;
}

/** What a partition held for one organization, counted before the drop. */
interface PartitionTally {
	readonly partition: string;
	readonly table: string;
	readonly rows: number;
}

interface DroppablePartitionRow {
	readonly partition_name: string;
	readonly bytes: string | number | null;
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here so the sweep works under either adapter, exactly as `retention.ts`
 * and the recording sweeper do for their own callers.
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
