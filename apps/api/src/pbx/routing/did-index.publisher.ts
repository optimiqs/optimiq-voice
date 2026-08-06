import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
// Subpath imports for the same reason `routing-cache.publisher.ts` uses them: `apps/api`'s tooling
// tsconfig still relaxes `strictNullChecks` for its legacy files, and `validate.ts` needs it.
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { DID_INDEX_KV, ensureKvBuckets, kvKeyFor } from "@optimiq-voice/events/streams";
import { didIndexToken } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logger";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { RoutingArtifact } from "@optimiq-voice/routing";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The `did-index` KV half of the NATS backbone: **which tenant does this DID belong to?**
 *
 * ## The problem it exists to solve
 *
 * An inbound INVITE arrives from a carrier carrying a dialled number and nothing else. Everything
 * downstream of that moment — the routing artifact, the CDR, the recording's object key, the
 * `channels` KV entry, the events' subjects — is organization-scoped, so the very first thing the
 * engine has to do is decide whose call it is. Until this bucket existed it could not: it read
 * `OPTIMIQ_ORG_ID` off the channel and rejected the call with `INVALID_PROFILE` when the dialplan
 * had not been told, which is single-tenant by construction.
 *
 * ## The index is DERIVED, and the database is the authority
 *
 * `phone_number.e164` carries a PLATFORM-WIDE unique index (see `packages/pbx-db`'s
 * `numbers-schema.ts`), so "two organizations claim one DID" is refused by Postgres inside the write
 * transaction, atomically, before anything is published. That is what makes this bucket safe to
 * treat as a plain projection: for any key there is exactly one organization that can ever be
 * writing it, so a concurrent publish cannot interleave two tenants' values.
 *
 * This class therefore never resolves a conflict — it REPORTS one. A key already held by another
 * organization means the database's constraint and this bucket have diverged (a bucket restored
 * from an older snapshot, a manual `kv put`, a release that ran before the constraint existed), and
 * overwriting it would hide the divergence behind a call that started routing to a new tenant.
 * `scripts/rebuild-did-index.ts` is the repair, and it is deliberately a human decision.
 *
 * ## Published after the commit, and a failure is not fatal
 *
 * Identical reasoning to `routing-cache.publisher.ts`: publishing inside the transaction would put
 * an index entry for a state that might roll back in front of live calls.
 *
 * The residual window that ordering opens — the process dying between the commit and the publish,
 * leaving the DID in the database, absent from the bucket, and inbound calls to it rejected with
 * `INVALID_PROFILE` — is closed by `shared/projection-outbox.ts`, which is the outbox this header
 * used to say was needed. The obligation is written INSIDE the write transaction; this publish is
 * the fast path that discharges it in milliseconds; a sweeper republishes whatever the fast path
 * failed to mark. A publish failure here is therefore still logged and swallowed — the API must not
 * report "your change was not saved" about a change that was — but it is no longer forgotten.
 *
 * `scripts/rebuild-did-index.ts` remains, unchanged, for the failures an outbox cannot repair: a
 * bucket lost to a fresh cluster, a restored snapshot, a `nats kv del`. So does the conflict path
 * below, which is a divergence between the database's constraint and the bucket and is a human
 * decision by design — the sweeper reports it as stuck rather than resolving it.
 */
@Injectable()
export class DidIndexPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;
	private written = 0;
	private removed = 0;
	private conflicts = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	/** Whether a write now would actually reach the broker. */
	get isReady(): boolean {
		return this.bucket !== undefined && this.connection?.isClosed() === false;
	}

	get stats(): {
		readonly written: number;
		readonly removed: number;
		readonly conflicts: number;
		readonly failed: number;
	} {
		return {
			written: this.written,
			removed: this.removed,
			conflicts: this.conflicts,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — the did-index KV bucket will not be maintained. Inbound calls " +
					"cannot be attributed to a tenant without it; the engine falls back to " +
					"OPTIMIQ_ORG_ID / ENGINE_DEFAULT_ORGANIZATION_ID, which is single-tenant.",
			);
			return;
		}

		try {
			// A second connection rather than sharing the routing-cache publisher's: the two have
			// different lifetimes under failure (this one may be retried by a backfill script while
			// artifacts are publishing normally), and a shared private field would couple their
			// shutdown ordering for the sake of one TCP socket.
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsCredentials(this.env),
				name: "optimiq-api-did-index",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [DID_INDEX_KV]);
			}
			this.bucket = await manager.jetstream().views.kv(DID_INDEX_KV.name);
			logger.info("did-index KV bucket ready", { bucket: DID_INDEX_KV.name });
		} catch (error) {
			this.failed += 1;
			logger.error("could not open the did-index KV bucket", error);
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
	 * Reconciles one organization's entries against the DIDs its compiled artifact declares.
	 *
	 * The artifact is the input rather than a fresh query because it is already the committed truth
	 * of this write, computed inside the transaction: `inbound.didDefaults` is keyed by E.164 and
	 * carries the `phoneNumberId`, which is exactly the value this bucket holds. Re-reading the
	 * table here would open a second snapshot and could publish a state neither the caller nor the
	 * compiler saw.
	 *
	 * Returns what it did, so a verification harness can assert it without reading the bucket back.
	 */
	async syncOrganization(artifact: RoutingArtifact): Promise<DidIndexSyncResult> {
		const desired = didEntriesOf(artifact);
		return await this.reconcile(artifact.organizationId, desired);
	}

	/**
	 * The reconcile itself, also used by `scripts/rebuild-did-index.ts` with entries read straight
	 * from `phone_number`.
	 *
	 * Deletion needs the whole key space, because "which DIDs did this organization used to own?"
	 * is a question only the bucket can answer — the artifact describes the present. That is an O(n)
	 * scan over every DID on the platform per admin write, which is the right trade at this scale
	 * and the wrong one at a hundred thousand numbers; the fix then is a per-organization reverse
	 * key, and it is recorded as a follow-up rather than built now.
	 */
	async reconcile(
		organizationId: string,
		desired: readonly DidIndexEntry[],
	): Promise<DidIndexSyncResult> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return { published: 0, deleted: 0, conflicts: [], skipped: true };
		}

		const wanted = new Map<string, DidIndexEntry>();
		for (const entry of desired) {
			try {
				wanted.set(kvKeyFor.didIndex(entry.e164), entry);
			} catch (error) {
				// A stored "number" with no digits in it cannot be dialled and cannot be indexed.
				// Logged rather than thrown: one unusable row must not stop the other DIDs syncing.
				this.failed += 1;
				logger.error("skipping a phone number that has no did-index key", {
					organizationId,
					e164: entry.e164,
					error,
				});
			}
		}

		const conflicts: DidIndexConflict[] = [];
		let published = 0;
		let deleted = 0;

		for (const [key, entry] of wanted) {
			const existing = await this.readEntry(bucket, key);
			if (existing !== undefined && existing.organizationId !== organizationId) {
				this.conflicts += 1;
				conflicts.push({ key, e164: entry.e164, heldBy: existing.organizationId });
				logger.error(
					"refusing to move a did-index entry to another organization; the database's " +
						"global unique index on phone_number.e164 says this cannot happen, so the bucket " +
						"is out of date — run scripts/rebuild-did-index.ts",
					{ key, claimedBy: organizationId, heldBy: existing.organizationId },
				);
				continue;
			}
			if (
				existing !== undefined &&
				existing.phoneNumberId === entry.phoneNumberId &&
				existing.e164 === entry.e164 &&
				existing.enabled === entry.enabled
			) {
				continue;
			}
			try {
				await bucket.put(
					key,
					new TextEncoder().encode(
						JSON.stringify({ ...entry, organizationId } satisfies StoredDidIndexEntry),
					),
				);
				this.written += 1;
				published += 1;
			} catch (error) {
				this.failed += 1;
				logger.error("failed to write a did-index entry", { key, organizationId, error });
			}
		}

		for await (const key of await bucket.keys()) {
			if (wanted.has(key)) {
				continue;
			}
			const existing = await this.readEntry(bucket, key);
			if (existing === undefined || existing.organizationId !== organizationId) {
				continue;
			}
			try {
				await bucket.delete(key);
				this.removed += 1;
				deleted += 1;
			} catch (error) {
				this.failed += 1;
				logger.error("failed to delete a did-index entry", { key, organizationId, error });
			}
		}

		return { published, deleted, conflicts, skipped: false };
	}

	/** Reads one DID's owner. Used by the resolve responder's diagnostics and by verification. */
	async lookup(did: string): Promise<StoredDidIndexEntry | undefined> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			return await this.readEntry(bucket, kvKeyFor.didIndex(did));
		} catch (error) {
			logger.error("failed to read a did-index entry", { did, error });
			return undefined;
		}
	}

	/** Every entry in the bucket, for the rebuild script's report and for verification. */
	async entries(): Promise<readonly StoredDidIndexEntry[]> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return [];
		}
		const all: StoredDidIndexEntry[] = [];
		for await (const key of await bucket.keys()) {
			const entry = await this.readEntry(bucket, key);
			if (entry !== undefined) {
				all.push(entry);
			}
		}
		return all;
	}

	private async readEntry(bucket: KV, key: string): Promise<StoredDidIndexEntry | undefined> {
		const value = await bucket.get(key);
		if (value === null || value.value.length === 0) {
			return undefined;
		}
		try {
			return JSON.parse(new TextDecoder().decode(value.value)) as StoredDidIndexEntry;
		} catch {
			// An unreadable entry is treated as absent so a rewrite can repair it, rather than as a
			// conflict that would block the organization that legitimately owns the number.
			logger.warn("discarding an unreadable did-index entry", { key });
			return undefined;
		}
	}
}

/** One DID the index should hold, before the organization is stamped on it. */
export interface DidIndexEntry {
	readonly e164: string;
	readonly phoneNumberId: string;
	readonly enabled: boolean;
}

/** What is actually stored under the key. */
export interface StoredDidIndexEntry extends DidIndexEntry {
	readonly organizationId: string;
}

export interface DidIndexConflict {
	readonly key: string;
	readonly e164: string;
	/** The organization the bucket says already owns it. */
	readonly heldBy: string;
}

export interface DidIndexSyncResult {
	readonly published: number;
	readonly deleted: number;
	readonly conflicts: readonly DidIndexConflict[];
	/** True when there is no broker and nothing was attempted. */
	readonly skipped: boolean;
}

/**
 * The DIDs an artifact declares.
 *
 * `inbound.didDefaults` is the complete set: the compiler puts EVERY `phone_number` row in it,
 * including disabled ones, because a DID's default destination has to exist even when a rule
 * overrides it. `enabled` rides along so a future reader can tell "not ours" from "ours but turned
 * off" — the engine still attributes a call on a disabled number to the right tenant and then lets
 * that tenant's own routing reject it, which is what puts the rejection in the right CDR.
 */
export function didEntriesOf(artifact: RoutingArtifact): readonly DidIndexEntry[] {
	return Object.values(artifact.inbound.didDefaults).map((did) => ({
		e164: did.e164,
		phoneNumberId: did.phoneNumberId,
		enabled: did.enabled,
	}));
}

/** Re-exported so a caller can normalise without importing the contracts package directly. */
export { didIndexToken };
