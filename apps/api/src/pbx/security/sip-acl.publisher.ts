import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
// Subpath imports for the same reason `did-index.publisher.ts` uses them: `apps/api`'s tooling
// tsconfig still relaxes `strictNullChecks` for its legacy files, and the package root's
// `validate.ts` needs it.
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { sipAclEntrySchema } from "@optimiq-voice/events/schemas";
import { ensureKvBuckets, kvKeyFor, SIP_ACL_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import { sipAclEntry } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { SipAclEntry, SipAclScope } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The `sip-acl` KV half of the NATS backbone: **is this source address allowed to send us a
 * packet at all?**
 *
 * ## The problem it exists to solve
 *
 * `plans/sipd-invite-design.md` §8 calls this the boundary that has to hold before the SIP edge
 * accepts its first stranger. `sip_acl_entry` already has the right shape — a native PostgreSQL
 * `cidr`, an `action`, a `priority` and a `scope` its own schema describes as "the anti-toll-fraud
 * boundary" — and it is organization-scoped, which is exactly the problem: **an arriving packet
 * carries a source address and nothing else, so the reader does not know the organization.** Same
 * problem as `did-index`, same answer — a derived, non-org-scoped read model.
 *
 * And the edge WATCHES it, compiling the entries into an in-process longest-prefix match, rather
 * than doing a KV get per INVITE. A get per INVITE is a broker round trip inside a SIP transaction
 * on the one code path whose rate an attacker chooses.
 *
 * ## Absence is REFUSAL, and that is what makes every failure here safe
 *
 * `sipAclEntrySchema` fixes the evaluation rule: lowest priority first, ties broken by the most
 * specific prefix, first match wins, and **an address matching nothing is REFUSED**. Every failure
 * mode below therefore resolves in the same direction — a carrier that stops being admitted, loudly,
 * now — rather than the direction a security boundary must never fail in, which is a network that
 * keeps being admitted after the rule that admitted it was deleted.
 *
 * That is also why the bucket's TTL is zero and why nothing but this class may remove an entry: an
 * expiring `allow` fails a legitimate carrier's calls while nobody changed anything, and an expiring
 * `deny` fails OPEN.
 *
 * ## Only the two scopes the EDGE guards are published
 *
 * `sip_acl_entry.scope` has four values and this bucket carries two: `registration` (a REGISTER
 * arriving at the edge) and `trunk` (an INVITE arriving at the edge). `provisioning` and `api` are
 * HTTP surfaces served inside `apps/api`, and `provisioning`'s reader already queries the table
 * directly and in-tenant (`provisioning/render/provision.repository.ts`'s `checkAllowlist`), so
 * neither loses anything by staying out of the broker.
 *
 * They are excluded rather than carried-and-filtered because of the KEY, which is the one place this
 * read model is lossier than the table it derives from. See below — every row published is a row
 * that can collide, and a row with no reader is a collision bought for nothing.
 *
 * ## The key cannot express what the table's unique index can, so collisions are REFUSED
 *
 * `kvKeyFor.sipAcl(network)` folds a CIDR into a single token — the network and nothing else,
 * because a network is all an arriving packet has. The table's uniqueness is
 * `(organization_id, scope, network)`. Two rows can therefore be perfectly legal and land on one KV
 * key:
 *
 * - **Across tenants.** Two organizations naming the same network. Nothing in the database forbids
 *   it and nothing here can arbitrate it — unlike `did-index`, whose global unique index on
 *   `phone_number.e164` is what makes its own conflict path a report of divergence rather than a
 *   real ambiguity.
 * - **Within one tenant.** The same network in the `registration` and `trunk` scopes. Restricting
 *   the published set to those two scopes is what keeps this to the pair an operator would actually
 *   have to think about, instead of also colliding with `provisioning` — which is the pair most
 *   likely to exist by accident, since the same office network is plausibly allowed to register
 *   phones and to fetch provisioning files.
 *
 * A collision is never resolved by picking one. Picking the `allow` would let one tenant's rule
 * admit another tenant's traffic; picking the `deny` would let one tenant's rule block another
 * tenant's carrier; picking by priority or by recency would make an access-control decision turn on
 * write order. So a contested key is **published as nothing and reported**, which under the "absence
 * is refusal" rule above is the one outcome that is safe in both directions and visible immediately.
 * The counter, the error log naming every contending row, and `scripts/rebuild-sip-acl.ts`'s
 * non-zero exit are how it reaches a human.
 *
 * **This is a contract gap, not a preference.** The key function cannot represent the table, and the
 * fix is in `packages/events` — a scope-qualified key. Until then this class fails closed and says
 * so.
 *
 * Note that `sip_acl_entry.trunk_id`, which landed with this bucket, is deliberately NOT that fix
 * and does not narrow the collision: the unique index stays `(organization_id, scope, network)`, so
 * one network still gets one rule and two rows can still only contend across the two edge scopes.
 * Widening the index to admit the same network under two trunks would MANUFACTURE contested keys
 * here rather than resolve them — the schema comment on the column records that as the reason it was
 * left alone.
 *
 * ## `trunkId` attributes a matched packet to a carrier
 *
 * `sipAclEntrySchema.trunkId` exists so a matched packet can be attributed to a carrier, which is
 * what puts a `trunkId` on the admission request and ultimately a trunk on the CDR.
 * `plans/sipd-invite-design.md` §8.2 left the storage shape open between a `trunk_acl` child table
 * and a column here; the column is what shipped, because it keeps ONE ACL evaluator — a second table
 * would have been a second set of precedence rules for the same decision.
 *
 * A null column stays ABSENT from the value rather than travelling as `null`, which the schema
 * documents as "admits without attributing" and which is what every row written before the column
 * existed still means.
 *
 * ## Published after the commit, and a failure is not fatal
 *
 * Identical reasoning to every other publisher here. `sip_acl_entry` is absent from
 * `ROUTING_TABLE_TO_ENTITY`, so `affectsRouting("sip_acl_entry")` is false, `onArtifactCompiled`
 * never fires and there is no compiled artifact to ride on — `security/sip-acl.resource.ts` states
 * that and its consequence in full. `onMutation` is the only seam available, which is exactly the
 * seam `queue-membership` hangs off and for the same reason.
 */
@Injectable()
export class SipAclPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;
	private written = 0;
	private removed = 0;
	private unchanged = 0;
	private conflicts = 0;
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
		readonly conflicts: number;
		readonly failed: number;
	} {
		return {
			written: this.written,
			removed: this.removed,
			unchanged: this.unchanged,
			conflicts: this.conflicts,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — the sip-acl KV bucket will not be maintained. The SIP edge has no " +
					"admission list without it, and an address matching nothing is refused, so every " +
					"unauthenticated carrier is rejected. That is the safe direction and it is still an " +
					"outage for anybody using an ip-auth trunk.",
			);
			return;
		}

		try {
			// Its own connection, for the reason `did-index.publisher.ts` gives.
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-sip-acl",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [SIP_ACL_KV]);
			}
			this.bucket = await manager.jetstream().views.kv(SIP_ACL_KV.name);
			logger.info({ bucket: SIP_ACL_KV.name }, "sip-acl KV bucket ready");
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not open the sip-acl KV bucket");
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

	/** Re-projects one organization's ACL entries and reconciles the bucket against them. */
	async syncOrganization(organizationId: string): Promise<SipAclSyncResult> {
		if (this.bucket === undefined) {
			return { published: 0, deleted: 0, unchanged: 0, conflicts: [], skipped: true };
		}
		const rows = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await readSipAclRows(transaction),
		);
		return await this.reconcile(organizationId, rows);
	}

	/**
	 * The reconcile itself, also used by `scripts/rebuild-sip-acl.ts`.
	 *
	 * Deletion needs the WHOLE key space, because "which networks did this organization used to
	 * allow?" is a question only the bucket can answer and the key carries no organization to range
	 * over. That is an O(n) scan of every ACL entry on the platform per admin write — the same trade
	 * `did-index` makes for the same reason, with the same ceiling and the same fix if it is ever
	 * reached (a per-organization reverse key).
	 *
	 * It is also the scan that finds the orphan an operator would otherwise never see: an entry whose
	 * organization has no rows left. A stale `allow` there is a network admitted by a rule nobody can
	 * find; a stale `deny` is a carrier silently blocked. Both are removed here when this organization
	 * owns them, and reported by the rebuild script when it is the tenant itself that is gone.
	 */
	async reconcile(organizationId: string, rows: readonly SipAclRow[]): Promise<SipAclSyncResult> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return { published: 0, deleted: 0, unchanged: 0, conflicts: [], skipped: true };
		}

		const conflicts: SipAclConflict[] = [];
		const wanted = new Map<string, SipAclEntry>();
		const contended = new Map<string, SipAclRow[]>();

		for (const row of rows) {
			if (!isEdgeSipAclScope(row.scope)) {
				continue;
			}
			let key: string;
			try {
				key = kvKeyFor.sipAcl(row.network);
			} catch (error) {
				// A stored network with no usable characters cannot be keyed and cannot be matched.
				// Logged rather than thrown: one unusable row must not stop the other rules publishing.
				this.failed += 1;
				logger.error(
					{ organizationId, network: row.network, error },
					"skipping a sip-acl entry that has no sip-acl key",
				);
				continue;
			}
			contended.set(key, [...(contended.get(key) ?? []), row]);
		}

		for (const [key, group] of contended) {
			const first = group[0];
			if (first === undefined) {
				continue;
			}
			if (group.length > 1) {
				// Two of this tenant's own rows on one key — the same network in both edge scopes. Not
				// resolved by picking one; see the class header. Absent means refused, which is the safe
				// direction, and the log names every contender so the fix is one edit.
				this.conflicts += 1;
				conflicts.push({
					key,
					network: first.network,
					heldBy: organizationId,
					reason: "duplicate-network",
					scopes: group.map((row) => row.scope),
				});
				logger.error(
					{
						key,
						organizationId,
						network: first.network,
						scopes: group.map((row) => row.scope),
					},
					"refusing to publish a sip-acl entry: this organization has more than one rule for " +
						"this network across the edge scopes and the KV key cannot tell them apart, so the " +
						"network is published as NOTHING and is therefore REFUSED — delete one of the rules",
				);
				continue;
			}
			wanted.set(key, projectSipAclEntry(organizationId, first));
		}

		let published = 0;
		let deleted = 0;
		let unchanged = 0;
		const mine = new Map<string, SipAclEntry>();

		for await (const key of await bucket.keys()) {
			const entry = await readEntry(bucket, key);
			if (entry === undefined) {
				continue;
			}
			if (entry.orgId === organizationId) {
				mine.set(key, entry);
				continue;
			}
			if (!wanted.has(key)) {
				continue;
			}
			// Another tenant already holds this network. Never overwritten and never deleted — it is not
			// ours — so OUR rule is the one that goes unpublished, and under "absence is refusal" that
			// refuses our own traffic rather than admitting somebody else's. Reported so a human picks.
			this.conflicts += 1;
			conflicts.push({
				key,
				network: entry.network,
				heldBy: entry.orgId,
				reason: "cross-tenant",
				scopes: [],
			});
			logger.error(
				{ key, claimedBy: organizationId, heldBy: entry.orgId, network: entry.network },
				"refusing to move a sip-acl entry to another organization; the sip-acl KV key is the " +
					"network alone and two tenants have claimed it, so this organization's rule is NOT " +
					"published and its traffic on that network is refused — run scripts/rebuild-sip-acl.ts",
			);
			wanted.delete(key);
		}

		for (const [key, entry] of wanted) {
			if (isSameAclEntry(mine.get(key), entry)) {
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
				logger.error({ key, organizationId, error }, "failed to write a sip-acl entry");
			}
		}

		for (const key of mine.keys()) {
			if (wanted.has(key)) {
				continue;
			}
			try {
				await bucket.delete(key);
				this.removed += 1;
				deleted += 1;
			} catch (error) {
				this.failed += 1;
				logger.error({ key, organizationId, error }, "failed to delete a sip-acl entry");
			}
		}

		return { published, deleted, unchanged, conflicts, skipped: false };
	}

	/** One network's published rule. Used by verification and by the rebuild script's report. */
	async lookup(network: string): Promise<SipAclEntry | undefined> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			return await readEntry(bucket, kvKeyFor.sipAcl(network));
		} catch (error) {
			logger.error({ network, error }, "failed to read a sip-acl entry");
			return undefined;
		}
	}

	/** Every entry in the bucket, for the rebuild script's report and for verification. */
	async entries(): Promise<readonly SipAclEntry[]> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return [];
		}
		const all: SipAclEntry[] = [];
		for await (const key of await bucket.keys()) {
			const entry = await readEntry(bucket, key);
			if (entry !== undefined) {
				all.push(entry);
			}
		}
		return all;
	}
}

/**
 * The scopes the SIP EDGE guards, and therefore the only ones published.
 *
 * `provisioning` and `api` are HTTP surfaces inside `apps/api` with their own in-tenant readers. See
 * the class header for why carrying them anyway would be a key collision bought for nothing.
 */
export const EDGE_SIP_ACL_SCOPES: readonly SipAclScope[] = ["registration", "trunk"];

export function isEdgeSipAclScope(scope: string): scope is SipAclScope {
	return (EDGE_SIP_ACL_SCOPES as readonly string[]).includes(scope);
}

/** The `sip_acl_entry` columns the read model is built from. Explicit, per the trunk directory. */
export interface SipAclRow {
	readonly network: string;
	readonly action: "allow" | "deny";
	readonly scope: SipAclScope;
	readonly priority: number;
	readonly trunkId: string | null;
	readonly name: string | null;
	readonly enabled: boolean;
	readonly updatedAt: Date;
}

/**
 * Reads the ACL inputs for the tenant the transaction is scoped to.
 *
 * No `organization_id` predicate: RLS is the filter, per the loader convention. `description` is
 * deliberately not selected — it is an operator's prose and has no place on a broker four services
 * can read; `name` is carried instead so a refusal log can name the rule a human wrote.
 */
export async function readSipAclRows(
	transaction: PbxDatabaseTransaction,
): Promise<readonly SipAclRow[]> {
	return await transaction
		.select({
			network: sipAclEntry.network,
			action: sipAclEntry.action,
			scope: sipAclEntry.scope,
			priority: sipAclEntry.priority,
			trunkId: sipAclEntry.trunkId,
			name: sipAclEntry.name,
			enabled: sipAclEntry.enabled,
			updatedAt: sipAclEntry.updatedAt,
		})
		.from(sipAclEntry);
}

/**
 * One row, as the edge reads it.
 *
 * A disabled entry is PROJECTED, not dropped, for the reason `sipAclEntrySchema` gives: "a disabled
 * entry stays in the bucket and does not match; removal is a DELETE". It also matters more here than
 * it does for a trunk — a disabled `deny` that vanished from the bucket would be indistinguishable
 * from a `deny` that was never written, and the difference between those two is the difference
 * between "an operator turned this rule off" and "a publish was lost".
 *
 * The nullable columns become ABSENT rather than `null`, per the trunk directory: the schema's
 * optionals are `.optional()` and not `.nullable()`, so a `null` would fail the parse on the way back
 * in. For `trunkId` that absence is also the meaning — "admits without attributing" — which is what
 * makes an entry written before the column existed and one deliberately left unbound the same wire
 * fact, correctly, rather than two the edge would have to tell apart.
 */
export function projectSipAclEntry(organizationId: string, row: SipAclRow): SipAclEntry {
	return {
		network: row.network,
		orgId: organizationId,
		action: row.action,
		scope: row.scope,
		priority: row.priority,
		...(row.trunkId === null ? {} : { trunkId: row.trunkId }),
		...(row.name === null ? {} : { name: row.name }),
		enabled: row.enabled,
		updatedAt: row.updatedAt.getTime(),
	};
}

/** Why one network could not be published. Both reasons are refusals, never silent resolutions. */
export interface SipAclConflict {
	readonly key: string;
	readonly network: string;
	/** The organization whose rows contend, or the one the bucket says already holds the key. */
	readonly heldBy: string;
	readonly reason: "cross-tenant" | "duplicate-network";
	/** The contending scopes, for `duplicate-network`. Empty for the cross-tenant case. */
	readonly scopes: readonly string[];
}

export interface SipAclSyncResult {
	readonly published: number;
	readonly deleted: number;
	readonly unchanged: number;
	readonly conflicts: readonly SipAclConflict[];
	/** True when there is no broker and nothing was attempted. */
	readonly skipped: boolean;
}

/** Everything a reader acts on, compared. `updatedAt` is excluded, per the trunk directory. */
function isSameAclEntry(previous: SipAclEntry | undefined, next: SipAclEntry): boolean {
	if (previous === undefined) {
		return false;
	}
	return (
		JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 })
	);
}

async function readEntry(bucket: KV, key: string): Promise<SipAclEntry | undefined> {
	const value = await bucket.get(key);
	if (value === null || value.value.length === 0) {
		return undefined;
	}
	try {
		return sipAclEntrySchema.parse(
			JSON.parse(new TextDecoder().decode(value.value)),
		) as SipAclEntry;
	} catch {
		// Treated as absent so a rewrite repairs it. Absent is refusal, so an unreadable rule cannot
		// admit anything in the meantime — which is why this is a warn and not an alarm.
		logger.warn({ key }, "discarding an unreadable sip-acl entry");
		return undefined;
	}
}

/**
 * The tables whose mutation changes the ACL — re-exported, not declared here, for the reason
 * `queue-membership.publisher.ts` records: the repository consults the same list inside the write
 * transaction and must not import `nats` to do it.
 */
export { affectsSipAcl, SIP_ACL_TABLES } from "../shared/projection-outbox";
