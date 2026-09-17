/**
 * Rebuilds the `sip-acl` KV bucket from `sip_acl_entry`.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *   NATS_URL=nats://localhost:4222 \
 *     pnpm --filter @optimiq-voice/api rebuild:sip-acl
 *
 * Not to be confused with `scripts/generate-sip-acl.ts`, which renders the media server's static
 * `acl.conf` from the same table. That one feeds Asterisk and needs a transport rebuild; this one
 * feeds the SIP edge and lands in milliseconds. Same rows, two readers, two delivery mechanisms.
 *
 * ## When this is the answer
 *
 * The bucket is a DERIVED read model (see `src/pbx/security/sip-acl.publisher.ts`), maintained after
 * every write to `sip_acl_entry`. Three things break that, and this is the repair for all three:
 *
 * 1. **The API died between the commit and the publish.** The rule is in the database and not in the
 *    bucket. Under the bucket's "an address matching nothing is REFUSED" rule that means a carrier
 *    an operator just allowed is still being refused — the safe direction, and still an outage.
 * 2. **The broker lost the bucket** — a fresh cluster, a restored snapshot, a `nats kv del`. Then
 *    every ip-auth trunk on the platform is refused at once.
 * 3. **An ORPHAN** — an entry whose organization has no ACL rows left, typically a deleted tenant.
 *    This is the failure the bucket's zero TTL guarantees will never heal on its own, and it cuts
 *    both ways: an orphaned `deny` is a carrier silently blocked with no rule anybody can find to
 *    explain it, and an orphaned `allow` is a network still being admitted by a rule that no longer
 *    exists — which is a toll-fraud boundary that has quietly stopped holding.
 *
 * ## What it does, and what it deliberately does not
 *
 * It reads every `sip_acl_entry` row of every organization as the OWNER principal (the tenant role
 * cannot see across tenants and this key space is platform-wide), keeps the two scopes the SIP EDGE
 * guards — `registration` and `trunk`, per the publisher's header — writes one entry per network,
 * and removes entries no row backs any more.
 *
 * It writes DISABLED rows too. `sipAclEntrySchema` says a disabled entry stays in the bucket and
 * does not match; dropping it here would make "an operator turned this rule off" and "a publish was
 * lost" the same wire fact.
 *
 * It also repairs the key change: `kvKeyFor.sipAcl` used to key on the folded network alone, so two
 * tenants naming one CIDR contested a single entry. The key now carries the organization and the
 * scope, and an entry left behind under an old-shape key has no row backing it and is removed by the
 * same pass that removes any other.
 *
 * `--dry-run` prints the plan and writes nothing. `--prune-orphans` removes entries whose
 * organization has no ACL rows left.
 *
 * ## Exit code
 *
 * Non-zero when anything was orphaned-and-left or unkeyable. Every one of those is a
 * network whose admission decision is not the one the database describes, and a deploy pipeline must
 * not treat that as a success on a boundary whose whole job is toll fraud.
 */

import { connect, type KV, type NatsConnection } from "nats";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { ensureKvBuckets, kvKeyFor, SIP_ACL_KV } from "@optimiq-voice/events/streams";
import { createPbxDatabaseClient, sql } from "@optimiq-voice/pbx-db";

interface SipAclEntryRow {
	readonly organization_id: string;
	readonly network: string;
	readonly action: "allow" | "deny";
	readonly scope: string;
	readonly priority: number;
	readonly trunk_id: string | null;
	readonly name: string | null;
	readonly enabled: boolean;
	readonly updated_at: Date | string;
}

interface StoredEntry {
	readonly network: string;
	readonly orgId: string;
	readonly action: string;
	readonly scope: string;
	readonly priority: number;
	readonly trunkId?: string;
	readonly name?: string;
	readonly enabled: boolean;
	readonly updatedAt: number;
}

const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const DEFAULT_NATS_URL = "nats://localhost:4222";

const dryRun = process.argv.includes("--dry-run");
const pruneOrphans = process.argv.includes("--prune-orphans");

function log(message: string, detail?: Record<string, unknown>): void {
	console.log(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

/**
 * Every ACL entry on the platform, read as the owner principal.
 *
 * `withTenantScope` is deliberately NOT used: it sets `role pbx_tenant_tls` and one organization id,
 * which is exactly the isolation this read has to see past — the key space spans tenants, so the
 * read that builds it must too. `description` is not selected, on the publisher's rule: it is an
 * operator's prose and has no place on a broker four services can open.
 *
 * `network::text` because the column is a native `cidr` and the driver would otherwise hand back
 * whatever it maps that type to; the KV key is derived from the text form through `kvKeyFor.sipAcl`,
 * the same function the SIP edge reads with.
 */
async function readAllAclEntries(
	database: ReturnType<typeof createPbxDatabaseClient>,
): Promise<readonly SipAclEntryRow[]> {
	const rows = await database.adminDb.execute(
		sql`select "organization_id", "network"::text as "network", "action", "scope", "priority",
		           "trunk_id", "name", "enabled", "updated_at"
		    from "sip_acl_entry"
		    order by "organization_id", "network"`,
	);
	return (
		Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
	) as SipAclEntryRow[];
}

async function readEntry(bucket: KV, key: string): Promise<StoredEntry | undefined> {
	const value = await bucket.get(key);
	if (value === null || value.value.length === 0) {
		return undefined;
	}
	try {
		return JSON.parse(new TextDecoder().decode(value.value)) as StoredEntry;
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const natsUrl = process.env.NATS_URL ?? DEFAULT_NATS_URL;

	log("rebuilding the sip-acl bucket", {
		database: pbxDatabaseUrl.replace(/\/\/[^@]*@/u, "//***@"),
		nats: natsUrl,
		dryRun,
		pruneOrphans,
	});

	// Imported dynamically for the reason `rebuild-queue-membership.ts` does it: the publisher module
	// pulls in `nats` and the Nest decorators, and this script wants its own connection.
	const { isEdgeSipAclScope } = await import("../src/pbx/security/sip-acl.publisher");

	const database = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "rebuild-sip-acl",
		poolMaxConnectionsOverride: 2,
	});

	let connection: NatsConnection | undefined;
	let failures = 0;

	try {
		const all = await readAllAclEntries(database);
		const rows = all.filter((row) => isEdgeSipAclScope(row.scope));
		log(`read ${String(all.length)} acl entries, ${String(rows.length)} in an edge scope`, {
			skippedScopes: all.length - rows.length,
		});

		const byKey = new Map<string, SipAclEntryRow>();
		for (const row of rows) {
			let key: string;
			try {
				key = kvKeyFor.sipAcl(row.organization_id, row.scope, row.network);
			} catch {
				failures += 1;
				log("SKIP: a network with no usable characters cannot be keyed", {
					organizationId: row.organization_id,
					network: row.network,
				});
				continue;
			}
			// The key is `(organization_id, scope, network)`, which is the table's unique index, so no
			// two rows can land here. It was not always: the key was the folded network alone, and this
			// script's contest report existed for the rows that collided on it.
			byKey.set(key, row);
		}

		connection = await connect({
			servers: natsUrl,
			...natsCredentials(process.env),
			name: "rebuild-sip-acl",
		});
		const manager = await connection.jetstreamManager();
		await ensureKvBuckets(manager, [SIP_ACL_KV]);
		const bucket = await manager.jetstream().views.kv(SIP_ACL_KV.name);

		const desired = new Map<string, StoredEntry>();
		for (const [key, row] of byKey) {
			desired.set(key, {
				network: row.network,
				orgId: row.organization_id,
				action: row.action,
				scope: row.scope,
				priority: row.priority,
				// Null stays ABSENT rather than travelling as `null`: the schema's optionals are
				// `.optional()` and not `.nullable()`, and for `trunkId` the absence is also the meaning
				// — the entry admits without attributing a carrier.
				...(row.trunk_id === null ? {} : { trunkId: row.trunk_id }),
				...(row.name === null ? {} : { name: row.name }),
				enabled: row.enabled,
				updatedAt: new Date(row.updated_at).getTime(),
			});
		}

		let written = 0;
		let unchanged = 0;
		for (const [key, entry] of desired) {
			const existing = await readEntry(bucket, key);
			if (
				existing !== undefined &&
				existing.orgId === entry.orgId &&
				existing.network === entry.network &&
				existing.action === entry.action &&
				existing.scope === entry.scope &&
				existing.priority === entry.priority &&
				existing.trunkId === entry.trunkId &&
				existing.name === entry.name &&
				existing.enabled === entry.enabled
			) {
				unchanged += 1;
				continue;
			}
			if (existing !== undefined && existing.orgId !== entry.orgId) {
				log("REASSIGN: the bucket had this network under another organization", {
					key,
					was: existing.orgId,
					now: entry.orgId,
				});
			}
			if (!dryRun) {
				await bucket.put(key, new TextEncoder().encode(JSON.stringify(entry)));
			}
			written += 1;
		}

		const liveOrganizations = new Set(rows.map((row) => row.organization_id));
		let removed = 0;
		let orphans = 0;
		for await (const key of await bucket.keys()) {
			if (desired.has(key)) {
				continue;
			}
			const existing = await readEntry(bucket, key);
			if (existing === undefined) {
				// An unreadable entry is always removed: it can admit nothing (the edge cannot parse it)
				// and leaving it in place keeps the bucket in a state no reader can act on.
				if (!dryRun) {
					await bucket.delete(key);
				}
				removed += 1;
				continue;
			}
			if (!liveOrganizations.has(existing.orgId)) {
				orphans += 1;
				if (!pruneOrphans) {
					failures += 1;
					log(
						existing.action === "allow"
							? "ORPHAN: an ALLOW for an organization with no acl rows — this network is still " +
									"being admitted by a rule that no longer exists; pass --prune-orphans to remove"
							: "ORPHAN: a DENY for an organization with no acl rows — this network is silently " +
									"blocked with no rule to explain it; pass --prune-orphans to remove",
						{ key, organizationId: existing.orgId, network: existing.network },
					);
					continue;
				}
				log("PRUNED an orphan", { key, organizationId: existing.orgId });
			}
			if (!dryRun) {
				await bucket.delete(key);
			}
			removed += 1;
		}

		log(dryRun ? "PLAN (nothing was written)" : "done", {
			written,
			unchanged,
			removed,
			orphans,
			failures,
		});
	} finally {
		await database.close();
		if (connection !== undefined && !connection.isClosed()) {
			await connection.drain();
		}
	}

	if (failures > 0) {
		// The rest of the bucket was rebuilt correctly and is usable, but this must not exit 0: every
		// counted failure is a network whose admission is not what the database says it should be.
		process.exitCode = 1;
	}
}

await main();
