import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { queueMembershipSchema } from "@optimiq-voice/events/schemas";
import { ensureKvBuckets, kvKeyFor, QUEUE_MEMBERSHIP_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import {
	eq,
	extension,
	inArray,
	queue,
	queueAgent,
	queueAgentSkill,
	queueDispositionCode,
	queueSkillRequirement,
	queueSurveyQuestion,
	queueTier,
} from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import {
	projectQueueMemberships,
	type QueueRosterDispositionCodeRow,
	type QueueRosterQueueRow,
	type QueueRosterSkillRequirementRow,
	type QueueRosterSurveyQuestionRow,
	type QueueRosterTierRow,
	type UnreachableSeat,
} from "./queue-membership.projection";
import type { PbxEnv } from "../shared/pbx-env";
import type { QueueMembership } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

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
 * Reading the tenant's roster tables unjoined and reconciling every key is one round trip more and
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
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-queue-membership",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [QUEUE_MEMBERSHIP_KV]);
			}
			this.bucket = await manager.jetstream().views.kv(QUEUE_MEMBERSHIP_KV.name);
			logger.info({ bucket: QUEUE_MEMBERSHIP_KV.name }, "queue-membership KV bucket ready");
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not open the queue-membership KV bucket");
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
			return { published: 0, deleted: 0, unchanged: 0, unreachable: [], failed: 0, skipped: true };
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
			return { published: 0, deleted: 0, unchanged: 0, unreachable: [], failed: 0, skipped: true };
		}

		const existing = await this.readOrganization(bucket, organizationId);
		const previousRevisions = new Map<string, number>();
		for (const [, entry] of existing) {
			if (entry !== undefined) {
				previousRevisions.set(entry.queueId, entry.revision ?? 0);
			}
		}

		const { memberships, unreachable } = projectQueueMemberships(
			organizationId,
			rows.queues,
			rows.tiers,
			{
				extensionDialTemplate: this.env.PBX_EXTENSION_DIAL_TEMPLATE,
				previousRevisions,
				dispositionCodes: rows.dispositionCodes,
				skillRequirements: rows.skillRequirements,
				surveyQuestions: rows.surveyQuestions,
			},
		);

		for (const seat of unreachable) {
			this.dropped += 1;
			logger.error(
				{ organizationId, ...seat },
				"an agent was left out of a queue roster because there is no way to dial them; the " +
					"engine would ring nothing and penalise them for not answering",
			);
		}

		let failed = 0;
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
				logger.error(
					{
						organizationId,
						queueId: membership.queueId,
						error,
					},
					"skipping a queue that has no queue-membership key",
				);
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
				failed += 1;
				logger.error({ key, organizationId, error }, "failed to write a queue-membership entry");
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
				failed += 1;
				logger.error({ key, organizationId, error }, "failed to delete a queue-membership entry");
			}
		}

		return { published, deleted, unchanged, unreachable, failed, skipped: false };
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
			logger.error({ organizationId, queueId, error }, "failed to read a queue-membership entry");
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
	): Promise<Map<string, QueueMembership | undefined>> {
		// `undefined` is a key that exists in the bucket but could not be parsed. Present so the
		// delete loop can reclaim it; never compared against as a roster.
		const found = new Map<string, QueueMembership | undefined>();
		let keys: string[];
		try {
			keys = await collect(await bucket.keys(`${organizationId}.*`));
		} catch (error) {
			logger.warn({ organizationId, error }, "could not list queue-membership keys");
			return found;
		}
		// In parallel: the reads are independent, and serially a tenant with 200 queues paid 200
		// round trips of latency per membership write before anything was published.
		const entries = await Promise.all(keys.map(async (key) => await readEntry(bucket, key)));
		for (const [index, entry] of entries.entries()) {
			const key = keys[index];
			if (key === undefined) {
				continue;
			}
			// An unreadable entry is treated as absent for the WRITE — the next write repairs it — but
			// it is still carried into `existing`, because a key nothing can parse whose queue has since
			// been deleted would otherwise never reach the delete loop and would leak forever. The key
			// is prefix-scoped to this organization, so ownership is not in doubt.
			if (entry === undefined || entry.orgId === organizationId) {
				found.set(key, entry);
			}
		}
		return found;
	}
}

/** The tables a roster is built from, read unjoined per `snapshot-loader.ts`'s rule. */
export interface QueueRosterRows {
	readonly queues: readonly QueueRosterQueueRow[];
	readonly tiers: readonly QueueRosterTierRow[];
	/** Enabled codes only — a retired one is history, not a button. */
	readonly dispositionCodes: readonly QueueRosterDispositionCodeRow[];
	readonly skillRequirements: readonly QueueRosterSkillRequirementRow[];
	/** Every question in the tenant; the projection narrows to the queues whose survey is on. */
	readonly surveyQuestions: readonly QueueRosterSurveyQuestionRow[];
}

/**
 * Reads the roster inputs for the tenant the transaction is scoped to.
 *
 * Unjoined selects and an in-memory join, following the loader convention: RLS is the filter,
 * so no query here carries an `organization_id` predicate, and the join stays in TypeScript where
 * it is testable without a database.
 */
export async function readRosterRows(
	transaction: PbxDatabaseTransaction,
): Promise<QueueRosterRows> {
	const [queues, tiers, dispositionCodes, skillRequirements, surveyQuestions] = await Promise.all([
		transaction.select().from(queue),
		transaction.select().from(queueTier),
		// The `enabled` predicate is in the query rather than in the projection because a disabled
		// code must not reach the roster at all: the console offers what it is given, and a retired
		// code that stayed in the list would keep being picked long after somebody retired it.
		transaction
			.select({
				queueId: queueDispositionCode.queueId,
				id: queueDispositionCode.id,
				code: queueDispositionCode.code,
				label: queueDispositionCode.label,
				position: queueDispositionCode.position,
			})
			.from(queueDispositionCode)
			.where(eq(queueDispositionCode.enabled, true)),
		transaction
			.select({
				queueId: queueSkillRequirement.queueId,
				skill: queueSkillRequirement.skill,
				minLevel: queueSkillRequirement.minLevel,
				relaxAfterSeconds: queueSkillRequirement.relaxAfterSeconds,
			})
			.from(queueSkillRequirement),
		transaction
			.select({
				queueId: queueSurveyQuestion.queueId,
				id: queueSurveyQuestion.id,
				position: queueSurveyQuestion.position,
				promptId: queueSurveyQuestion.promptId,
				label: queueSurveyQuestion.label,
			})
			.from(queueSurveyQuestion),
	]);

	// The two supporting reads are narrowed to what the tiers actually reference. Selecting every
	// `queue_agent` and every `extension` in the tenant transferred thousands of rows per tier edit
	// to build a lookup for a handful of seats — and this runs on every membership mutation,
	// including an agent login. The whole-org re-projection above is unchanged and deliberate; only
	// these two joins are narrowed.
	const agentIds = [...new Set(tiers.map((tier) => tier.queueAgentId))];
	const agents =
		agentIds.length === 0
			? []
			: await transaction.select().from(queueAgent).where(inArray(queueAgent.id, agentIds));

	const agentsById = new Map(agents.map((row) => [row.id, row]));

	// Narrowed to the seats the tiers reference, for the reason the agent read above is: this runs on
	// every membership mutation including an agent login, and a tenant's whole skill matrix is not
	// needed to project the handful of agents actually on a queue.
	const skillsByAgent = new Map<string, { skill: string; level: number }[]>();
	if (agentIds.length > 0) {
		const skillRows = await transaction
			.select({
				queueAgentId: queueAgentSkill.queueAgentId,
				skill: queueAgentSkill.skill,
				level: queueAgentSkill.level,
			})
			.from(queueAgentSkill)
			.where(inArray(queueAgentSkill.queueAgentId, agentIds));
		for (const row of skillRows) {
			const bucket = skillsByAgent.get(row.queueAgentId);
			if (bucket === undefined) {
				skillsByAgent.set(row.queueAgentId, [{ skill: row.skill, level: row.level }]);
			} else {
				bucket.push({ skill: row.skill, level: row.level });
			}
		}
		// Ordered once per agent here rather than once per TIER in the projection: an agent on four
		// queues would otherwise have the same list sorted four times, and the order is part of the
		// published value — an unrelated write must not reshuffle it.
		for (const bucket of skillsByAgent.values()) {
			bucket.sort((a, b) => a.skill.localeCompare(b.skill));
		}
	}
	const extensionIds = [
		...new Set(agents.flatMap((row) => (row.extensionId === null ? [] : [row.extensionId]))),
	];
	const extensions =
		extensionIds.length === 0
			? []
			: await transaction
					.select({ id: extension.id, number: extension.number })
					.from(extension)
					.where(inArray(extension.id, extensionIds));
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
			announcePromptId: tier.announcePromptId,
			wrapUpSeconds: agent.wrapUpSeconds,
			maxNoAnswer: agent.maxNoAnswer,
			noAnswerDelaySeconds: agent.noAnswerDelaySeconds,
			busyDelaySeconds: agent.busyDelaySeconds,
			rejectDelaySeconds: agent.rejectDelaySeconds,
			enabled: agent.enabled,
			skills: skillsByAgent.get(agent.id) ?? [],
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
			ronaEnabled: row.ronaEnabled,
			dispositionRequired: row.dispositionRequired,
			surveyEnabled: row.surveyEnabled,
			surveyIntroPromptId: row.surveyIntroPromptId,
		})),
		tiers: joined,
		dispositionCodes,
		skillRequirements,
		surveyQuestions,
	};
}

export interface QueueMembershipSyncResult {
	readonly published: number;
	readonly deleted: number;
	readonly unchanged: number;
	readonly unreachable: readonly UnreachableSeat[];
	/**
	 * KV writes and deletes that threw. Non-zero means the reconcile is incomplete, so the caller
	 * must leave the outbox obligation owed and let the sweeper republish.
	 */
	readonly failed: number;
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
		logger.warn({ key }, "discarding an unreadable queue-membership entry");
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
