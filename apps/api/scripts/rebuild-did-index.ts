/**
 * Rebuilds the `did-index` KV bucket from `phone_number`.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *   NATS_URL=nats://localhost:4222 \
 *     pnpm --filter @optimiq-voice/api rebuild:did-index
 *
 * ## When this is the answer
 *
 * The bucket is a DERIVED read model of `phone_number.e164` (see `did-index.publisher.ts`), and
 * `apps/api` maintains it after every write that changes an organization's routing. Three things
 * break that, and all three are repaired here rather than by a retry loop:
 *
 * 1. **The API died between the commit and the publish.** The number is in the database and not in
 *    the bucket, and inbound calls to it are rejected with `INVALID_PROFILE`.
 * 2. **The broker lost the bucket** — a fresh cluster, a restored snapshot, a `nats kv del`.
 * 3. **A conflict was reported.** The publisher refuses to move a key to a second organization,
 *    because the database's global unique index says that cannot legitimately happen; this script
 *    is the deliberate, human-triggered resolution.
 *
 * ## What it does, and what it deliberately does not
 *
 * It reads every `phone_number` row of every organization, as the OWNER principal (the tenant role
 * cannot see across tenants and this is a platform-wide index), writes one entry per DID, and
 * removes entries for numbers no longer in the table. `--prune-orphans` extends that to entries
 * whose organization has no rows at all, which is the case a deleted tenant leaves behind.
 *
 * It does not compile anything. The routing artifact is a separate projection with its own repair
 * path (`POST /api/v1/routing/compile`), and a rebuild that silently recompiled fourteen tenants'
 * routing would be a much larger action than the one its name promises.
 *
 * `--dry-run` prints the plan and writes nothing. Run it first on anything you care about.
 */

import { connect, type KV, type NatsConnection } from "nats";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { DID_INDEX_KV, ensureKvBuckets, kvKeyFor } from "@optimiq-voice/events/streams";
import { createPbxDatabaseClient, sql } from "@optimiq-voice/pbx-db";

interface PhoneNumberRow {
	readonly organization_id: string;
	readonly id: string;
	readonly e164: string;
	readonly enabled: boolean;
}

interface StoredEntry {
	readonly organizationId: string;
	readonly phoneNumberId: string;
	readonly e164: string;
	readonly enabled: boolean;
}

const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const DEFAULT_NATS_URL = "nats://localhost:4222";

const dryRun = process.argv.includes("--dry-run");
const pruneOrphans = process.argv.includes("--prune-orphans");

function log(message: string, detail?: Record<string, unknown>): void {
	console.log(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

/**
 * Every DID on the platform, read as the owner principal.
 *
 * `withTenantScope` is deliberately NOT used: it sets `role pbx_tenant_tls` and an organization id,
 * which is exactly the isolation this script has to see past. The index spans tenants, so the read
 * that builds it must too — and it is a one-shot operator script, not a request path.
 */
async function readAllPhoneNumbers(
	database: ReturnType<typeof createPbxDatabaseClient>,
): Promise<readonly PhoneNumberRow[]> {
	const rows = await database.adminDb.execute(
		sql`select "organization_id", "id", "e164", "enabled" from "phone_number" order by "e164"`,
	);
	return (
		Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
	) as PhoneNumberRow[];
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

	log("rebuilding the did-index bucket", {
		database: pbxDatabaseUrl.replace(/\/\/[^@]*@/u, "//***@"),
		nats: natsUrl,
		dryRun,
		pruneOrphans,
	});

	const database = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "rebuild-did-index",
		poolMaxConnectionsOverride: 2,
	});

	let connection: NatsConnection | undefined;
	let failures = 0;

	try {
		const numbers = await readAllPhoneNumbers(database);
		log(`read ${String(numbers.length)} phone numbers`);

		// The database's own answer to "can two tenants claim one DID?". The global unique index makes
		// this impossible going forward; the check stays because a database that predates the index
		// can still be holding a pair, and silently writing one of them would pick a tenant at random.
		const byToken = new Map<string, PhoneNumberRow[]>();
		for (const row of numbers) {
			let token: string;
			try {
				token = kvKeyFor.didIndex(row.e164);
			} catch {
				failures += 1;
				log("SKIP: a phone number with no dialable digits cannot be indexed", {
					organizationId: row.organization_id,
					e164: row.e164,
				});
				continue;
			}
			byToken.set(token, [...(byToken.get(token) ?? []), row]);
		}

		const contested = [...byToken.entries()].filter(([, rows]) => {
			return new Set(rows.map((row) => row.organization_id)).size > 1;
		});
		for (const [token, rows] of contested) {
			failures += 1;
			log("CONFLICT: one DID is claimed by more than one organization; it is NOT being indexed", {
				token,
				organizations: [...new Set(rows.map((row) => row.organization_id))],
			});
		}

		connection = await connect({
			servers: natsUrl,
			...natsCredentials(process.env),
			name: "rebuild-did-index",
		});
		const manager = await connection.jetstreamManager();
		await ensureKvBuckets(manager, [DID_INDEX_KV]);
		const bucket = await manager.jetstream().views.kv(DID_INDEX_KV.name);

		const contestedTokens = new Set(contested.map(([token]) => token));
		const desired = new Map<string, StoredEntry>();
		for (const [token, rows] of byToken) {
			const row = rows[0];
			if (row === undefined || contestedTokens.has(token)) {
				continue;
			}
			desired.set(token, {
				organizationId: row.organization_id,
				phoneNumberId: row.id,
				e164: row.e164,
				enabled: row.enabled,
			});
		}

		let written = 0;
		let unchanged = 0;
		for (const [key, entry] of desired) {
			const existing = await readEntry(bucket, key);
			if (
				existing?.organizationId === entry.organizationId &&
				existing.phoneNumberId === entry.phoneNumberId &&
				existing.e164 === entry.e164 &&
				existing.enabled === entry.enabled
			) {
				unchanged += 1;
				continue;
			}
			if (existing !== undefined && existing.organizationId !== entry.organizationId) {
				log("REASSIGN: the bucket had this DID under another organization", {
					key,
					was: existing.organizationId,
					now: entry.organizationId,
				});
			}
			if (!dryRun) {
				await bucket.put(key, new TextEncoder().encode(JSON.stringify(entry)));
			}
			written += 1;
		}

		let removed = 0;
		for await (const key of await bucket.keys()) {
			if (desired.has(key)) {
				continue;
			}
			const existing = await readEntry(bucket, key);
			if (existing === undefined) {
				// An unreadable entry is always removed: it can route nothing, and leaving it in place
				// keeps the bucket in a state no reader can act on.
				if (!dryRun) {
					await bucket.delete(key);
				}
				removed += 1;
				continue;
			}
			if (contestedTokens.has(key)) {
				log("KEEPING a contested DID's existing entry; resolve the duplicate rows first", { key });
				continue;
			}
			if (
				!pruneOrphans &&
				!numbers.some((row) => row.organization_id === existing.organizationId)
			) {
				log("ORPHAN: no phone_number rows for this organization; pass --prune-orphans to remove", {
					key,
					organizationId: existing.organizationId,
				});
				continue;
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
			conflicts: contested.length,
			failures,
		});
	} finally {
		await database.close();
		if (connection !== undefined && !connection.isClosed()) {
			await connection.drain();
		}
	}

	if (failures > 0) {
		// A conflict is not a crash — the rest of the index was rebuilt correctly and is usable — but
		// it must not exit 0, or a deploy pipeline will treat a half-indexed platform as a success.
		process.exitCode = 1;
	}
}

await main();
