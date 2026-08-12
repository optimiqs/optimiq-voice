import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
// Subpath imports for the same reason `did-index.publisher.ts` uses them: `apps/api`'s tooling
// tsconfig still relaxes `strictNullChecks` for its legacy files, and the package root's
// `validate.ts` needs it.
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { trunkDirectoryEntrySchema } from "@optimiq-voice/events/schemas";
import { ensureKvBuckets, kvKeyFor, TRUNKS_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import { trunk } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { TrunkDirectoryEntry } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The `trunks` KV half of the NATS backbone: **how does the SIP edge actually dial this carrier?**
 *
 * ## The problem it exists to solve
 *
 * `apps/sipd` is Go, holds no `pbx-db` handle and must not grow one — a database on the INVITE path
 * is the thing this architecture spends its budget avoiding. Nor can the routing artifact carry the
 * answer: `plan-walker` substitutes a trunk's NAME into a dial template, and a name is not dialable.
 * The row holds `sipProxy`, `outboundProxy`, `authUser`, `sipSecretRef`, `transport` and
 * `registerExpiresSeconds`, and every one of those is needed to place one INVITE or to send one
 * REGISTER. `TRUNKS_KV`'s own header states the seam; this class is the writer on the control-plane
 * side of it.
 *
 * A missing entry is not a degraded call, it is no call: the edge has no proxy address to send the
 * INVITE to, so every outbound leg for that tenant fails until something republishes.
 *
 * ## It is `queue-membership`, one process further out
 *
 * Same shape as `queues/queue-membership.publisher.ts` — a derived projection of rows Postgres owns,
 * published AFTER the transaction commits, reconciled a whole organization at a time, with a failure
 * that degrades the runtime rather than the API, and a rebuild script as the repair. The key is
 * organization-scoped (`kvKeyFor.trunk`), so like the roster and unlike `did-index` there is no
 * conflict case: no two tenants can ever contend for one key, and the read-back tenant check is the
 * same defence at the other end.
 *
 * ## What is deliberately NOT in the value
 *
 * `trunkDirectoryEntrySchema` is the spec and it argues all three at length; repeated here only
 * because this is the file that would have to add them:
 *
 * - **The secret.** `sipSecretRef` is a HANDLE into the secret manager and the password it names
 *   never lands on the broker. Four services can open this bucket.
 * - **`codecPrefs`.** Advisory until the media plane can serve more than G.711 — `mediad` writes
 *   every offer — and carrying a preference the edge cannot act on invites the edge to act on it.
 * - **`status*`.** Reachability is a transition and travels as `trunk.evt.v1.….status.changed`.
 *   Which brings us to the writer that bypasses this publisher entirely.
 *
 * ## Why `TrunkStatusConsumer` gets NO hook, stated rather than omitted
 *
 * `trunks/trunk-status-consumer.service.ts` writes the `trunk` row directly through
 * `withTenantScope`, deliberately not through `TrunksService`, so it fires neither
 * `onArtifactCompiled` nor `onMutation` and this publisher never hears about it. That is correct,
 * and it is correct for a reason stronger than "it is out of reach":
 *
 * 1. **It writes exactly the four columns this value excludes** — `status`, `status_changed_at`,
 *    `status_reason`, `status_latency_ms`. The projection below reads none of them, so a status tick
 *    cannot change a directory entry's content. Hooking it would republish an identical value.
 * 2. **It would not even be identical, and that is worse.** Drizzle's `$onUpdateFn` on
 *    `auditTimestampColumns` moves `updated_at` on every one of those writes, so a hooked status tick
 *    would push a value whose only difference is a timestamp — waking every watching `sipd` instance,
 *    on every OPTIONS transition, on every trunk, forever. The consumer's own header says routing a
 *    carrier flap through the resource service "would turn a wobbly peer into compile load"; routing
 *    it through here would turn the same wobbly peer into watch load on the SIP edge, which is the
 *    process least able to afford it.
 * 3. **The failure it could theoretically repair, it does not repair.** The only thing a status tick
 *    could usefully fix is a directory entry lost between a commit and a publish — and that is what
 *    the projection outbox and `scripts/rebuild-trunks.ts` are for. Depending on a carrier happening
 *    to flap in order to heal a stale read model would be an accident dressed as a mechanism.
 *
 * The comparison in {@link TrunkDirectoryPublisher.reconcile} therefore ignores `updatedAt`
 * deliberately: even if some future path DOES route a status write through `onMutation`, a
 * timestamp-only difference is not a republish.
 */
@Injectable()
export class TrunkDirectoryPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;
	private written = 0;
	private removed = 0;
	private unchanged = 0;
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
		readonly failed: number;
	} {
		return {
			written: this.written,
			removed: this.removed,
			unchanged: this.unchanged,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — the trunks KV bucket will not be maintained. The SIP edge has no " +
					"carrier directory without it: it cannot REGISTER to a carrier and has no proxy address " +
					"to send an outbound INVITE to, so every outbound call fails at the edge.",
			);
			return;
		}

		try {
			// Its own connection, for the reason `did-index.publisher.ts` gives: these publishers have
			// different lifetimes under failure (this one is retried by a rebuild script while artifacts
			// publish normally) and sharing a field would couple their shutdown ordering.
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-trunk-directory",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [TRUNKS_KV]);
			}
			this.bucket = await manager.jetstream().views.kv(TRUNKS_KV.name);
			logger.info({ bucket: TRUNKS_KV.name }, "trunks KV bucket ready");
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not open the trunks KV bucket");
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
	 * Re-projects one organization's trunks and reconciles the bucket against them.
	 *
	 * Reads on its own tenant-scoped transaction rather than reusing the mutation's, because the
	 * mutation's is gone: this runs after the commit, on purpose. Publishing from inside the
	 * transaction would put a carrier address for a state that might roll back in front of live
	 * calls.
	 *
	 * The whole organization rather than the one row that changed, for the reason the roster gives:
	 * working out the affected set of a cascade would mean reading before the write and diffing, in a
	 * transaction this deliberately runs after. One extra round trip cannot miss a trunk.
	 */
	async syncOrganization(organizationId: string): Promise<TrunkDirectorySyncResult> {
		if (this.bucket === undefined) {
			return { published: 0, deleted: 0, unchanged: 0, skipped: true };
		}
		const rows = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await readTrunkDirectoryRows(transaction),
		);
		return await this.reconcile(organizationId, rows);
	}

	/**
	 * The reconcile itself, also used by `scripts/rebuild-trunks.ts`.
	 *
	 * `updatedAt` is excluded from the change comparison and still written when something else
	 * changed — see the header's third point about the status consumer. The consequence is that the
	 * stored `updatedAt` is "when this DIRECTORY ENTRY last changed", which is the more useful of the
	 * two readings and the only one a watcher can act on.
	 */
	async reconcile(
		organizationId: string,
		rows: readonly TrunkDirectoryRow[],
	): Promise<TrunkDirectorySyncResult> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return { published: 0, deleted: 0, unchanged: 0, skipped: true };
		}

		const existing = await this.readOrganization(bucket, organizationId);
		const wanted = new Map<string, TrunkDirectoryEntry>();
		let published = 0;
		let deleted = 0;
		let unchanged = 0;

		for (const row of rows) {
			let key: string;
			try {
				key = kvKeyFor.trunk(organizationId, row.id);
			} catch (error) {
				// An id that is not a subject token cannot be published and cannot be read back, so no
				// edge could ever act on it. Logged rather than thrown: one unusable row must not stop
				// the other trunks from being published.
				this.failed += 1;
				logger.error(
					{ organizationId, trunkId: row.id, error },
					"skipping a trunk that has no trunks key",
				);
				continue;
			}
			const entry = projectTrunkDirectoryEntry(organizationId, row);
			wanted.set(key, entry);

			if (isSameTrunkEntry(existing.get(key), entry)) {
				this.unchanged += 1;
				unchanged += 1;
				continue;
			}
			try {
				await bucket.put(key, new TextEncoder().encode(JSON.stringify(entry)));
				this.written += 1;
				published += 1;
			} catch (error) {
				// Logged and swallowed: the API must not report "your change was not saved" about a change
				// that was. The obligation stays in `pbx_projection_outbox` and the sweeper republishes.
				this.failed += 1;
				logger.error({ key, organizationId, error }, "failed to write a trunks entry");
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
				logger.error({ key, organizationId, error }, "failed to delete a trunks entry");
			}
		}

		return { published, deleted, unchanged, skipped: false };
	}

	/** One trunk's published entry. Used by verification and by the rebuild script's report. */
	async read(organizationId: string, trunkId: string): Promise<TrunkDirectoryEntry | undefined> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			return await readEntry(bucket, kvKeyFor.trunk(organizationId, trunkId));
		} catch (error) {
			logger.error({ organizationId, trunkId, error }, "failed to read a trunks entry");
			return undefined;
		}
	}

	/**
	 * Every entry this organization owns, keyed by KV key.
	 *
	 * Scoped by key PREFIX rather than by scanning the bucket and filtering on `orgId`, because the
	 * key is organization-first by construction — the property `did-index` and `sip-acl` do not have,
	 * and why both of those have to read every value on the platform to find their own.
	 */
	private async readOrganization(
		bucket: KV,
		organizationId: string,
	): Promise<Map<string, TrunkDirectoryEntry>> {
		const found = new Map<string, TrunkDirectoryEntry>();
		let keys: string[];
		try {
			keys = await collect(await bucket.keys(`${organizationId}.*`));
		} catch (error) {
			logger.warn({ organizationId, error }, "could not list trunks keys");
			return found;
		}
		for (const key of keys) {
			const entry = await readEntry(bucket, key);
			// An unreadable entry is treated as absent so the next write repairs it, rather than as a
			// carrier configuration to preserve — the alternative is a trunk pinned to a value the edge
			// cannot parse and therefore cannot dial.
			if (entry !== undefined && entry.orgId === organizationId) {
				found.set(key, entry);
			}
		}
		return found;
	}
}

/**
 * The `trunk` columns the directory is built from.
 *
 * Declared rather than inferred so the SELECT below is the exact list — which is what makes "the
 * secret is not in here" and "the status columns are not in here" properties of a type rather than
 * of a habit. Adding a column to `trunks-schema.ts` does not silently add it to the broker.
 */
export interface TrunkDirectoryRow {
	readonly id: string;
	readonly name: string;
	readonly kind: "register" | "ip-auth";
	readonly sipDomain: string;
	readonly sipProxy: string;
	readonly outboundProxy: string | null;
	readonly authUser: string | null;
	readonly sipSecretRef: string | null;
	readonly transport: "udp" | "tcp" | "tls";
	readonly registerExpiresSeconds: number;
	readonly maxChannels: number | null;
	readonly callerIdNumberOverride: string | null;
	readonly enabled: boolean;
	readonly updatedAt: Date;
}

/**
 * Reads the directory inputs for the tenant the transaction is scoped to.
 *
 * One select, no `organization_id` predicate: RLS is the filter, per the loader convention. The
 * column list is explicit for the reason {@link TrunkDirectoryRow} records.
 */
export async function readTrunkDirectoryRows(
	transaction: PbxDatabaseTransaction,
): Promise<readonly TrunkDirectoryRow[]> {
	return await transaction
		.select({
			id: trunk.id,
			name: trunk.name,
			kind: trunk.kind,
			sipDomain: trunk.sipDomain,
			sipProxy: trunk.sipProxy,
			outboundProxy: trunk.outboundProxy,
			authUser: trunk.authUser,
			sipSecretRef: trunk.sipSecretRef,
			transport: trunk.transport,
			registerExpiresSeconds: trunk.registerExpiresSeconds,
			maxChannels: trunk.maxChannels,
			callerIdNumberOverride: trunk.callerIdNumberOverride,
			enabled: trunk.enabled,
			updatedAt: trunk.updatedAt,
		})
		.from(trunk);
}

/**
 * One row, as the edge reads it.
 *
 * A disabled trunk is PROJECTED, not dropped: `trunkDirectoryEntrySchema` says "a disabled trunk
 * stays in the bucket and is not dialled; removal is a DELETE". Dropping it here would make
 * "disabled" and "deleted" the same wire fact, and the edge would have to guess which one tore a
 * registration down.
 *
 * The nullable columns become ABSENT rather than `null`, because the schema's optionals are
 * `.optional()` and not `.nullable()` — a `null` would fail the parse on the way back in.
 */
export function projectTrunkDirectoryEntry(
	organizationId: string,
	row: TrunkDirectoryRow,
): TrunkDirectoryEntry {
	return {
		trunkId: row.id,
		orgId: organizationId,
		name: row.name,
		kind: row.kind,
		sipDomain: row.sipDomain,
		sipProxy: row.sipProxy,
		...(row.outboundProxy === null ? {} : { outboundProxy: row.outboundProxy }),
		...(row.authUser === null ? {} : { authUser: row.authUser }),
		...(row.sipSecretRef === null ? {} : { secretRef: row.sipSecretRef }),
		transport: row.transport,
		registerExpiresSeconds: row.registerExpiresSeconds,
		...(row.maxChannels === null ? {} : { maxChannels: row.maxChannels }),
		...(row.callerIdNumberOverride === null
			? {}
			: { callerIdNumberOverride: row.callerIdNumberOverride }),
		enabled: row.enabled,
		updatedAt: row.updatedAt.getTime(),
	};
}

export interface TrunkDirectorySyncResult {
	readonly published: number;
	readonly deleted: number;
	readonly unchanged: number;
	/** True when there is no broker and nothing was attempted. */
	readonly skipped: boolean;
}

/**
 * Everything a reader acts on, compared. `updatedAt` deliberately is not — see the class header's
 * third point about `TrunkStatusConsumer`, whose writes move `updated_at` and nothing else this
 * value carries.
 */
function isSameTrunkEntry(
	previous: TrunkDirectoryEntry | undefined,
	next: TrunkDirectoryEntry,
): boolean {
	if (previous === undefined) {
		return false;
	}
	return (
		JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 })
	);
}

async function readEntry(bucket: KV, key: string): Promise<TrunkDirectoryEntry | undefined> {
	const value = await bucket.get(key);
	if (value === null || value.value.length === 0) {
		return undefined;
	}
	try {
		return trunkDirectoryEntrySchema.parse(
			JSON.parse(new TextDecoder().decode(value.value)),
		) as TrunkDirectoryEntry;
	} catch {
		logger.warn({ key }, "discarding an unreadable trunks entry");
		return undefined;
	}
}

async function collect(iterable: AsyncIterable<string> | Iterable<string>): Promise<string[]> {
	const all: string[] = [];
	for await (const value of iterable as AsyncIterable<string>) {
		all.push(value);
	}
	return all;
}

/**
 * The tables whose mutation changes the carrier directory — re-exported, not declared here.
 *
 * They live in `shared/projection-outbox.ts` for the reason `queue-membership.publisher.ts` records:
 * the repository has to consult the same list INSIDE the write transaction to decide what obligation
 * to enqueue, and this file imports `nats`, which would drag a broker client into every repository
 * spec. Two copies of the list would be a trunk whose entry is published but never owed, or owed but
 * never published.
 */
export { affectsTrunkDirectory, TRUNK_DIRECTORY_TABLES } from "../shared/projection-outbox";
