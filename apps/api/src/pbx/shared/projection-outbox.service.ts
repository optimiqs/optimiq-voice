import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { QueueMembershipPublisher } from "../queues/queue-membership.publisher";
import { compileOnWrite } from "../routing/compile-on-write";
import { DidIndexPublisher } from "../routing/did-index.publisher";
import { RoutingCachePublisher } from "../routing/routing-cache.publisher";
import { PBX_DATABASE, PBX_ENV } from "./pbx.tokens";
import {
	dischargeRows,
	isDue,
	type PendingProjection,
	pruneDischarged,
	readPendingProjections,
	recordAttempt,
} from "./projection-outbox";
import type { PbxEnv } from "./pbx-env";
import type { ProjectionName } from "./projection-outbox";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The projection outbox's sweeper: the second half of the safety net, and the half that runs when
 * the first one did not.
 *
 * ## The ordering it depends on, stated once
 *
 * ```
 *  in the write transaction   INSERT the obligation                    (pbx.repository.ts)
 *  after the commit           publish to KV, then mark it discharged   (pbx.module.ts, fast path)
 *  every PBX_OUTBOX_SWEEP_INTERVAL_MS   publish whatever is still unmarked   (this file)
 * ```
 *
 * The fast path is not a duplicate of this and is not going away. It is what makes a change reach
 * the engine in milliseconds instead of in up to a sweep interval, and it handles every write on a
 * healthy system — which is why the sweeper's pending set is normally empty and its query is a
 * partial index over nothing. This class exists for exactly the cases the fast path structurally
 * cannot cover:
 *
 * - **the process died between the commit and the publish** (the window all three publishers name
 *   in their headers, and the one that "needs an outbox, not a retry loop" — a retry loop lives in
 *   the process that just died);
 * - **the broker was down when the write happened** and came back later;
 * - **the publish threw** and its `catch` logged it, which is all a fire-and-forget continuation
 *   can do on its own.
 *
 * ## Idempotence is what makes a redundant sweep free
 *
 * Every publish here is a whole-organization reconcile against the CURRENT database — a KV `put` of
 * the artifact, a DID reconcile, a roster re-projection. Running one that was not needed writes the
 * same bytes that are already there (`queue-membership` does not even do that: `isSameRoster`
 * short-circuits it). So the sweeper never has to prove a row was really unpublished; it only has
 * to never MISS one, which is what the in-transaction insert guarantees.
 *
 * ## Re-derive, never replay
 *
 * The sweeper computes what to publish from the database at sweep time rather than from anything
 * stored in the row. `packages/pbx-db`'s `outbox-schema.ts` argues it at length; the short version
 * is that a stored artifact is provably older than the database by the time anything replays it,
 * and pushing it would turn a stale cache into a wrong one.
 *
 * ## Not a queue consumer
 *
 * There is no `SELECT … FOR UPDATE SKIP LOCKED`, no lease column, no worker id. Two API replicas
 * sweeping at once will both publish the same organization and both mark the same rows, and the
 * outcome is one redundant `put` — because of the idempotence above. A lease would buy nothing and
 * would add a lock a crashed sweeper could hold. If this ever becomes a hot path, the fix is
 * partitioning by organization, not locking.
 */
@Injectable()
export class ProjectionOutboxSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private discharged = 0;
	private failed = 0;
	private pruned = 0;

	/**
	 * Every parameter names its token explicitly, including the three that are plain classes.
	 *
	 * The area runs under `tsx`/esbuild, which does not emit `design:paramtypes` — so Nest has no
	 * type metadata to resolve a bare class parameter from and injects `undefined`, which surfaces
	 * as a `TypeError` on first use rather than as a wiring error at boot. Every other constructor
	 * in this area spells its tokens out for the same reason.
	 */
	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(RoutingCachePublisher) private readonly routingCache: RoutingCachePublisher,
		@Inject(DidIndexPublisher) private readonly didIndex: DidIndexPublisher,
		@Inject(QueueMembershipPublisher) private readonly queueMembership: QueueMembershipPublisher,
	) {}

	get stats(): {
		readonly swept: number;
		readonly discharged: number;
		readonly failed: number;
		readonly pruned: number;
	} {
		return {
			swept: this.swept,
			discharged: this.discharged,
			failed: this.failed,
			pruned: this.pruned,
		};
	}

	onModuleInit(): void {
		if (this.env.NATS_URL === undefined) {
			// Nothing enqueues without a broker (`outboxEnabled` in `pbx.module.ts`), so a sweeper here
			// would poll an empty table forever. Silent rather than warned: the publishers already say
			// loudly, once each, that there is no broker.
			return;
		}
		if (this.env.PBX_OUTBOX_SWEEP_INTERVAL_MS === 0) {
			logger.warn(
				"PBX_OUTBOX_SWEEP_INTERVAL_MS is 0 — the projection outbox is recorded but never swept " +
					"by this process. A publish lost between the commit and the fast path stays lost " +
					"until another process sweeps or a rebuild:* script is run.",
			);
			return;
		}
		// `unref` so a pending timer cannot hold a process open that is otherwise finished — a
		// verification script that boots the module and exits must exit.
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.env.PBX_OUTBOX_SWEEP_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.env.PBX_OUTBOX_SWEEP_INTERVAL_MS,
				backoffBaseMs: this.env.PBX_OUTBOX_BACKOFF_BASE_MS,
				backoffCapMs: this.env.PBX_OUTBOX_BACKOFF_CAP_MS,
				stuckAttempts: this.env.PBX_OUTBOX_STUCK_ATTEMPTS,
			},
			"projection outbox sweeper started",
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
	 * One pass. Public so a verification harness can drive it deterministically instead of waiting
	 * out an interval — which is the only honest way to test a timer.
	 *
	 * Re-entrancy is refused rather than queued: a sweep that is still publishing when the next tick
	 * fires has more work than the interval allows, and starting a second one would double the load
	 * on a broker that is already the reason the first is slow.
	 */
	async sweep(): Promise<ProjectionSweepResult> {
		if (this.running || this.stopped) {
			return { attempted: 0, discharged: 0, failed: 0, deferred: 0, stuck: 0, pruned: 0 };
		}
		this.running = true;
		try {
			return await this.runOnce();
		} catch (error) {
			// A sweep that throws must not kill the interval. The next tick tries again.
			this.failed += 1;
			logger.error({ err: error }, "the projection outbox sweep failed");
			return { attempted: 0, discharged: 0, failed: 1, deferred: 0, stuck: 0, pruned: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOnce(): Promise<ProjectionSweepResult> {
		const now = new Date();
		const pending = await readPendingProjections(this.database.adminDb, SWEEP_BATCH);
		let attempted = 0;
		let discharged = 0;
		let failed = 0;
		let deferred = 0;
		let stuck = 0;

		for (const group of pending) {
			if (this.stopped) {
				break;
			}
			if (
				!isDue(group, now, this.env.PBX_OUTBOX_BACKOFF_BASE_MS, this.env.PBX_OUTBOX_BACKOFF_CAP_MS)
			) {
				deferred += 1;
				continue;
			}
			if (group.attempts >= this.env.PBX_OUTBOX_STUCK_ATTEMPTS) {
				stuck += 1;
				this.reportStuck(group, now);
			}
			if (!this.isPublisherReady(group.projection)) {
				// Not counted as an attempt. A broker that is not connected is not a failure of this
				// obligation, and letting it burn through the stuck threshold would turn "NATS is down"
				// into "every tenant's projection is stuck", which buries the one row that is genuinely
				// broken among hundreds that are merely waiting.
				deferred += 1;
				continue;
			}

			attempted += 1;
			// The rows this publish discharges were read BEFORE it started, so a row inserted by a
			// concurrent write DURING the publish is not among them and stays pending — see
			// `projection-outbox.ts` for why the error has to point that way.
			try {
				await this.publish(group.organizationId, group.projection);
				const marked = await dischargeRows(this.database.adminDb, group.ids);
				this.discharged += marked;
				discharged += marked;
				logger.info(
					{
						organizationId: group.organizationId,
						projection: group.projection,
						rows: marked,
						owed: group.ids.length,
						attempts: group.attempts,
						owedForMs: now.getTime() - group.oldestCreatedAt.getTime(),
					},
					"the projection outbox published a projection the fast path did not",
				);
			} catch (error) {
				failed += 1;
				this.failed += 1;
				await recordAttempt(
					this.database.adminDb,
					group.ids,
					error instanceof Error ? error.message : String(error),
				);
				logger.warn(
					{
						organizationId: group.organizationId,
						projection: group.projection,
						attempts: group.attempts + 1,
						error,
					},
					"a projection outbox publish failed and will be retried",
				);
			}
		}

		const pruned = await pruneDischarged(
			this.database.adminDb,
			new Date(now.getTime() - this.env.PBX_OUTBOX_RETENTION_HOURS * 3_600_000),
		);
		this.pruned += pruned;
		this.swept += 1;

		return { attempted, discharged, failed, deferred, stuck, pruned };
	}

	/**
	 * The loud half of "logs stuck rows loudly".
	 *
	 * At error, on every sweep, with the organization, the projection, how long it has been owed,
	 * the last error and the repair — because the only thing worse than a stuck projection is a
	 * stuck projection that was mentioned once at info level six hours ago. The repair is named
	 * explicitly since it differs per projection and an operator should not have to know which
	 * script rebuilds which bucket.
	 */
	private reportStuck(group: PendingProjection, now: Date): void {
		logger.error(
			{
				organizationId: group.organizationId,
				projection: group.projection,
				attempts: group.attempts,
				rows: group.ids.length,
				owedForMs: now.getTime() - group.oldestCreatedAt.getTime(),
				lastError: group.lastError,
			},
			`a ${group.projection} projection has failed ${group.attempts} times and is still owed; ` +
				`the engine is reading a stale ${group.projection} for this organization — ${REPAIR[group.projection]}`,
		);
	}

	private isPublisherReady(projection: ProjectionName): boolean {
		switch (projection) {
			case "routing-cache":
				return this.routingCache.isReady;
			case "did-index":
				return this.didIndex.isReady;
			case "queue-membership":
				return this.queueMembership.isReady;
		}
	}

	/**
	 * Re-derives and publishes one organization's projection.
	 *
	 * `routing-cache` and `did-index` both need a compiled artifact, and both get a FRESH one:
	 * `compileOnWrite` on a read-only tenant transaction is exactly what `RoutingService.compile`
	 * does, and reusing that path rather than a stored value is the "re-derive, never replay" rule
	 * in the header. The compile can fail — an organization whose configuration became unsound
	 * between the write and the sweep — and that failure is a real one: the throw is recorded on the
	 * row, so the next sweep backs off and the stuck report eventually names the tenant whose
	 * configuration nobody can compile.
	 */
	private async publish(organizationId: string, projection: ProjectionName): Promise<void> {
		if (projection === "queue-membership") {
			const result = await this.queueMembership.syncOrganization(organizationId);
			if (result.skipped) {
				throw new Error("the queue-membership bucket is not open");
			}
			return;
		}

		const compiled = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await compileOnWrite(transaction, organizationId),
		);

		if (projection === "routing-cache") {
			const published = await this.routingCache.publish(compiled.cacheKey, compiled.artifact);
			if (!published) {
				throw new Error("the routing-cache bucket refused the artifact");
			}
			return;
		}

		const result = await this.didIndex.syncOrganization(compiled.artifact);
		if (result.skipped) {
			throw new Error("the did-index bucket is not open");
		}
		if (result.conflicts.length > 0) {
			// A conflict is NOT a transient failure and must not be retried into the ground: it means
			// the bucket and the database's global unique index on `phone_number.e164` disagree, which
			// `did-index.publisher.ts` argues is a human decision. Surfacing it as a throw is still
			// right — the obligation genuinely was not met — and the stuck report is how it reaches an
			// operator with the tenant attached.
			throw new Error(
				`${result.conflicts.length} did-index entries are held by another organization; ` +
					"run scripts/rebuild-did-index.ts",
			);
		}
	}
}

/**
 * How many (organization, projection) groups one sweep touches.
 *
 * A bound rather than "everything", because the pathological case — a broker that has been down for
 * a day across a thousand tenants — must not turn one tick into a thousand serial publishes that
 * outlive the interval. The oldest are taken first, so a bounded sweep still drains a backlog in
 * order rather than starving anybody.
 */
const SWEEP_BATCH = 200;

/** Named per projection because an operator should not have to know which script rebuilds what. */
const REPAIR: Record<ProjectionName, string> = {
	"routing-cache": "POST /api/v1/routing/compile for this organization republishes it",
	"did-index": "run scripts/rebuild-did-index.ts",
	"queue-membership": "run scripts/rebuild-queue-membership.ts",
};

export interface ProjectionSweepResult {
	/** Groups a publish was attempted for. */
	readonly attempted: number;
	/** Outbox ROWS marked discharged — higher than `attempted` when a burst coalesced. */
	readonly discharged: number;
	readonly failed: number;
	/** Groups skipped this pass: backing off, or waiting for a broker that is not connected. */
	readonly deferred: number;
	/** Groups at or past `PBX_OUTBOX_STUCK_ATTEMPTS`, each of which was logged at error. */
	readonly stuck: number;
	readonly pruned: number;
}
