import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
import { queueMembershipSchema } from "@optimiq-voice/events/schemas";
import { ensureKvBuckets, kvKeyFor, QUEUE_MEMBERSHIP_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logger";
import { extension, queue, queueAgent, queueTier } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import {
	projectQueueMemberships,
	type QueueRosterQueueRow,
	type QueueRosterTierRow,
	type UnreachableSeat,
} from "./queue-membership.projection";
import type { PbxEnv } from "../shared/pbx-env";
import type { QueueMembership } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The `queue-membership` KV half of the NATS backbone: **who answers this queue, and how is each of
 * them reached?**
 *
 * ## The problem it exists to solve
 *
 * `apps/engine` distributes a queued caller by reading one key out of this bucket. Until now
 * nothing wrote it: `QueueMembershipSource` in the engine says so in its header, and the engine's
 * integration suite seeds the bucket by hand with a comment naming this publisher as the change
 * that removes the seeding. A queue whose key is absent is one the engine refuses to distribute
 * against — every caller waits out `maxWaitNoAgentSeconds` and takes the timeout branch, which
 * looks exactly like a Monday morning with nobody logged in.
 *
 * ## It is `did-index`, one level up
 *
 * Same shape as `did-index.publisher.ts` and for the same reasons: a derived projection of rows
 * Postgres owns, published AFTER the transaction commits, with a failure that degrades the runtime
 * rather than the API, and a rebuild script as the repair. Three differences, each deliberate:
 *
 * **The whole organization is re-projected, not one queue.** `queue_tier.queue_agent_id` is
 * `on delete cascade`, so deleting ONE agent silently changes the roster of every queue they served
 * — and the delete statement does not say which. Working out the affected set would mean reading
 * the tiers before the write and diffing, in a transaction this publisher deliberately runs after.
 * Reading four unjoined tables for the tenant and reconciling every key is one round trip more and
 * cannot miss a queue. Same trade `did-index` makes with its full key scan, and the same ceiling:
 * at ten thousand queues per tenant this becomes a per-queue projection with a tier-level trigger.
 *
 * **There is no conflict case.** A `queue-membership` key is `<orgId>.<queueId>` — organization
 * scoped, unlike `did-index`'s bare DID — so no two tenants can ever contend for one key and there
 * is nothing to refuse. What `did-index` spends a conflict check on, this spends on the tenant
 * check when READING back (`parse` refuses an entry filed under another queue), which is the same
 * defence at the other end.
 *
 * **`queue_agent` and `queue_tier` do not recompile.** `packages/routing` says agent membership is
 * live state the engine reads at dial time, so `affectsRouting("queue_agent")` is false and the
 * `onArtifactCompiled` seam never fires for it. That is correct — logging an agent in must not
 * evict a tenant's routing artifact — and it is why this hangs off a separate `onMutation` seam
 * rather than riding on the compiled artifact the way the DID index does.
 */
@Injectable()
export class QueueMembershipPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;
	private written = 0;
	private removed = 0;
	private unchanged = 0;
	private dropped = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {}

	/** Whether a write now would actually reach the broker. */
	get isReady(): boolean {
		return this.bucket !== undefined && this.connection?.isClosed() === false;
	}

	get stats(): {
		readonly written: number;
		readonly removed: number;
		readonly unchanged: number;
		readonly dropped: number;
		readonly failed: number;
	} {
		return {
			written: this.written,
			removed: this.removed,
			unchanged: this.unchanged,
			dropped: this.dropped,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — the queue-membership KV bucket will not be maintained. Queues " +
					"will have no roster the engine can distribute against, so every queued caller waits " +
					"out maxWaitNoAgentSeconds and takes the timeout branch.",
			);
			return;
		}

		try {
			// Its own connection, for the reason `did-index.publisher.ts` gives: these publishers have
			// different lifetimes under failure (this one is retried by a rebuild script while
			// artifacts publish normally) and sharing a field would couple their shutdown ordering.
			this.connection = await connect({
				servers: this.env.NATS_URL,
				name: "optimiq-api-queue-membership",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [QUEUE_MEMBERSHIP_KV]);
			}
			this.bucket = await manager.jetstream().views.kv(QUEUE_MEMBERSHIP_KV.name);
			logger.info("queue-membership KV bucket ready", { bucket: QUEUE_MEMBERSHIP_KV.name });
		} catch (error) {
			this.failed += 1;
			logger.error("could not open the queue-membership KV bucket", error);
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.bucket = undefined;
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * Re-projects one organization's queues and reconciles the bucket against them.
	 *
	 * Reads on its own tenant-scoped transaction rather than reusing the mutation's, because the
	 * mutation's is gone: this runs after the commit, on purpose (see `compile-on-write.ts` for the
	 * full argument — publishing from inside the transaction would put a roster for a state that
	 * might roll back in front of live callers).
	 *
	 * The residual window that ordering opens — the process dying between the commit and this
	 * publish, leaving the tier in the database and the engine distributing against the previous
	 * roster — is closed by `shared/projection-outbox.ts`, which is the outbox this comment used to
	 * say was needed: the obligation is recorded INSIDE the write transaction, this publish is the
	 * fast path that discharges it, and a sweeper republishes whatever the fast path failed to mark.
	 * `scripts/rebuild-queue-membership.ts` remains for the failures an outbox cannot repair — a
	 * bucket lost to a fresh cluster, a restored snapshot, a seat that has since become reachable.
	 */
	async syncOrganization(organizationId: string): Promise<QueueMembershipSyncResult> {
		if (this.bucket === undefined) {
			return { published: 0, deleted: 0, unchanged: 0, unreachable: [], skipped: true };
		}
		const rows = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await readRosterRows(transaction),
		);
		return await this.reconcile(organizationId, rows);
	}

	/**
	 * The reconcile itself, also used by `scripts/rebuild-queue-membership.ts`.
	 *
	 * The previous revisions are read BEFORE the projection so the counter advances rather than
	 * restarting at 1 on every write. It is the engine's only handle on "was I distributing against
	 * an old roster?", so a counter that reset would answer that question wrongly rather than not at
	 * all.
	 */
	async reconcile(
		organizationId: string,
		rows: QueueRosterRows,
	): Promise<QueueMembershipSyncResult> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return { published: 0, deleted: 0, unchanged: 0, unreachable: [], skipped: true };
		}

		const existing = await this.readOrganization(bucket, organizationId);
		const previousRevisions = new Map<string, number>();
		for (const [, entry] of existing) {
			previousRevisions.set(entry.queueId, entry.revision ?? 0);
		}

		const { memberships, unreachable } = projectQueueMemberships(
			organizationId,
			rows.queues,
			rows.tiers,
			{
				extensionDialTemplate: this.env.PBX_EXTENSION_DIAL_TEMPLATE,
				previousRevisions,
			},
		);

		for (const seat of unreachable) {
			this.dropped += 1;
			logger.error(
				"an agent was left out of a queue roster because there is no way to dial them; the " +
					"engine would ring nothing and penalise them for not answering",
				{ organizationId, ...seat },
			);
		}

		let published = 0;
		let deleted = 0;
		let unchanged = 0;
		const wanted = new Map<string, QueueMembership>();

		for (const membership of memberships) {
			let key: string;
			try {
				key = kvKeyFor.queueMembership(organizationId, membership.queueId);
			} catch (error) {
				// An id that is not a subject token cannot be published and cannot be read back, so no
				// engine could ever act on it. Logged rather than thrown: one unusable row must not stop
				// the other queues from being published.
				this.failed += 1;
				logger.error("skipping a queue that has no queue-membership key", {
					organizationId,
					queueId: membership.queueId,
					error,
				});
				continue;
			}
			wanted.set(key, membership);

			// `revision` and `updatedAt` move on every projection, so they are excluded from the
			// comparison: including them would make every write a change and every admin edit a
			// broadcast to every engine watching the bucket.
			if (isSameRoster(existing.get(key), membership)) {
				this.unchanged += 1;
				unchanged += 1;
				continue;
			}
			try {
				await bucket.put(key, new TextEncoder().encode(JSON.stringify(membership)));
				this.written += 1;
				published += 1;
			} catch (error) {
				this.failed += 1;
				logger.error("failed to write a queue-membership entry", { key, organizationId, error });
			}
		}

		for (const key of existing.keys()) {
			if (wanted.has(key)) {
				continue;
			}
			try {
				await bucket.delete(key);
				this.removed += 1;
				deleted += 1;
			} catch (error) {
				this.failed += 1;
				logger.error("failed to delete a queue-membership entry", { key, organizationId, error });
			}
		}

		return { published, deleted, unchanged, unreachable, skipped: false };
	}

	/** One queue's published roster. Used by verification and by the rebuild script's report. */
	async read(organizationId: string, queueId: string): Promise<QueueMembership | undefined> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			return await readEntry(bucket, kvKeyFor.queueMembership(organizationId, queueId));
		} catch (error) {
			logger.error("failed to read a queue-membership entry", { organizationId, queueId, error });
			return undefined;
		}
	}

	/**
	 * Every entry this organization owns, keyed by KV key.
	 *
	 * Scoped by key PREFIX rather than by scanning the bucket and filtering on `orgId`, because the
	 * key is organization-first by construction (`kvKeyFor.queueMembership`) — which is exactly the
	 * property `did-index` does not have and why its reconcile has to read every value on the
	 * platform to find its own.
	 */
	private async readOrganization(
		bucket: KV,
		organizationId: string,
	): Promise<Map<string, QueueMembership>> {
		const found = new Map<string, QueueMembership>();
		let keys: string[];
		try {
			keys = await collect(await bucket.keys(`${organizationId}.*`));
		} catch (error) {
			logger.warn("could not list queue-membership keys", { organizationId, error });
			return found;
		}
		for (const key of keys) {
			const entry = await readEntry(bucket, key);
			// An unreadable entry is treated as absent so the next write repairs it, rather than as a
			// roster to preserve — the alternative is a queue pinned to a value nothing can parse.
			if (entry !== undefined && entry.orgId === organizationId) {
				found.set(key, entry);
			}
		}
		return found;
	}
}

/** The four tables a roster is built from, read unjoined per `snapshot-loader.ts`'s rule. */
export interface QueueRosterRows {
	readonly queues: readonly QueueRosterQueueRow[];
	readonly tiers: readonly QueueRosterTierRow[];
}

/**
 * Reads the roster inputs for the tenant the transaction is scoped to.
 *
 * Four unjoined selects and an in-memory join, following the loader convention: RLS is the filter,
 * so no query here carries an `organization_id` predicate, and the join stays in TypeScript where
 * it is testable without a database.
 */
export async function readRosterRows(
	transaction: PbxDatabaseTransaction,
): Promise<QueueRosterRows> {
	const [queues, agents, tiers, extensions] = await Promise.all([
		transaction.select().from(queue),
		transaction.select().from(queueAgent),
		transaction.select().from(queueTier),
		transaction.select().from(extension),
	]);

	const agentsById = new Map(agents.map((row) => [row.id, row]));
	const extensionNumbersById = new Map(extensions.map((row) => [row.id, row.number]));

	const joined: QueueRosterTierRow[] = [];
	for (const tier of tiers) {
		const agent = agentsById.get(tier.queueAgentId);
		if (agent === undefined) {
			// The foreign key makes this impossible inside one transaction; it is handled rather than
			// asserted because the alternative is a crash in a fire-and-forget publish.
			continue;
		}
		joined.push({
			queueId: tier.queueId,
			agentId: agent.id,
			agentName: agent.name,
			contactKind: agent.contactKind,
			contact: agent.contact,
			extensionId: agent.extensionId,
			extensionNumber:
				agent.extensionId === null ? null : (extensionNumbersById.get(agent.extensionId) ?? null),
			level: tier.level,
			position: tier.position,
			wrapUpSeconds: agent.wrapUpSeconds,
			maxNoAnswer: agent.maxNoAnswer,
			noAnswerDelaySeconds: agent.noAnswerDelaySeconds,
			busyDelaySeconds: agent.busyDelaySeconds,
			rejectDelaySeconds: agent.rejectDelaySeconds,
			enabled: agent.enabled,
		});
	}

	return {
		queues: queues.map((row) => ({
			id: row.id,
			name: row.name,
			wrapUpSeconds: row.wrapUpSeconds,
			tierRulesApply: row.tierRulesApply,
			tierRuleWaitSeconds: row.tierRuleWaitSeconds,
			tierRuleNoAgentNoWait: row.tierRuleNoAgentNoWait,
		})),
		tiers: joined,
	};
}

export interface QueueMembershipSyncResult {
	readonly published: number;
	readonly deleted: number;
	readonly unchanged: number;
	readonly unreachable: readonly UnreachableSeat[];
	/** True when there is no broker and nothing was attempted. */
	readonly skipped: boolean;
}

/**
 * The tables whose mutation changes a roster — re-exported, not declared here.
 *
 * They MOVED to `shared/projection-outbox.ts` when the outbox landed, because the repository has to
 * consult the same list INSIDE the write transaction to decide what obligation to record, and this
 * file imports `nats` — which would drag a broker client into every repository spec. The re-export
 * keeps `pbx.module.ts` and every other caller importing it from the publisher it belongs to, and
 * keeps the list itself in the one file both sides can reach. Two copies of it would be a queue
 * whose roster is published but never owed, or owed but never published.
 */
export { affectsQueueMembership, QUEUE_MEMBERSHIP_TABLES } from "../shared/projection-outbox";

async function readEntry(bucket: KV, key: string): Promise<QueueMembership | undefined> {
	const value = await bucket.get(key);
	if (value === null || value.value.length === 0) {
		return undefined;
	}
	try {
		return queueMembershipSchema.parse(JSON.parse(new TextDecoder().decode(value.value)));
	} catch {
		logger.warn("discarding an unreadable queue-membership entry", { key });
		return undefined;
	}
}

/** Everything a reader acts on, compared. `revision` and `updatedAt` deliberately are not. */
function isSameRoster(previous: QueueMembership | undefined, next: QueueMembership): boolean {
	if (previous === undefined) {
		return false;
	}
	return (
		JSON.stringify({ ...previous, revision: 0, updatedAt: "" }) ===
		JSON.stringify({ ...next, revision: 0, updatedAt: "" })
	);
}

async function collect(iterable: AsyncIterable<string> | Iterable<string>): Promise<string[]> {
	const all: string[] = [];
	for await (const value of iterable as AsyncIterable<string>) {
		all.push(value);
	}
	return all;
}
